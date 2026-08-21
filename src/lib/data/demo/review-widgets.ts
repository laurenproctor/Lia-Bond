import {
  reviewWidgetSchema,
  type Mention,
  type ReviewWidget,
  type ReviewWidgetRenderRow,
} from "@/domain";
import { conflict, notFound } from "@/lib/data/errors";
import { demoRuntimeStore, demoStore, replaceRow, scoped } from "@/lib/data/demo/store";
import type { OrganizationScope, ReviewWidgetRepository } from "@/lib/data/types";
import {
  isWidgetEligibleReview,
  selectMostRecentEligible,
} from "@/lib/widgets/eligibility";
import { REFERENCE_NOW } from "@/lib/seed/clock";
import { seedId } from "@/lib/seed/ids";

/**
 * The demo adapter for the website review widget.
 *
 * Its own file, following `demo/yelp.ts` and `demo/monitoring.ts`. Two things
 * here are not merely a mirror of the Supabase adapter and are worth reading
 * before changing either.
 *
 * 1. **`render()` is the one method that crosses tenants by design.** It is
 *    keyed by public id and has no scope, exactly as the interface says, so it
 *    searches every organization's widgets. That is correct — a visitor to a
 *    restaurant's website belongs to no organization — and it is why the
 *    method resolves the location and organization *from the widget row* and
 *    then filters mentions on both. A lookup that filtered on location alone
 *    would be a cross-tenant read the moment two organizations shared a
 *    location id, which is exactly the class of bug the scope discipline
 *    exists to make impossible everywhere else.
 *
 * 2. **Eligibility is the shared predicate, not a reimplementation.** Both
 *    branches call `isWidgetEligibleReview` / `selectMostRecentEligible` from
 *    `@/lib/widgets/eligibility`, which is also what the configuration screen
 *    filters its "choose a specific review" list with. The Supabase adapter
 *    cannot share it — anonymous traffic needs SQL — so the SQL function is
 *    the documented mirror. Here there is no excuse for a second copy.
 */

function nowIso(): string {
  // Demo mode runs on the seed clock so timestamps stay reproducible.
  return REFERENCE_NOW;
}

export function createReviewWidgetRepository(): ReviewWidgetRepository {
  function widgets(): ReviewWidget[] {
    return demoRuntimeStore().reviewWidgets;
  }

  function findInScope(scope: OrganizationScope, widgetId: string): ReviewWidget {
    const widget = scoped(widgets(), scope.organizationId).find(
      (row) => row.id === widgetId,
    );
    if (!widget) throw notFound("Website widget");
    return widget;
  }

  return {
    async list(scope) {
      return scoped(widgets(), scope.organizationId).map((row) => ({ ...row }));
    },

    async getForLocation(scope, locationId) {
      const widget = scoped(widgets(), scope.organizationId).find(
        (row) => row.locationId === locationId,
      );
      return widget ? { ...widget } : null;
    },

    async upsert(scope, input) {
      const store = demoStore();

      // The location must belong to this organization. Postgres gets this from
      // the foreign key plus the unique constraint on (organization, location);
      // here it has to be checked, and it is checked rather than assumed
      // because the alternative is a widget publishing another tenant's
      // reviews under this tenant's public id.
      const location = store.locations.find(
        (row) => row.id === input.locationId && row.organizationId === scope.organizationId,
      );
      if (!location) throw notFound("Location");

      // A pinned review must belong to the same location. Postgres does not
      // enforce this — `selected_mention_id` is only a foreign key to
      // `mentions` — so it is enforced in the service and restated here, for
      // the same reason the adapter re-filters on organization id everywhere
      // else: the check documents the boundary at the point of the write.
      if (input.selectedMentionId !== null) {
        const mention = store.mentions.find(
          (row) =>
            row.id === input.selectedMentionId &&
            row.organizationId === scope.organizationId &&
            row.locationId === input.locationId,
        );
        if (!mention) {
          throw notFound("Review");
        }
      }

      const existing = scoped(widgets(), scope.organizationId).find(
        (row) => row.locationId === input.locationId,
      );

      const timestamp = nowIso();

      if (existing) {
        // The public id is carried forward, never taken from the input, so an
        // update cannot change which snippet resolves. Rotation is its own
        // method.
        const updated = reviewWidgetSchema.parse({
          ...existing,
          theme: input.theme,
          layout: input.layout,
          selectionMode: input.selectionMode,
          selectedMentionId: input.selectedMentionId,
          minimumRating: input.minimumRating,
          allowedDomains: [...input.allowedDomains],
          updatedAt: timestamp,
        });
        return { ...replaceRow(widgets(), updated) };
      }

      // Mirrors `review_widgets_one_per_location`. Unreachable through the
      // service, which reads before it writes, and kept so a direct adapter
      // caller gets the database's answer rather than a second row.
      if (
        widgets().some(
          (row) =>
            row.organizationId === scope.organizationId &&
            row.locationId === input.locationId,
        )
      ) {
        throw conflict("This location already has a review widget.");
      }

      const created = reviewWidgetSchema.parse({
        id: seedId(`review-widget:${scope.organizationId}:${input.locationId}`),
        organizationId: scope.organizationId,
        locationId: input.locationId,
        publicId: input.publicId,
        status: "active",
        layout: input.layout,
        theme: input.theme,
        selectionMode: input.selectionMode,
        selectedMentionId: input.selectedMentionId,
        minimumRating: input.minimumRating,
        allowedDomains: [...input.allowedDomains],
        attributionSuppressed: false,
        publicIdRotatedAt: null,
        createdByUserId: input.createdByUserId,
        createdAt: timestamp,
        updatedAt: timestamp,
      });

      widgets().push(created);
      return { ...created };
    },

    async setStatus(scope, widgetId, status) {
      const widget = findInScope(scope, widgetId);
      const updated = reviewWidgetSchema.parse({
        ...widget,
        status,
        updatedAt: nowIso(),
      });
      return { ...replaceRow(widgets(), updated) };
    },

    async rotatePublicId(scope, widgetId, publicId, rotatedAt) {
      const widget = findInScope(scope, widgetId);

      // The unique index on `public_id` is global, so the collision check is
      // too. At 120 bits of entropy this will never fire; it exists because
      // "will never fire" and "cannot fire" are different claims, and the
      // Supabase adapter gets the real guarantee from the index.
      if (widgets().some((row) => row.publicId === publicId && row.id !== widgetId)) {
        throw conflict("Could not issue a new embed code. Please try again.");
      }

      const updated = reviewWidgetSchema.parse({
        ...widget,
        publicId,
        publicIdRotatedAt: rotatedAt,
        updatedAt: nowIso(),
      });
      return { ...replaceRow(widgets(), updated) };
    },

    async render(publicId) {
      const widget = widgets().find((row) => row.publicId === publicId);
      if (!widget) return null;

      const store = demoStore();
      const eligibility = {
        locationId: widget.locationId,
        minimumRating: widget.minimumRating,
      };

      // Every mention read below is filtered on the widget's own organization
      // *and* its own location. See the note at the top of this file: this is
      // the one scopeless method in the data layer, so the tenant filter is
      // written out rather than inherited from a scope.
      const candidates = store.mentions.filter(
        (mention) =>
          mention.organizationId === widget.organizationId &&
          mention.locationId === widget.locationId,
      );

      const chosen: Mention | null =
        widget.selectionMode === "specific"
          ? resolvePinned(candidates, widget.selectedMentionId, eligibility)
          : selectMostRecentEligible(candidates, eligibility);

      const profile =
        chosen?.platformProfileId === null || chosen === null
          ? null
          : (store.platformProfiles.find((row) => row.id === chosen.platformProfileId) ??
            null);

      return {
        theme: widget.theme,
        layout: widget.layout,
        status: widget.status,
        attributionSuppressed: widget.attributionSuppressed,
        allowedDomains: [...widget.allowedDomains],
        selectionMode: widget.selectionMode,
        reviewRating: chosen?.rating ?? null,
        reviewText: chosen?.content ?? null,
        reviewAuthorName: chosen?.authorName ?? null,
        reviewPublishedAt: chosen?.publishedAt ?? null,
        profileUrl: profile?.profileUrl ?? null,
        // No column, and nothing to read it from: Google's review payload
        // carries no photographs and no video. A media-led layout resolved
        // this way degrades to the text card in `resolveRenderedWidget`.
        media: null,
      } satisfies ReviewWidgetRenderRow;
    },
  };
}

/**
 * The pinned review, if it is still showable.
 *
 * The rating floor is deliberately not applied — a person who pinned a
 * three-star review meant it, and a floor that overrode an explicit choice
 * would be the product second-guessing a deliberate decision. Every other rule
 * still applies, which is what stops a pinned review that was since dismissed,
 * escalated, or removed at the source from continuing to be published.
 *
 * The SQL function's `pinned` CTE makes the same exception, the same way.
 */
function resolvePinned(
  candidates: readonly Mention[],
  selectedMentionId: string | null,
  eligibility: { locationId: string; minimumRating: number },
): Mention | null {
  if (selectedMentionId === null) return null;

  const mention = candidates.find((row) => row.id === selectedMentionId);
  if (!mention) return null;

  return isWidgetEligibleReview(mention, { ...eligibility, minimumRating: 0 })
    ? mention
    : null;
}
