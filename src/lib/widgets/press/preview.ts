import "server-only";

import { z } from "zod";
import {
  pressWidgetItemLimitSchema,
  pressWidgetLayoutSchema,
  pressWidgetThemeSchema,
  uuidSchema,
  type PressWidgetRenderRow,
} from "@/domain";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import { selectPressStories } from "@/lib/widgets/press/eligibility";
import { excerptOf } from "@/lib/widgets/press/excerpt";

/**
 * Resolving a press widget that has not been saved yet.
 *
 * The in-app preview has to show a theme somebody just clicked, against the
 * query and the story count they just chose, before any of it has reached the
 * database. So it cannot go through `pressWidgets.render()` — there is nothing
 * stored to render — and it resolves the stories here instead, from the scoped
 * mention repository, using the same `@/lib/widgets/press/eligibility`
 * predicate the configuration screen's candidate list uses.
 *
 * **What that costs, stated plainly.** On a Supabase deployment the public
 * embed resolves its stories in SQL (`public.press_widget_render`) and this
 * path resolves them in TypeScript. Both are mirrors of the same rule list,
 * but they are two implementations, so a preview is a faithful rendering of
 * the *predicate* rather than a byte-for-byte replay of the public response.
 * The mitigation is that the two share everything below the selection — the
 * same `renderPressWidgetDocument`, the same palettes, the same logo registry,
 * the same copy — so what can differ is which stories appear, not how they
 * look, and `tests/press-widget-eligibility.test.ts` pins the rule list both
 * sides claim to implement.
 *
 * **This preview shows the customer's real coverage**, not the invented
 * sample. A preview built from fiction would answer the wrong question: the
 * person looking at it wants to know what *their* homepage will say. The
 * invented sample exists in exactly one place — the landing page — where it is
 * labelled as an example and where no tenant data has been read at all.
 */

export const pressPreviewRequestSchema = z.object({
  theme: pressWidgetThemeSchema,
  layout: pressWidgetLayoutSchema.default("recent_press_list"),
  monitoringQueryId: uuidSchema.nullable().default(null),
  itemLimit: pressWidgetItemLimitSchema,
});

export type PressPreviewRequest = z.infer<typeof pressPreviewRequestSchema>;

/**
 * Read the preview's configuration off a URL.
 *
 * Its own function because the values arrive as strings from a query string
 * and every one of them has to be validated: this route is reachable by any
 * signed-in member of any organization, so "the press configurator built this
 * URL" is not something the handler may assume.
 */
export function parsePressPreviewRequest(params: URLSearchParams): PressPreviewRequest {
  const limit = params.get("itemLimit");

  return pressPreviewRequestSchema.parse({
    theme: params.get("theme") ?? "light",
    layout: params.get("layout") ?? "recent_press_list",
    monitoringQueryId: params.get("monitoringQueryId") || null,
    itemLimit: limit === null ? 3 : Number(limit),
  });
}

/**
 * How many of the organization's articles the preview considers.
 *
 * The repository caps `limit` at 200. Taking the maximum matters more here
 * than it does for reviews: when the widget filters to one monitoring query,
 * the filtering happens in TypeScript after the fetch, so a query whose
 * coverage is older than 200 organization-wide articles would preview as empty
 * while the live widget showed it. Two hundred news articles is far beyond
 * anything the free news tier produces for one tenant, and the alternative —
 * widening `MentionFilter` further, or paging — buys nothing real.
 */
const PREVIEW_SAMPLE = 200;

/**
 * The same row shape the public path produces, resolved under a session.
 *
 * Returning `PressWidgetRenderRow` rather than a preview-specific type is what
 * lets `resolveRenderedPressWidget` and `renderPressWidgetDocument` be shared
 * verbatim: the preview cannot drift into showing an attribution line the
 * public page would not, or an unavailable state worded differently, because
 * neither decision is made here.
 */
export async function resolvePressPreviewRow(
  context: { dataSource: LiaDataSource; scope: OrganizationScope },
  request: PressPreviewRequest,
): Promise<PressWidgetRenderRow> {
  const [mentions, queries] = await Promise.all([
    context.dataSource.mentions.list(context.scope, {
      sourceTypes: ["news_article"],
      monitoringQueryId: request.monitoringQueryId ?? undefined,
      limit: PREVIEW_SAMPLE,
    }),
    request.monitoringQueryId === null
      ? Promise.resolve([])
      : context.dataSource.monitoringQueries.list(context.scope),
  ]);

  // A query that is not in this organization's list simply is not found, and
  // the predicate then refuses every story on `query_enabled`. That is the
  // right answer to a hand-crafted URL naming somebody else's query: an empty
  // preview, not an error that confirms the id exists.
  const selected =
    request.monitoringQueryId === null
      ? null
      : (queries.find((query) => query.id === request.monitoringQueryId) ?? null);

  const stories = selectPressStories(mentions, {
    organizationId: context.scope.organizationId,
    monitoringQueryId: request.monitoringQueryId,
    selectedQueryEnabled: selected?.enabled ?? false,
    itemLimit: request.itemLimit,
  });

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
    stories: stories.map((mention) => ({
      headline: mention.title,
      excerpt: excerptOf(mention.content),
      publisherName: mention.publisherName,
      publisherDomain: mention.publisherDomain,
      sourceUrl: mention.sourceUrl,
      publishedAt: mention.publishedAt,
    })),
  };
}
