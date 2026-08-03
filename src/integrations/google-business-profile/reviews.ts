import type { JsonObject } from "@/domain";
import type { ExternalReview } from "@/integrations/connector";
import {
  GOOGLE_STAR_RATING_VALUES,
  type GoogleReview,
} from "@/integrations/google-business-profile/schemas";

/**
 * Google reviews, normalised.
 *
 * Pure: no network, no clock, no database. That is what makes the awkward cases
 * — a rating with no words, a reviewer who chose to stay anonymous, a timestamp
 * Google formatted in a way `Date` does not like — testable as themselves
 * rather than only as part of a sync that happened to include one.
 *
 * The governing rule is that nothing is invented. Google does not return a
 * public URL for an individual review, so Lia stores none; a reviewer with no
 * display name gets no display name, not "Anonymous"; a review with no comment
 * gets a null comment, not an empty string that reads as "they wrote nothing"
 * when what happened is that they wrote nothing *because* the product does not
 * require it.
 */

/** Why a review could not be normalised. Sanitised — never quotes the payload. */
export type ReviewNormalizationFailure =
  | "missing_review_id"
  | "missing_timestamps"
  | "unusable_timestamps";

export type NormalizedReview =
  | { ok: true; review: ExternalReview }
  | { ok: false; reason: ReviewNormalizationFailure };

/**
 * Parse a Google timestamp into an ISO-8601 instant.
 *
 * Google sends RFC-3339, which `Date.parse` handles, but a malformed value must
 * not become `Invalid Date` and travel onward as the string "Invalid Date" —
 * that is the kind of value that lands in a database column and is only noticed
 * when a chart renders a gap in 1970.
 */
export function parseGoogleTimestamp(value: string | undefined): string | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return null;
  return new Date(parsed).toISOString();
}

/**
 * Google's star word as an integer from 1 to 5.
 *
 * `STAR_RATING_UNSPECIFIED` and an absent rating both yield null rather than
 * zero. A fabricated zero would drag a location's average down on behalf of a
 * reviewer who never gave one.
 */
export function normalizeStarRating(
  starRating: GoogleReview["starRating"],
): number | null {
  if (!starRating) return null;
  return GOOGLE_STAR_RATING_VALUES[starRating] ?? null;
}

/**
 * Only reviewed fields are carried into source metadata.
 *
 * Built by naming keys rather than spreading the Google response, for the same
 * reason `providerMetadata` is: a field Google adds next quarter must not
 * silently become part of Lia's stored data, where it would be exported,
 * displayed, and eventually depended on without anybody having looked at it.
 */
function reviewMetadata(review: GoogleReview, parent: string): JsonObject {
  const metadata: JsonObject = { googleLocationParent: parent };

  if (review.starRating) metadata.googleStarRating = review.starRating;
  if (review.reviewer?.isAnonymous !== undefined) {
    metadata.reviewerIsAnonymous = review.reviewer.isAnonymous;
  }
  if (review.reviewReply?.comment) metadata.hasOwnerReply = true;

  return metadata;
}

/**
 * Turn one Google review into Lia's shape.
 *
 * `parent` is the `accounts/{a}/locations/{l}` the review was fetched under. It
 * is carried rather than derived from `name`, because a review can legitimately
 * arrive without a resource name and the parent is what a future reply call
 * needs to address the location.
 */
export function normalizeReview(
  review: GoogleReview,
  parent: string,
): NormalizedReview {
  // The identity Lia keys on. Without it there is nothing to be idempotent
  // about, so the item is rejected rather than imported under a synthesised id
  // that would duplicate itself on the next run.
  const externalId = review.reviewId?.trim() || resourceIdFromName(review.name);
  if (!externalId) return { ok: false, reason: "missing_review_id" };

  const createdAt = parseGoogleTimestamp(review.createTime);
  const updatedAt = parseGoogleTimestamp(review.updateTime);

  if (!review.createTime && !review.updateTime) {
    return { ok: false, reason: "missing_timestamps" };
  }

  // `publishedAt` is not nullable on a mention — the inbox is sorted by it and
  // every chart buckets on it. A review whose only timestamps are unparseable
  // therefore cannot be placed in time at all, and guessing "now" would file a
  // three-year-old complaint at the top of today's queue.
  const publishedAt = createdAt ?? updatedAt;
  if (!publishedAt) return { ok: false, reason: "unusable_timestamps" };

  const reviewer = review.reviewer;
  const displayName = reviewer?.displayName?.trim();
  const comment = review.comment?.trim();
  const replyComment = review.reviewReply?.comment?.trim();

  return {
    ok: true,
    review: {
      externalId,
      // Google's own resource name when it sent one. Not reconstructed from
      // the parent and the id: a guessed resource name that Google does not
      // recognise is worse than no resource name at all.
      externalResourceName: review.name?.trim() || null,
      // Absent rather than empty on a rating-only review. The two are different
      // to a drafting workflow: there is nothing to respond *to* in the first
      // case, and a blank quotation to avoid in the second.
      comment: comment && comment.length > 0 ? comment : null,
      rating: normalizeStarRating(review.starRating),
      authorName: displayName && displayName.length > 0 ? displayName : null,
      // Google does not expose a stable reviewer id, so Lia does not claim one.
      // Inventing one from the display name would merge every "John S." in the
      // city into a single customer history.
      authorExternalId: null,
      authorAvatarUrl: reviewer?.profilePhotoUrl?.trim() || null,
      authorIsAnonymous: reviewer?.isAnonymous === true,
      publishedAt,
      sourceUpdatedAt: updatedAt,
      ownerReply:
        replyComment && replyComment.length > 0
          ? {
              comment: replyComment,
              updatedAt: parseGoogleTimestamp(review.reviewReply?.updateTime),
            }
          : null,
      // Google returns no per-review permalink. The location's profile has one;
      // an individual review does not, and fabricating a deep link that 404s
      // would be worse than the field being empty.
      sourceUrl: null,
      metadata: reviewMetadata(review, parent),
    },
  };
}

/** The trailing segment of `accounts/a/locations/l/reviews/r`. */
function resourceIdFromName(name: string | undefined): string | null {
  if (!name) return null;
  const segments = name.split("/").filter((segment) => segment.length > 0);
  const last = segments[segments.length - 1];
  return last && last !== "reviews" ? last : null;
}

/**
 * Normalise a page of reviews, keeping the failures.
 *
 * One malformed item does not abort the import. A location with 900 good
 * reviews and one Google could not describe should end up with 900 imported
 * and a recorded count of what did not, rather than nothing and an error —
 * especially since the malformed one is not something the operator can fix.
 */
export interface NormalizedReviewBatch {
  reviews: ExternalReview[];
  failures: ReviewNormalizationFailure[];
}

export function normalizeReviews(
  reviews: GoogleReview[],
  parent: string,
): NormalizedReviewBatch {
  const batch: NormalizedReviewBatch = { reviews: [], failures: [] };

  for (const review of reviews) {
    const result = normalizeReview(review, parent);
    if (result.ok) batch.reviews.push(result.review);
    else batch.failures.push(result.reason);
  }

  return batch;
}
