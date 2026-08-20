import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { NEW_MENTION_DEFAULTS, type Mention } from "@/domain";
import {
  firstFailedWidgetRule,
  isWidgetEligibleReview,
  REVIEW_WIDGET_ELIGIBILITY_RULES,
  reviewerInitials,
  selectMostRecentEligible,
} from "@/lib/widgets/eligibility";

/**
 * Which reviews may be published on a customer's website.
 *
 * The most consequential predicate in the feature — everything it admits ends
 * up in front of people deciding whether to book a table — so every rule gets
 * its own case rather than one "eligible/ineligible" pair.
 *
 * The last block is the one that guards a bug nothing else here could catch.
 * The anonymous render path cannot run this predicate: an embed request has no
 * session, so it goes through `public.review_widget_render`, whose `where`
 * clauses are a hand-written SQL mirror of the list below. Every test in this
 * file would pass with the two out of step, and the symptom in production
 * would be that the review a customer picks from in Lia and the review their
 * website serves are chosen by different rules. So the migration is parsed and
 * required to name every rule.
 */

const BASE: Mention = {
  ...NEW_MENTION_DEFAULTS,
  id: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  locationId: "33333333-3333-4333-8333-333333333333",
  platformConnectionId: "44444444-4444-4444-8444-444444444444",
  platformProfileId: "55555555-5555-4555-8555-555555555555",
  sourceType: "google_review",
  externalId: "review-1",
  externalParentId: null,
  sourceUrl: null,
  title: null,
  content: "Everything was considered, from the welcome to the last course.",
  authorName: "Jordan Lee",
  authorExternalId: null,
  rating: 5,
  language: "en",
  publishedAt: "2026-08-01T12:00:00.000Z",
  receivedAt: "2026-08-01T12:05:00.000Z",
  status: "analyzed",
  sentiment: "positive",
  riskLevel: "low",
  relevanceScore: null,
  engagementScore: null,
  rawPayload: {},
  createdAt: "2026-08-01T12:05:00.000Z",
  updatedAt: "2026-08-01T12:05:00.000Z",
};

const ELIGIBILITY = { locationId: BASE.locationId ?? "", minimumRating: 4 };

function mention(overrides: Partial<Mention> = {}): Mention {
  return { ...BASE, ...overrides };
}

describe("a review that may be published", () => {
  it("accepts an ordinary five-star Google review with text", () => {
    expect(firstFailedWidgetRule(mention(), ELIGIBILITY)).toBeNull();
    expect(isWidgetEligibleReview(mention(), ELIGIBILITY)).toBe(true);
  });
});

describe("each rule refuses on its own", () => {
  it("refuses a review belonging to another location", () => {
    const other = mention({ locationId: "99999999-9999-4999-8999-999999999999" });
    expect(firstFailedWidgetRule(other, ELIGIBILITY)).toBe("location");
  });

  it("refuses a review with no location at all", () => {
    expect(firstFailedWidgetRule(mention({ locationId: null }), ELIGIBILITY)).toBe(
      "location",
    );
  });

  it("refuses anything that is not a Google review", () => {
    expect(firstFailedWidgetRule(mention({ sourceType: "yelp_review" }), ELIGIBILITY)).toBe(
      "source",
    );
  });

  it("refuses a rating-only review, which would render as an empty quotation", () => {
    expect(firstFailedWidgetRule(mention({ content: "   " }), ELIGIBILITY)).toBe("text");
  });

  it("refuses a review with no stars to draw", () => {
    expect(firstFailedWidgetRule(mention({ rating: null }), ELIGIBILITY)).toBe("rating");
  });

  it("refuses a dismissed review", () => {
    expect(firstFailedWidgetRule(mention({ status: "dismissed" }), ELIGIBILITY)).toBe(
      "not_dismissed",
    );
  });

  it("refuses an escalated review, because it was routed to a person as a risk", () => {
    expect(firstFailedWidgetRule(mention({ status: "escalated" }), ELIGIBILITY)).toBe(
      "not_escalated",
    );
  });

  it("refuses a review that no longer exists at the source", () => {
    const removed = mention({ sourceRemovedAt: "2026-08-02T00:00:00.000Z" });
    expect(firstFailedWidgetRule(removed, ELIGIBILITY)).toBe("present_at_source");
  });

  it("refuses a review a person typed in, which nothing can verify", () => {
    const typed = mention({
      captureMethod: "manual_entry",
      capturedAt: "2026-08-01T12:00:00.000Z",
    });
    expect(firstFailedWidgetRule(typed, ELIGIBILITY)).toBe("provider_returned");
  });

  it("refuses a review below the configured floor", () => {
    expect(firstFailedWidgetRule(mention({ rating: 3 }), ELIGIBILITY)).toBe(
      "minimum_rating",
    );
  });

  it("admits a three-star review when the floor is lowered to it", () => {
    const relaxed = { ...ELIGIBILITY, minimumRating: 3 };
    expect(firstFailedWidgetRule(mention({ rating: 3 }), relaxed)).toBeNull();
  });
});

describe("choosing the most recent eligible review", () => {
  it("takes the newest by when the reviewer wrote it, not by when Lia imported it", () => {
    // The backfill case: an old review imported today must not be treated as
    // the most recent one.
    const older = mention({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      publishedAt: "2023-01-01T00:00:00.000Z",
      receivedAt: "2026-08-20T00:00:00.000Z",
    });
    const newer = mention({
      id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      publishedAt: "2026-08-01T00:00:00.000Z",
      receivedAt: "2026-08-01T00:00:00.000Z",
    });

    expect(selectMostRecentEligible([older, newer], ELIGIBILITY)?.id).toBe(newer.id);
  });

  it("breaks a same-instant tie the same way every time", () => {
    const first = mention({ id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa" });
    const second = mention({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });

    // A widget that reshuffled between two same-second reviews on every page
    // load would look broken to the customer.
    expect(selectMostRecentEligible([first, second], ELIGIBILITY)?.id).toBe(second.id);
    expect(selectMostRecentEligible([second, first], ELIGIBILITY)?.id).toBe(second.id);
  });

  it("skips ineligible reviews rather than showing the newest of anything", () => {
    const newestButDismissed = mention({
      id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      publishedAt: "2026-08-10T00:00:00.000Z",
      status: "dismissed",
    });
    const eligible = mention({ id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" });

    expect(selectMostRecentEligible([newestButDismissed, eligible], ELIGIBILITY)?.id).toBe(
      eligible.id,
    );
  });

  it("returns null rather than reaching outside the location", () => {
    const elsewhere = mention({ locationId: "99999999-9999-4999-8999-999999999999" });
    expect(selectMostRecentEligible([elsewhere], ELIGIBILITY)).toBeNull();
  });
});

describe("reviewer initials", () => {
  it("takes the first and last words", () => {
    expect(reviewerInitials("Jordan Lee")).toBe("JL");
    expect(reviewerInitials("Maria del Carmen Ruiz")).toBe("MR");
  });

  it("takes one letter from a single name", () => {
    expect(reviewerInitials("Priya")).toBe("P");
  });

  it("never renders an empty disc", () => {
    // A blank circle reads as a rendering bug rather than as a missing name.
    expect(reviewerInitials("   ")).toBe("?");
    expect(reviewerInitials("★")).toBe("★");
  });

  it("handles scripts with no Latin case without producing an empty string", () => {
    expect(reviewerInitials("佐藤 健").length).toBeGreaterThan(0);
  });
});

describe("the SQL mirror", () => {
  const migration = readFileSync(
    join(
      resolve(process.cwd()),
      "supabase",
      "migrations",
      "20260820000200_review_widget.sql",
    ),
    "utf8",
  );

  it("names every eligibility rule in review_widget_render", () => {
    // The function's `where` clauses carry the rule identifier as a trailing
    // comment on each line. A rule added here and not there means the customer
    // picks reviews under one set of rules and their website serves them under
    // another.
    for (const rule of REVIEW_WIDGET_ELIGIBILITY_RULES) {
      expect(
        migration.includes(`-- ${rule}`),
        `review_widget_render does not name the "${rule}" rule. Add the clause and its trailing comment, or remove the rule from REVIEW_WIDGET_ELIGIBILITY_RULES.`,
      ).toBe(true);
    }
  });

  it("applies the pinned branch without the rating floor", () => {
    // The one deliberate difference between the two branches: an explicitly
    // pinned review is not overridden by a threshold meant for automatic
    // selection. `minimum_rating` must therefore appear exactly once — in the
    // automatic CTE.
    const occurrences = migration.match(/-- minimum_rating/g) ?? [];
    expect(occurrences).toHaveLength(1);
  });

  it("keeps the rule list free of duplicates", () => {
    expect(new Set(REVIEW_WIDGET_ELIGIBILITY_RULES).size).toBe(
      REVIEW_WIDGET_ELIGIBILITY_RULES.length,
    );
  });
});
