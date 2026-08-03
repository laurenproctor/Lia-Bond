import { describe, expect, it } from "vitest";
import {
  normalizeReview,
  normalizeReviews,
  normalizeStarRating,
  parseGoogleTimestamp,
} from "@/integrations/google-business-profile/reviews";
import { reviewParent } from "@/integrations/google-business-profile/connector";
import type { GoogleReview } from "@/integrations/google-business-profile/schemas";

/**
 * Review normalisation.
 *
 * Pure input to pure output, which is the point of keeping the normaliser free
 * of clocks and networks: the cases worth testing here — a rating with no
 * words, a reviewer who stayed anonymous, a timestamp Google formatted oddly —
 * are awkward precisely because they are rare, and they would otherwise only be
 * exercised by a sync that happened to include one.
 */

const PARENT = "accounts/1122334455/locations/1001";

function googleReview(overrides: Partial<GoogleReview> = {}): GoogleReview {
  return {
    name: `${PARENT}/reviews/abc-123`,
    reviewId: "abc-123",
    reviewer: { displayName: "Alex R.", isAnonymous: false },
    starRating: "FOUR",
    comment: "Lovely evening.",
    createTime: "2026-07-01T12:00:00Z",
    updateTime: "2026-07-02T09:30:00Z",
    ...overrides,
  };
}

function expectOk(result: ReturnType<typeof normalizeReview>) {
  if (!result.ok) {
    throw new Error(`expected a normalised review, got ${result.reason}`);
  }
  return result.review;
}

describe("star rating normalisation", () => {
  it("maps every Google star word onto its integer", () => {
    expect(normalizeStarRating("ONE")).toBe(1);
    expect(normalizeStarRating("TWO")).toBe(2);
    expect(normalizeStarRating("THREE")).toBe(3);
    expect(normalizeStarRating("FOUR")).toBe(4);
    expect(normalizeStarRating("FIVE")).toBe(5);
  });

  it("treats an unspecified rating as no rating rather than as zero", () => {
    // A fabricated zero would drag a location's average down on behalf of a
    // reviewer who never gave one.
    expect(normalizeStarRating("STAR_RATING_UNSPECIFIED")).toBeNull();
    expect(normalizeStarRating(undefined)).toBeNull();
  });

  it("carries the rating onto the normalised review", () => {
    expect(expectOk(normalizeReview(googleReview({ starRating: "ONE" }), PARENT)).rating).toBe(1);
  });
});

describe("rating-only reviews", () => {
  it("imports a review with a rating and no comment", () => {
    const review = expectOk(
      normalizeReview(googleReview({ comment: undefined, starRating: "THREE" }), PARENT),
    );

    expect(review.rating).toBe(3);
    // Null, not "": a drafting workflow has to be able to tell "they wrote
    // nothing" from "they wrote an empty string".
    expect(review.comment).toBeNull();
  });

  it("treats a whitespace-only comment as no comment", () => {
    expect(expectOk(normalizeReview(googleReview({ comment: "   " }), PARENT)).comment).toBeNull();
  });
});

describe("reviewer normalisation", () => {
  it("records anonymity separately from a missing name", () => {
    const review = expectOk(
      normalizeReview(
        googleReview({ reviewer: { isAnonymous: true } }),
        PARENT,
      ),
    );

    expect(review.authorIsAnonymous).toBe(true);
    expect(review.authorName).toBeNull();
  });

  it("does not treat a missing reviewer object as anonymity", () => {
    // "Google did not tell us" is not the same claim as "they chose not to be
    // named", and only one of them should stop a response using a name.
    const review = expectOk(normalizeReview(googleReview({ reviewer: undefined }), PARENT));

    expect(review.authorIsAnonymous).toBe(false);
    expect(review.authorName).toBeNull();
  });

  it("keeps the profile photo when Google supplies one", () => {
    const review = expectOk(
      normalizeReview(
        googleReview({
          reviewer: { displayName: "Sam T.", profilePhotoUrl: "https://example.com/p.jpg" },
        }),
        PARENT,
      ),
    );

    expect(review.authorAvatarUrl).toBe("https://example.com/p.jpg");
  });

  it("never invents a reviewer id", () => {
    // Deriving one from the display name would merge every "John S." in the
    // city into one customer history.
    expect(expectOk(normalizeReview(googleReview(), PARENT)).authorExternalId).toBeNull();
  });
});

describe("owner reply normalisation", () => {
  it("carries the published reply and its update time", () => {
    const review = expectOk(
      normalizeReview(
        googleReview({
          reviewReply: { comment: "Thank you!", updateTime: "2026-07-03T08:00:00Z" },
        }),
        PARENT,
      ),
    );

    expect(review.ownerReply).toEqual({
      comment: "Thank you!",
      updatedAt: "2026-07-03T08:00:00.000Z",
    });
  });

  it("reports no reply rather than an empty one when Google sends a blank", () => {
    const review = expectOk(
      normalizeReview(googleReview({ reviewReply: { comment: "  " } }), PARENT),
    );

    expect(review.ownerReply).toBeNull();
  });

  it("keeps the reply when Google omits its update time", () => {
    const review = expectOk(
      normalizeReview(googleReview({ reviewReply: { comment: "Noted." } }), PARENT),
    );

    expect(review.ownerReply?.comment).toBe("Noted.");
    expect(review.ownerReply?.updatedAt).toBeNull();
  });
});

describe("timestamps", () => {
  it("normalises RFC-3339 into ISO-8601", () => {
    expect(parseGoogleTimestamp("2026-07-01T12:00:00Z")).toBe("2026-07-01T12:00:00.000Z");
  });

  it("returns null for an unparseable value rather than Invalid Date", () => {
    expect(parseGoogleTimestamp("not a date")).toBeNull();
    expect(parseGoogleTimestamp(undefined)).toBeNull();
  });

  it("falls back to the update time when there is no create time", () => {
    const review = expectOk(
      normalizeReview(
        googleReview({ createTime: undefined, updateTime: "2026-07-02T09:30:00Z" }),
        PARENT,
      ),
    );

    expect(review.publishedAt).toBe("2026-07-02T09:30:00.000Z");
  });

  it("rejects a review it cannot place in time", () => {
    // Guessing "now" would file a three-year-old complaint at the top of
    // today's queue.
    const result = normalizeReview(
      googleReview({ createTime: "nonsense", updateTime: "also nonsense" }),
      PARENT,
    );

    expect(result).toEqual({ ok: false, reason: "unusable_timestamps" });
  });

  it("rejects a review with no timestamps at all", () => {
    const result = normalizeReview(
      googleReview({ createTime: undefined, updateTime: undefined }),
      PARENT,
    );

    expect(result).toEqual({ ok: false, reason: "missing_timestamps" });
  });
});

describe("identity", () => {
  it("keeps Google's review id and its resource name", () => {
    const review = expectOk(normalizeReview(googleReview(), PARENT));

    expect(review.externalId).toBe("abc-123");
    expect(review.externalResourceName).toBe(`${PARENT}/reviews/abc-123`);
  });

  it("recovers the id from the resource name when reviewId is absent", () => {
    const review = expectOk(normalizeReview(googleReview({ reviewId: undefined }), PARENT));
    expect(review.externalId).toBe("abc-123");
  });

  it("rejects a review with no usable identity", () => {
    // Without one there is nothing to be idempotent about, and a synthesised id
    // would duplicate itself on the next run.
    const result = normalizeReview(
      googleReview({ reviewId: undefined, name: undefined }),
      PARENT,
    );

    expect(result).toEqual({ ok: false, reason: "missing_review_id" });
  });

  it("does not fabricate a resource name Google did not send", () => {
    const review = expectOk(normalizeReview(googleReview({ name: undefined }), PARENT));
    expect(review.externalResourceName).toBeNull();
  });

  it("never invents a public review URL", () => {
    // Google returns no per-review permalink. A fabricated deep link would 404.
    expect(expectOk(normalizeReview(googleReview(), PARENT)).sourceUrl).toBeNull();
  });
});

describe("batch normalisation", () => {
  it("keeps the good reviews and counts the ones it could not read", () => {
    // One unusable item must not cost a location its other reviews.
    const batch = normalizeReviews(
      [
        googleReview({ reviewId: "one" }),
        googleReview({ reviewId: undefined, name: undefined }),
        googleReview({ reviewId: "three" }),
      ],
      PARENT,
    );

    expect(batch.reviews.map((review) => review.externalId)).toEqual(["one", "three"]);
    expect(batch.failures).toEqual(["missing_review_id"]);
  });

  it("returns an empty batch for an empty page", () => {
    expect(normalizeReviews([], PARENT)).toEqual({ reviews: [], failures: [] });
  });
});

describe("review parent", () => {
  it("joins full resource names without doubling their prefixes", () => {
    expect(reviewParent("accounts/112", "locations/445")).toBe(
      "accounts/112/locations/445",
    );
  });

  it("accepts bare ids from an older mapping", () => {
    // A doubled accounts/accounts/ is a 404 that reads like a permissions
    // problem, which is an afternoon lost to the wrong theory.
    expect(reviewParent("112", "445")).toBe("accounts/112/locations/445");
  });
});
