import type { Mention } from "@/domain";

/**
 * Which reviews the website widget may publish.
 *
 * This is the most consequential predicate in the feature: everything it
 * admits ends up on a customer's own homepage, in front of people deciding
 * whether to book a table. So it is written as a named list of rules rather
 * than a boolean expression, and every rule reuses a meaning the repository
 * already has. Nothing here invents a new review state.
 *
 * **It has a twin.** The anonymous render path cannot run TypeScript — it goes
 * through `public.review_widget_render`, a `SECURITY DEFINER` function, because
 * an embed request carries no session and no row-level-security policy would
 * return the row. That function's `where` clause is the SQL mirror of the list
 * below, clause for clause, and its comment says so. When a rule changes here
 * it must change there in the same commit; `tests/review-widget-eligibility.test.ts`
 * pins the rule identifiers and the migration quotes them.
 *
 * The rules:
 *
 * | id | rule | why |
 * | --- | --- | --- |
 * | `location` | belongs to the widget's location | the brief's "do not silently substitute a review from another location" |
 * | `source` | `source_type = 'google_review'` | this is a Google widget, and it says Google on it |
 * | `text` | non-empty `content` | a rating-only review renders as an empty quotation |
 * | `rating` | a rating exists | the widget draws stars; there is nothing honest to draw without one |
 * | `not_dismissed` | `status <> 'dismissed'` | `dismissed` is the existing "this was dealt with and put away" |
 * | `not_escalated` | `status <> 'escalated'` | a review Lia routed as a sensitive issue is the last one to feature |
 * | `present_at_source` | `source_removed_at is null` | content withdrawn at the source must stop being republished |
 * | `provider_returned` | `capture_method = 'provider_api'` | a typed review is unverifiable by construction |
 * | `minimum_rating` | `rating >= widget.minimum_rating` | widget configuration, not review state |
 *
 * Two of these deserve their reasoning in full.
 *
 * **`not_escalated`.** An escalation is Lia's record that a mention was routed
 * to a person as a risk. Reusing that existing meaning is the opposite of
 * inventing one: the product already treats `escalated` as "this needs
 * handling", and "needs handling" and "put this on the homepage" cannot both
 * be true. A review that is later resolved leaves `escalated` through the
 * normal lifecycle and becomes eligible again on its own.
 *
 * **`provider_returned`.** `capture_method = 'manual_entry'` means a person
 * typed the review into Lia and nothing can verify it (see the Yelp Assisted
 * schema). Republishing that on a public website as a Google review would be
 * Lia asserting a customer's words that no provider ever returned. No Google
 * review is manually captured today — the column is platform-neutral and the
 * capture path is Yelp's — which is exactly why this rule is cheap to hold now
 * and expensive to add after the first manual Google capture ships.
 */

/** The rule identifiers, in the order the predicate applies them. */
export const REVIEW_WIDGET_ELIGIBILITY_RULES = [
  "location",
  "source",
  "text",
  "rating",
  "not_dismissed",
  "not_escalated",
  "present_at_source",
  "provider_returned",
  "minimum_rating",
] as const;

export type ReviewWidgetEligibilityRule =
  (typeof REVIEW_WIDGET_ELIGIBILITY_RULES)[number];

/** The mention statuses a widget will not publish, and nothing else. */
export const INELIGIBLE_WIDGET_STATUSES = ["dismissed", "escalated"] as const;

export interface ReviewWidgetEligibilityInput {
  locationId: string;
  minimumRating: number;
}

/**
 * The first rule a mention fails, or null when it passes every one.
 *
 * Returning the rule rather than a boolean is what lets the configuration
 * screen tell somebody *why* a review they can plainly see in their inbox is
 * not on the list of ones they may pin — the single most likely support
 * question this feature generates.
 */
export function firstFailedWidgetRule(
  mention: Mention,
  input: ReviewWidgetEligibilityInput,
): ReviewWidgetEligibilityRule | null {
  if (mention.locationId !== input.locationId) return "location";
  if (mention.sourceType !== "google_review") return "source";
  if (mention.content.trim().length === 0) return "text";
  if (mention.rating === null) return "rating";
  if (mention.status === "dismissed") return "not_dismissed";
  if (mention.status === "escalated") return "not_escalated";
  if (mention.sourceRemovedAt !== null) return "present_at_source";
  if (mention.captureMethod !== "provider_api") return "provider_returned";
  if (mention.rating < input.minimumRating) return "minimum_rating";
  return null;
}

export function isWidgetEligibleReview(
  mention: Mention,
  input: ReviewWidgetEligibilityInput,
): boolean {
  return firstFailedWidgetRule(mention, input) === null;
}

/**
 * The newest eligible review, or null.
 *
 * Sorted by `publishedAt` — when the reviewer wrote it — rather than by
 * `receivedAt`. A backfill imports three years of reviews in one afternoon,
 * and ordering by arrival would put a 2023 review on the homepage as "most
 * recent" for as long as it took the next sync to run. `id` breaks ties so the
 * choice is stable across renders: a widget that reshuffles between two
 * same-second reviews on every page load looks broken.
 */
export function selectMostRecentEligible(
  mentions: readonly Mention[],
  input: ReviewWidgetEligibilityInput,
): Mention | null {
  const eligible = mentions.filter((mention) => isWidgetEligibleReview(mention, input));
  if (eligible.length === 0) return null;

  return eligible.reduce((newest, candidate) => {
    if (candidate.publishedAt > newest.publishedAt) return candidate;
    if (candidate.publishedAt < newest.publishedAt) return newest;
    return candidate.id > newest.id ? candidate : newest;
  });
}

/**
 * Up to two initials for the avatar disc.
 *
 * The widget shows no photographs in this version, so the disc is the only
 * thing standing in for a reviewer. Built from the display name Google gave —
 * never from an email or an identifier, neither of which Lia holds for a
 * Google reviewer anyway.
 *
 * Deliberately tolerant of scripts with no Latin case: a name that yields no
 * letters falls back to the first character it does have, because an empty
 * disc reads as a rendering bug.
 */
export function reviewerInitials(displayName: string): string {
  const words = displayName
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);

  if (words.length === 0) return "?";

  const first = [...(words[0] ?? "")][0] ?? "";
  const last = words.length > 1 ? ([...(words[words.length - 1] ?? "")][0] ?? "") : "";

  const initials = `${first}${last}`.toUpperCase();
  return initials.length > 0 ? initials.slice(0, 2) : "?";
}
