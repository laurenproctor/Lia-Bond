import { describe, expect, it } from "vitest";
import { matchesCondition, matchesRule, RISK_RANK, type RuleSubject } from "@/lib/rules/evaluate";
import type { RuleCondition } from "@/domain";

const subject = (overrides: Partial<RuleSubject> = {}): RuleSubject => ({
  mentionId: "m1",
  platform: "google_business_profile",
  sourceType: "google_review",
  locationId: "loc-1",
  rating: 4,
  status: "analyzed",
  sentiment: "positive",
  riskLevel: "low",
  relevanceScore: 0.8,
  ...overrides,
});

// [condition, subject overrides, expected]
const CASES: Array<[RuleCondition, Partial<RuleSubject>, boolean]> = [
  // ========== platform: is, is_not ==========
  [{ field: "platform", operator: "is", value: "reddit" }, { platform: "reddit" }, true],
  [{ field: "platform", operator: "is", value: "reddit" }, { platform: "google_business_profile" }, false],
  [{ field: "platform", operator: "is", value: "google_business_profile" }, {}, true],
  [{ field: "platform", operator: "is", value: "google_business_profile" }, { platform: null }, false], // null never matches
  [{ field: "platform", operator: "is_not", value: "reddit" }, { platform: "google_business_profile" }, true],
  [{ field: "platform", operator: "is_not", value: "google_business_profile" }, {}, false],
  [{ field: "platform", operator: "is_not", value: "reddit" }, { platform: null }, false], // null never matches, even with is_not

  // ========== source_type: is, is_not (never null) ==========
  [{ field: "source_type", operator: "is", value: "google_review" }, {}, true],
  [{ field: "source_type", operator: "is", value: "reddit_post" }, { sourceType: "reddit_post" }, true],
  [{ field: "source_type", operator: "is", value: "news_article" }, { sourceType: "google_review" }, false],
  [{ field: "source_type", operator: "is_not", value: "news_article" }, {}, true],
  [{ field: "source_type", operator: "is_not", value: "google_review" }, { sourceType: "google_review" }, false],
  [{ field: "source_type", operator: "is_not", value: "reddit_post" }, { sourceType: "news_article" }, true],

  // ========== sentiment: is, is_not ("unknown" is a real, matchable value) ==========
  [{ field: "sentiment", operator: "is", value: "positive" }, {}, true],
  [{ field: "sentiment", operator: "is", value: "unknown" }, { sentiment: "unknown" }, true],
  [{ field: "sentiment", operator: "is", value: "negative" }, { sentiment: "positive" }, false],
  [{ field: "sentiment", operator: "is_not", value: "positive" }, { sentiment: "negative" }, true],
  [{ field: "sentiment", operator: "is_not", value: "unknown" }, { sentiment: "unknown" }, false],
  [{ field: "sentiment", operator: "is_not", value: "negative" }, { sentiment: "positive" }, true],

  // ========== risk_level: is, is_not, at_least, at_most (never null) ==========
  [{ field: "risk_level", operator: "is", value: "low" }, {}, true],
  [{ field: "risk_level", operator: "is", value: "medium" }, { riskLevel: "medium" }, true],
  [{ field: "risk_level", operator: "is", value: "high" }, { riskLevel: "low" }, false],
  [{ field: "risk_level", operator: "is_not", value: "low" }, { riskLevel: "low" }, false],
  [{ field: "risk_level", operator: "is_not", value: "low" }, { riskLevel: "medium" }, true],
  [{ field: "risk_level", operator: "is_not", value: "critical" }, { riskLevel: "medium" }, true],

  // at_least (inclusive): >= in RISK_RANK
  [{ field: "risk_level", operator: "at_least", value: "high" }, { riskLevel: "high" }, true],      // high >= high
  [{ field: "risk_level", operator: "at_least", value: "high" }, { riskLevel: "critical" }, true], // critical >= high
  [{ field: "risk_level", operator: "at_least", value: "high" }, { riskLevel: "medium" }, false],  // medium < high
  [{ field: "risk_level", operator: "at_least", value: "low" }, { riskLevel: "low" }, true],       // low >= low
  [{ field: "risk_level", operator: "at_least", value: "medium" }, { riskLevel: "low" }, false],   // low < medium

  // at_most (inclusive): <= in RISK_RANK
  [{ field: "risk_level", operator: "at_most", value: "medium" }, { riskLevel: "medium" }, true],  // medium <= medium
  [{ field: "risk_level", operator: "at_most", value: "medium" }, { riskLevel: "low" }, true],     // low <= medium
  [{ field: "risk_level", operator: "at_most", value: "medium" }, { riskLevel: "high" }, false],   // high > medium
  [{ field: "risk_level", operator: "at_most", value: "critical" }, { riskLevel: "critical" }, true],
  [{ field: "risk_level", operator: "at_most", value: "low" }, { riskLevel: "low" }, true],

  // ========== rating: is, greater_than, less_than (null => no match) ==========
  [{ field: "rating", operator: "is", value: 4 }, { rating: 4 }, true],
  [{ field: "rating", operator: "is", value: 5 }, { rating: 5 }, true],
  [{ field: "rating", operator: "is", value: 3 }, { rating: 4 }, false],
  [{ field: "rating", operator: "is", value: 4 }, { rating: null }, false], // null never matches

  // greater_than (strict: > not >=)
  [{ field: "rating", operator: "greater_than", value: 3 }, { rating: 3 }, false],     // 3 > 3? no
  [{ field: "rating", operator: "greater_than", value: 3 }, { rating: 3.5 }, true],    // 3.5 > 3? yes
  [{ field: "rating", operator: "greater_than", value: 3 }, { rating: 4 }, true],      // 4 > 3? yes
  [{ field: "rating", operator: "greater_than", value: 5 }, { rating: 5 }, false],
  [{ field: "rating", operator: "greater_than", value: 4 }, { rating: null }, false],  // null never matches

  // less_than (strict: < not <=)
  [{ field: "rating", operator: "less_than", value: 4 }, { rating: 4 }, false],        // 4 < 4? no
  [{ field: "rating", operator: "less_than", value: 4 }, { rating: 3.5 }, true],       // 3.5 < 4? yes
  [{ field: "rating", operator: "less_than", value: 2 }, { rating: 2 }, false],        // 2 < 2? no
  [{ field: "rating", operator: "less_than", value: 1 }, { rating: 0.5 }, true],
  [{ field: "rating", operator: "less_than", value: 3 }, { rating: null }, false],     // null never matches

  // ========== relevance_score: greater_than, less_than (null => no match) ==========
  [{ field: "relevance_score", operator: "greater_than", value: 0.7 }, { relevanceScore: 0.8 }, true],
  [{ field: "relevance_score", operator: "greater_than", value: 0.8 }, { relevanceScore: 0.8 }, false], // strict >
  [{ field: "relevance_score", operator: "greater_than", value: 0.9 }, { relevanceScore: 0.8 }, false],
  [{ field: "relevance_score", operator: "greater_than", value: 0.5 }, { relevanceScore: null }, false], // null never matches

  [{ field: "relevance_score", operator: "less_than", value: 0.8 }, { relevanceScore: 0.7 }, true],
  [{ field: "relevance_score", operator: "less_than", value: 0.8 }, { relevanceScore: 0.8 }, false],  // strict <
  [{ field: "relevance_score", operator: "less_than", value: 0.3 }, { relevanceScore: 0.3 }, false], // 0.3 < 0.3? no
  [{ field: "relevance_score", operator: "less_than", value: 0.5 }, { relevanceScore: 0.2 }, true],
  [{ field: "relevance_score", operator: "less_than", value: 0.9 }, { relevanceScore: null }, false],  // null never matches

  // ========== location: is, is_not (null => no match, including is_not) ==========
  [{ field: "location", operator: "is", value: "loc-1" }, { locationId: "loc-1" }, true],
  [{ field: "location", operator: "is", value: "loc-2" }, { locationId: "loc-1" }, false],
  [{ field: "location", operator: "is", value: "loc-1" }, { locationId: "loc-2" }, false],
  [{ field: "location", operator: "is", value: "loc-1" }, { locationId: null }, false], // null never matches

  [{ field: "location", operator: "is_not", value: "loc-1" }, { locationId: "loc-2" }, true],
  [{ field: "location", operator: "is_not", value: "loc-2" }, { locationId: "loc-1" }, true],
  [{ field: "location", operator: "is_not", value: "loc-1" }, { locationId: "loc-1" }, false],
  [{ field: "location", operator: "is_not", value: "loc-1" }, { locationId: null }, false], // null never matches, even with is_not

  // ========== mention_status: is, is_not (never null) ==========
  [{ field: "mention_status", operator: "is", value: "analyzed" }, {}, true],
  [{ field: "mention_status", operator: "is", value: "escalated" }, { status: "escalated" }, true],
  [{ field: "mention_status", operator: "is", value: "responded" }, { status: "analyzed" }, false],
  [{ field: "mention_status", operator: "is_not", value: "escalated" }, { status: "analyzed" }, true],
  [{ field: "mention_status", operator: "is_not", value: "analyzed" }, { status: "analyzed" }, false],
  [{ field: "mention_status", operator: "is_not", value: "new" }, { status: "responded" }, true],
];

describe("matchesCondition", () => {
  it.each(CASES)("%j on %j → %s", (condition, overrides, expected) => {
    expect(matchesCondition(subject(overrides), condition)).toBe(expected);
  });

  it("orders risk ascending low<medium<high<critical", () => {
    expect(RISK_RANK.low).toBeLessThan(RISK_RANK.medium);
    expect(RISK_RANK.medium).toBeLessThan(RISK_RANK.high);
    expect(RISK_RANK.high).toBeLessThan(RISK_RANK.critical);
  });
});

describe("matchesRule", () => {
  it("requires every condition (AND)", () => {
    const conditions: RuleCondition[] = [
      { field: "sentiment", operator: "is", value: "positive" },
      { field: "risk_level", operator: "is", value: "low" },
    ];
    expect(matchesRule(subject(), conditions)).toBe(true);
    expect(matchesRule(subject({ riskLevel: "medium" }), conditions)).toBe(false);
  });

  it("requires at least one condition to match (and never matches with zero conditions)", () => {
    expect(matchesRule(subject(), [])).toBe(false);
  });

  it("returns false if any condition fails", () => {
    const conditions: RuleCondition[] = [
      { field: "sentiment", operator: "is", value: "positive" },
      { field: "platform", operator: "is", value: "reddit" },
    ];
    expect(matchesRule(subject(), conditions)).toBe(false); // platform doesn't match
  });

  it("returns true only when all conditions pass", () => {
    const conditions: RuleCondition[] = [
      { field: "sentiment", operator: "is", value: "positive" },
      { field: "risk_level", operator: "at_most", value: "low" },
      { field: "location", operator: "is", value: "loc-1" },
    ];
    expect(matchesRule(subject(), conditions)).toBe(true);
  });
});
