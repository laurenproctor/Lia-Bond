import type { RenderedReviewWidget, ReviewWidgetRenderRow } from "@/domain";
import { normalizeGoogleUrl } from "@/integrations/google-business-profile/urls";
import { resolveWidgetAttribution } from "@/lib/widgets/attribution";
import { reviewerInitials } from "@/lib/widgets/eligibility";

/**
 * The row a widget resolved to, turned into what the document draws.
 *
 * Its own module, between the repository and the renderer, because three
 * decisions have to be made in one place or they will be made twice and
 * differently:
 *
 * 1. **Which unavailable state applies.** Both adapters return "nothing
 *    resolved" the same way — a row with null review fields — and the reason
 *    is derived from the widget's own `selectionMode` rather than stored. A
 *    pinned review that vanished and a location with nothing to show are the
 *    same absence in the database and two entirely different sentences on a
 *    customer's website.
 *
 * 2. **Whether the Google link renders.** The stored profile URL is validated
 *    here, at the last point before it becomes a destination in a stranger's
 *    browser, exactly as `resolveYelpDestination` re-validates a stored Yelp
 *    URL. It was validated when it was written, by different code, at a
 *    different time; a validator at the boundary holds regardless of what has
 *    changed upstream since.
 *
 * 3. **Whether the attribution line renders.** One call to the plan policy,
 *    never a boolean threaded through the render path.
 *
 * The function is total: every input produces something drawable. A public
 * embed that could throw is a public embed that shows a stack trace on a
 * restaurant's homepage.
 */
export function resolveRenderedWidget(
  row: ReviewWidgetRenderRow | null,
): RenderedReviewWidget {
  // Unknown public id. The theme has to come from somewhere and there is no
  // widget to ask, so the light card is used — it is the one that disappears
  // into a page rather than punching a black rectangle into it.
  if (row === null) {
    return {
      state: "unavailable",
      reason: "unknown_widget",
      theme: "light",
      layout: "single_review_text",
      showAttribution: true,
      allowedDomains: [],
    };
  }

  const attribution = resolveWidgetAttribution({
    attributionSuppressed: row.attributionSuppressed,
  });

  const shell = {
    theme: row.theme,
    layout: row.layout,
    showAttribution: attribution.visible,
    allowedDomains: row.allowedDomains,
  } as const;

  if (row.status === "disabled") {
    return { state: "unavailable", reason: "disabled", ...shell };
  }

  const hasReview =
    row.reviewText !== null &&
    row.reviewText.trim().length > 0 &&
    row.reviewRating !== null &&
    row.reviewPublishedAt !== null;

  if (!hasReview) {
    return {
      state: "unavailable",
      // The distinction the product brief asks for by name: a pinned review
      // that can no longer be shown must never be answered with a different
      // review, and must not be reported as "no reviews yet" either — the
      // first is a configuration a person can fix, the second is a wait.
      reason:
        row.selectionMode === "specific"
          ? "selected_review_unavailable"
          : "no_eligible_review",
      ...shell,
    };
  }

  // Narrowed by `hasReview`, restated for the type checker rather than
  // asserted: `noUncheckedIndexedAccess` and strict null checks do not follow
  // the boolean.
  const text = row.reviewText ?? "";
  const rating = row.reviewRating ?? 0;
  const publishedAt = row.reviewPublishedAt ?? "";

  // Google returns a display name for most reviews and nothing for anonymous
  // ones. "A Google user" is Google's own wording for that case, so it is what
  // the widget shows rather than a blank line or an invented name.
  const authorName = row.reviewAuthorName?.trim() || "A Google user";

  return {
    state: "ready",
    ...shell,
    review: {
      rating,
      text: text.trim(),
      authorName,
      authorInitials: reviewerInitials(authorName),
      publishedAt,
      readOnGoogleUrl: row.profileUrl ? normalizeGoogleUrl(row.profileUrl) : null,
    },
  };
}
