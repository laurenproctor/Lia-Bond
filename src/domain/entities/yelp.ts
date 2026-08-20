import { z } from "zod";
import { mentionSourceTypeSchema } from "@/domain/enums";
import {
  organizationOwnedSchema,
  timestampSchema,
  timestampsSchema,
  uuidSchema,
} from "@/domain/primitives";

/**
 * Yelp Assisted: what Lia observed, and what changed between observations.
 *
 * The whole of this feature's evidence base is two numbers per listing — a
 * review count and an aggregate rating — so the honesty problem here is not
 * "does the UI overclaim" but "does the *data model* overclaim". A column
 * called `new_review_count` would be a lie in the schema, quoted back by every
 * screen and every report that ever read it, and no amount of careful copy
 * above it would help. So the vocabulary below describes **changes in
 * counters**, never reviews, and there is deliberately nowhere to record a
 * number of new reviews.
 */

/* -------------------------------------------------------------------------- */
/* Snapshots                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One successful observation of a connected listing.
 *
 * Append-only, one row per successful check. Storing every observation rather
 * than only the changes costs two integers a day per location and buys three
 * things a change-only table could not: a rating history somebody can chart,
 * the ability to prove Lia *was* checking during a period nothing happened, and
 * a stable pair of ids for an occurrence to point at.
 *
 * Both counters are nullable, and that is load-bearing rather than defensive.
 * Yelp omits them on some responses, and the alternatives are both wrong: a
 * zero would read as every review having been deleted, and refusing to store
 * the observation at all would lose the evidence that a check ran.
 */
export const yelpListingSnapshotSchema = z
  .object({
    platformProfileId: uuidSchema,
    /** The sync run that produced it. Every snapshot has an attributable check. */
    syncRunId: uuidSchema.nullable(),
    observedAt: timestampSchema,
    reviewCount: z.number().int().min(0).nullable(),
    /** Yelp publishes ratings in halves from 1 to 5. */
    rating: z.number().min(0).max(5).nullable(),
    /** Yelp reported the business as permanently closed at this observation. */
    isClosed: z.boolean(),
    createdAt: timestampSchema,
  })
  .extend(organizationOwnedSchema.shape);

export type YelpListingSnapshot = z.infer<typeof yelpListingSnapshotSchema>;

export const createYelpListingSnapshotInputSchema = yelpListingSnapshotSchema.omit({
  id: true,
  organizationId: true,
  createdAt: true,
});

export type CreateYelpListingSnapshotInput = z.infer<
  typeof createYelpListingSnapshotInputSchema
>;

/* -------------------------------------------------------------------------- */
/* Occurrences                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * What kind of change was observed between two snapshots.
 *
 * Every name describes the *counter*, not the reviews behind it, because the
 * counters are all Lia has. A count that went up by one may be one new review;
 * it may also be two new reviews and one removed, or a review Yelp
 * un-recommended being recommended again. The vocabulary has to leave room for
 * all of those, and a name like `review_added` would not.
 */
export const YELP_ACTIVITY_CHANGE_KINDS = [
  "count_increased",
  "count_decreased",
  "count_and_rating",
  /**
   * The count held still and the average moved.
   *
   * Not a curiosity: it is what an edited review looks like, and what a
   * recommendation-status change looks like. Worth surfacing precisely because
   * a customer would otherwise never learn their rating had moved.
   */
  "rating_only",
] as const;
export const yelpActivityChangeKindSchema = z.enum(YELP_ACTIVITY_CHANGE_KINDS);
export type YelpActivityChangeKind = z.infer<typeof yelpActivityChangeKindSchema>;

/**
 * Where an occurrence stands.
 *
 * `captured` means somebody added the review this change prompted them to look
 * for. `dismissed` means they looked and decided there was nothing to answer —
 * which is a real and common outcome, since a count can move for reasons no
 * response would address.
 */
export const YELP_ACTIVITY_STATUSES = ["open", "captured", "dismissed"] as const;
export const yelpActivityStatusSchema = z.enum(YELP_ACTIVITY_STATUSES);
export type YelpActivityStatus = z.infer<typeof yelpActivityStatusSchema>;

/**
 * One observed change in a connected listing's counters.
 *
 * Identity is the pair of snapshots it sits between, which is what makes
 * detection idempotent: a repeated or concurrent check comparing the same two
 * observations produces the same occurrence, and the database's unique index on
 * `(platformProfileId, fromSnapshotId, toSnapshotId)` refuses the second write
 * rather than the application checking first (D24's reasoning).
 *
 * Note what is absent: any field for how many reviews changed, any field for
 * review text, and any field a person could use to record what they *think*
 * happened. The occurrence records an observation; the mention records a
 * review; conflating them is the mistake this whole feature is arranged to
 * avoid.
 */
export const yelpActivityOccurrenceSchema = z
  .object({
    platformProfileId: uuidSchema,
    /** Denormalised from the profile so the inbox can filter without a join. */
    locationId: uuidSchema.nullable(),
    fromSnapshotId: uuidSchema,
    toSnapshotId: uuidSchema,
    detectedAt: timestampSchema,
    changeKind: yelpActivityChangeKindSchema,
    previousReviewCount: z.number().int().min(0).nullable(),
    currentReviewCount: z.number().int().min(0).nullable(),
    previousRating: z.number().min(0).max(5).nullable(),
    currentRating: z.number().min(0).max(5).nullable(),
    status: yelpActivityStatusSchema,
    /** The manually captured review, once somebody adds one. */
    capturedMentionId: uuidSchema.nullable(),
    resolvedByUserId: uuidSchema.nullable(),
    resolvedAt: timestampSchema.nullable(),
  })
  .extend(organizationOwnedSchema.shape)
  .extend(timestampsSchema.shape);

export type YelpActivityOccurrence = z.infer<typeof yelpActivityOccurrenceSchema>;

export const yelpActivityOccurrenceFilterSchema = z.object({
  platformProfileId: uuidSchema.optional(),
  locationId: uuidSchema.optional(),
  statuses: z.array(yelpActivityStatusSchema).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
});

export type YelpActivityOccurrenceFilter = z.infer<
  typeof yelpActivityOccurrenceFilterSchema
>;

/* -------------------------------------------------------------------------- */
/* Change derivation                                                           */
/* -------------------------------------------------------------------------- */

/** Two observations, as the comparison needs them. */
export interface YelpCounters {
  readonly reviewCount: number | null;
  readonly rating: number | null;
}

/**
 * What changed between two observations, or nothing.
 *
 * Pure, and the single declaration of the rule — the check service calls it and
 * the SQL harness asserts the same cells, so "what counts as activity" cannot
 * drift between the two.
 *
 * Three refusals are deliberate, and each one exists because the alternative
 * fabricates activity:
 *
 * 1. **A null on either side is not a change.** Yelp omitting a counter is Lia
 *    failing to observe, not the listing moving. Treating `128 → null` as a
 *    decrease would announce that every review had been deleted, off the back
 *    of a provider hiccup.
 * 2. **A rating change with no rating on one side is not a rating change**, for
 *    the same reason, checked independently of the count.
 * 3. **Equal counters are no occurrence at all**, which is what makes a
 *    scheduled check on a quiet listing free.
 */
export function deriveYelpActivityChange(
  previous: YelpCounters,
  current: YelpCounters,
): YelpActivityChangeKind | null {
  const countComparable =
    previous.reviewCount !== null && current.reviewCount !== null;
  const ratingComparable = previous.rating !== null && current.rating !== null;

  const countMoved =
    countComparable && previous.reviewCount !== current.reviewCount;
  const ratingMoved = ratingComparable && previous.rating !== current.rating;

  if (!countMoved && !ratingMoved) return null;
  if (countMoved && ratingMoved) return "count_and_rating";
  if (!countMoved) return "rating_only";

  // `countMoved` implies both sides are non-null, but TypeScript cannot see
  // that through the boolean, so the comparison is re-expressed rather than
  // asserted with a non-null operator.
  return (current.reviewCount ?? 0) > (previous.reviewCount ?? 0)
    ? "count_increased"
    : "count_decreased";
}

/**
 * Whether a change is worth asking somebody to go and look at Yelp.
 *
 * Every kind is, today — including a decrease, which is exactly the case a
 * customer most wants to know about and least expects to be told. The function
 * exists so that a future tuning decision ("stop prompting on rating-only
 * moves smaller than 0.1") has one place to live rather than being written
 * into the check service's control flow.
 */
export function yelpChangeWarrantsCapture(kind: YelpActivityChangeKind): boolean {
  return YELP_ACTIVITY_CHANGE_KINDS.includes(kind);
}

/* -------------------------------------------------------------------------- */
/* Manual capture                                                              */
/* -------------------------------------------------------------------------- */

/**
 * The source types a review may be captured manually for.
 *
 * Declared as data, and restated as a database constraint, for the reason a
 * button is not a security boundary: a caller reaching the capture path with a
 * `news_article` must be refused by the schema, not merely never offered the
 * control. Yelp is the only member today; Trustpilot and TripAdvisor are the
 * obvious next two, and both are one entry plus a UI surface.
 */
export const MANUALLY_CAPTURABLE_SOURCE_TYPES = ["yelp_review"] as const;

export function isManuallyCapturableSourceType(value: string): boolean {
  return (MANUALLY_CAPTURABLE_SOURCE_TYPES as readonly string[]).includes(value);
}

/**
 * A review a customer is typing into Lia.
 *
 * `organizationId` is absent for the reason it is absent from every other write
 * input: the tenant comes from the caller's verified scope, never the payload.
 * `capture_method`, `capturedByUserId`, and `capturedAt` are absent too — they
 * are stamped by the service from the session and the clock, so a crafted
 * request cannot claim a review arrived through an API or attribute it to
 * somebody else.
 *
 * The bounds are not decoration. `content` is capped because this is an
 * unauthenticated-content path in the sense that matters — nothing upstream
 * validated it — and an unbounded text field reaching the analysis prompt is
 * both a cost problem and a prompt-injection surface.
 */
export const captureYelpReviewInputSchema = z.object({
  /** The connected Yelp listing this review was read from. */
  platformProfileId: uuidSchema,
  sourceType: mentionSourceTypeSchema.refine(isManuallyCapturableSourceType, {
    message: "This source type cannot be captured by hand",
  }),
  /**
   * The review's own Yelp URL, when the customer has one.
   *
   * Optional because Yelp does not give every review a shareable permalink, and
   * demanding one would block capture for the reviews that have none. When it
   * is supplied it becomes the deduplication key, which is strictly better than
   * the fingerprint fallback.
   */
  reviewUrl: z.string().max(2048).optional(),
  rating: z.number().int().min(1).max(5),
  content: z.string().min(1).max(5000),
  authorName: z.string().max(200).optional(),
  /**
   * The date shown on the review, when the customer supplies one.
   *
   * A date rather than an instant: Yelp shows a day, not a time, and storing
   * midnight-UTC as though it were the publication moment would be a precision
   * Lia does not have. The service resolves it to a timestamp and records that
   * it was customer-supplied.
   */
  reviewedOn: z.iso.date().optional(),
  /** The activity occurrence that prompted this, when there was one. */
  activityOccurrenceId: uuidSchema.optional(),
  /**
   * Proceed even though Lia matched an existing review.
   *
   * The deliberate override the deduplication contract requires. Defaults to
   * false, so the safe path is the one a caller gets by saying nothing, and
   * setting it is recorded in the audit event — a silent merge and a silent
   * duplicate are both worse than an answerable decision.
   */
  confirmDistinct: z.boolean().default(false),
});

export type CaptureYelpReviewInput = z.input<typeof captureYelpReviewInputSchema>;

/**
 * What a capture attempt did.
 *
 * `duplicate` is an outcome rather than an error: the caller asked to add a
 * review Lia already holds, and the honest answer is to show them the one that
 * exists and offer the override, not to fail.
 */
export const YELP_CAPTURE_OUTCOMES = ["captured", "duplicate"] as const;
export const yelpCaptureOutcomeSchema = z.enum(YELP_CAPTURE_OUTCOMES);
export type YelpCaptureOutcome = z.infer<typeof yelpCaptureOutcomeSchema>;
