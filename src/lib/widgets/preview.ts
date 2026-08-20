import "server-only";

import { z } from "zod";
import {
  minimumRatingSchema,
  reviewWidgetLayoutSchema,
  reviewWidgetSelectionModeSchema,
  reviewWidgetThemeSchema,
  uuidSchema,
  type Mention,
  type ReviewWidgetRenderRow,
} from "@/domain";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import {
  isWidgetEligibleReview,
  selectMostRecentEligible,
} from "@/lib/widgets/eligibility";

/**
 * Resolving a widget that has not been saved yet.
 *
 * The in-app preview has to show a theme somebody just clicked, against a
 * review they just picked, before either has reached the database. So it
 * cannot go through `reviewWidgets.render()` — there is nothing stored to
 * render — and it resolves the review here instead, from the scoped mention
 * repository, using the same `@/lib/widgets/eligibility` predicate the
 * configuration screen's picker uses.
 *
 * **What that costs, stated plainly.** On a Supabase deployment the public
 * embed resolves its review in SQL (`public.review_widget_render`) and this
 * path resolves it in TypeScript. Both are mirrors of the same rule list, but
 * they are two implementations, so a preview is a faithful rendering of the
 * *predicate* rather than a byte-for-byte replay of the public response. The
 * mitigation is that the two share everything below the selection — the same
 * `renderReviewWidgetDocument`, the same palettes, the same copy — so what can
 * differ is which review appears, not how it looks, and
 * `tests/review-widget-eligibility.test.ts` pins the rule list both sides
 * claim to implement.
 *
 * The alternative was previewing by framing the live public URL, which would
 * be exact and would also mean a customer could not see a theme change until
 * after they had published it. Showing somebody the result of a decision
 * before they commit to it is the whole job of a preview.
 */

export const previewRequestSchema = z.object({
  locationId: uuidSchema,
  theme: reviewWidgetThemeSchema,
  layout: reviewWidgetLayoutSchema.default("single_review_text"),
  selectionMode: reviewWidgetSelectionModeSchema,
  selectedMentionId: uuidSchema.nullable().default(null),
  minimumRating: minimumRatingSchema,
});

export type PreviewRequest = z.infer<typeof previewRequestSchema>;

/**
 * Read the preview's configuration off a URL.
 *
 * Its own function because the values arrive as strings from a query string
 * and every one of them has to be validated: this route is reachable by any
 * signed-in member of any organization, so "the widget configurator built this
 * URL" is not something the handler may assume.
 */
export function parsePreviewRequest(params: URLSearchParams): PreviewRequest {
  const rating = params.get("minimumRating");

  return previewRequestSchema.parse({
    locationId: params.get("locationId") ?? "",
    theme: params.get("theme") ?? "light",
    layout: params.get("layout") ?? "single_review_text",
    selectionMode: params.get("selectionMode") ?? "most_recent",
    selectedMentionId: params.get("selectedMentionId") || null,
    minimumRating: rating === null ? 4 : Number(rating),
  });
}

/** How many of the location's reviews the preview considers. */
const PREVIEW_SAMPLE = 60;

/**
 * The same row shape the public path produces, resolved under a session.
 *
 * Returning `ReviewWidgetRenderRow` rather than a preview-specific type is
 * what lets `resolveRenderedWidget` and `renderReviewWidgetDocument` be shared
 * verbatim: the preview cannot drift into showing an attribution line the
 * public page would not, or an unavailable state worded differently, because
 * neither decision is made here.
 */
export async function resolvePreviewRow(
  context: { dataSource: LiaDataSource; scope: OrganizationScope },
  request: PreviewRequest,
): Promise<ReviewWidgetRenderRow> {
  const mentions = await context.dataSource.mentions.list(context.scope, {
    locationId: request.locationId,
    sourceTypes: ["google_review"],
    limit: PREVIEW_SAMPLE,
  });

  const eligibility = {
    locationId: request.locationId,
    minimumRating: request.minimumRating,
  };

  const chosen: Mention | null =
    request.selectionMode === "specific"
      ? pinned(mentions, request.selectedMentionId, request.locationId)
      : selectMostRecentEligible(mentions, eligibility);

  const profileId = chosen?.platformProfileId ?? null;
  const profile =
    profileId === null
      ? null
      : ((await context.dataSource.platformProfiles.list(context.scope)).find(
          (row) => row.id === profileId,
        ) ?? null);

  return {
    theme: request.theme,
    layout: request.layout,
    // A preview is always drawn as though the widget were live. Previewing a
    // disabled widget as "switched off" would show the customer the one thing
    // they cannot learn anything from, at exactly the moment they are deciding
    // whether to switch it back on.
    status: "active",
    attributionSuppressed: false,
    // Empty rather than the widget's real list: the preview is framed from
    // Lia's own origin, and applying the customer's allowlist here would blank
    // the frame in the very screen where they are configuring it.
    allowedDomains: [],
    selectionMode: request.selectionMode,
    reviewRating: chosen?.rating ?? null,
    reviewText: chosen?.content ?? null,
    reviewAuthorName: chosen?.authorName ?? null,
    reviewPublishedAt: chosen?.publishedAt ?? null,
    profileUrl: profile?.profileUrl ?? null,
  };
}

/**
 * The pinned review, subject to every rule except the rating floor.
 *
 * The same exception `public.review_widget_render`'s `pinned` CTE and the demo
 * adapter both make, for the same reason: an explicit choice is not overridden
 * by a threshold meant for automatic selection.
 */
function pinned(
  mentions: readonly Mention[],
  selectedMentionId: string | null,
  locationId: string,
): Mention | null {
  if (selectedMentionId === null) return null;

  const mention = mentions.find((row) => row.id === selectedMentionId);
  if (!mention) return null;

  return isWidgetEligibleReview(mention, { locationId, minimumRating: 0 })
    ? mention
    : null;
}
