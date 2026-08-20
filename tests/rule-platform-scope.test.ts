import { describe, expect, it } from "vitest";
import { rulePlatformScope } from "@/lib/rules/platform-scope";
import { matchesRule, type RuleSubject } from "@/lib/rules/evaluate";
import { RULE_TEMPLATES } from "@/lib/rules/templates";
import {
  MENTION_SOURCE_TYPES,
  PLATFORM_SOURCE_TYPES,
  PLATFORMS,
  SOURCE_TYPE_PLATFORM,
  type RuleCondition,
} from "@/domain";

/**
 * Which platforms a rule affects.
 *
 * The badge derived from this is a claim about behaviour, so the tests that
 * matter are the ones where the obvious implementation would lie: an empty
 * condition list, conditions that cannot all hold, and an exclusion that does
 * not exclude as much as it looks like it does.
 */

const NEGATIVE: RuleCondition = {
  field: "sentiment",
  operator: "is",
  value: "negative",
};

describe("rulePlatformScope", () => {
  it("treats a rule with no conditions as matching nothing, not everything", () => {
    // `matchesRule` returns false for an empty list on purpose. Reporting "all
    // platforms" here would be the most misleading thing this module could do
    // — it would describe a rule that never fires as the broadest one there is.
    expect(rulePlatformScope([])).toEqual({
      kind: "none",
      reason: "no_conditions",
    });
  });

  it("agrees with the evaluator about the empty case", () => {
    // Pinned against the real evaluator rather than a restated belief about it.
    const subject: RuleSubject = {
      mentionId: "11111111-1111-4111-8111-111111111111",
      platform: "google_business_profile",
      sourceType: "google_review",
      sentiment: "negative",
      riskLevel: "high",
      rating: 1,
      relevanceScore: 0.9,
      locationId: null,
      status: "new",
    };
    expect(matchesRule(subject, [])).toBe(false);
    expect(rulePlatformScope([]).kind).toBe("none");
  });

  it("reports every platform when nothing narrows the scope", () => {
    expect(rulePlatformScope([NEGATIVE])).toEqual({ kind: "all" });
  });

  it("reads a direct platform condition", () => {
    expect(
      rulePlatformScope([{ field: "platform", operator: "is", value: "reddit" }]),
    ).toEqual({ kind: "some", platforms: ["reddit"] });
  });

  it("reads a platform out of a source-type condition", () => {
    // Most of the shipped templates scope themselves this way. Reading only
    // `platform` conditions would report "all platforms" for them.
    expect(
      rulePlatformScope([
        { field: "source_type", operator: "is", value: "news_article" },
      ]),
    ).toEqual({ kind: "some", platforms: ["news_media"] });
  });

  it("removes one platform for an is_not, keeping the rest", () => {
    const scope = rulePlatformScope([
      { field: "platform", operator: "is_not", value: "reddit" },
    ]);

    expect(scope.kind).toBe("some");
    if (scope.kind !== "some") return;
    expect(scope.platforms).not.toContain("reddit");
    expect(scope.platforms).toHaveLength(PLATFORMS.length - 1);
  });

  it("does not drop a platform when only one of its source types is excluded", () => {
    // The case a naive implementation gets wrong. Reddit has two source types,
    // so excluding posts still leaves comments — the rule really does still
    // affect Reddit.
    const scope = rulePlatformScope([
      { field: "source_type", operator: "is_not", value: "reddit_post" },
    ]);

    expect(scope).toEqual({ kind: "all" });
  });

  it("drops a platform when its last source type is excluded", () => {
    const scope = rulePlatformScope([
      { field: "source_type", operator: "is_not", value: "news_article" },
    ]);

    expect(scope.kind).toBe("some");
    if (scope.kind !== "some") return;
    expect(scope.platforms).not.toContain("news_media");
  });

  it("drops Reddit only once both of its source types are excluded", () => {
    const scope = rulePlatformScope([
      { field: "source_type", operator: "is_not", value: "reddit_post" },
      { field: "source_type", operator: "is_not", value: "reddit_comment" },
    ]);

    expect(scope.kind).toBe("some");
    if (scope.kind !== "some") return;
    expect(scope.platforms).not.toContain("reddit");
  });

  it("calls two different platforms contradictory rather than picking one", () => {
    // Conditions are ANDed, so this can never match.
    expect(
      rulePlatformScope([
        { field: "platform", operator: "is", value: "reddit" },
        { field: "platform", operator: "is", value: "yelp" },
      ]),
    ).toEqual({ kind: "none", reason: "contradictory" });
  });

  it("catches two source types on the *same* platform as contradictory", () => {
    // The subtle one: both map to Reddit, so a platform-level intersection
    // alone would happily report "Reddit" for a rule no mention can satisfy —
    // a mention is a post or a comment, never both.
    expect(
      rulePlatformScope([
        { field: "source_type", operator: "is", value: "reddit_post" },
        { field: "source_type", operator: "is", value: "reddit_comment" },
      ]),
    ).toEqual({ kind: "none", reason: "contradictory" });
  });

  it("catches a platform required and forbidden at once", () => {
    expect(
      rulePlatformScope([
        { field: "platform", operator: "is", value: "yelp" },
        { field: "platform", operator: "is_not", value: "yelp" },
      ]),
    ).toEqual({ kind: "none", reason: "contradictory" });
  });

  it("catches a platform condition that disagrees with a source-type condition", () => {
    expect(
      rulePlatformScope([
        { field: "platform", operator: "is", value: "google_business_profile" },
        { field: "source_type", operator: "is", value: "news_article" },
      ]),
    ).toEqual({ kind: "none", reason: "contradictory" });
  });

  it("keeps the intersection when the two agree", () => {
    expect(
      rulePlatformScope([
        { field: "platform", operator: "is", value: "google_business_profile" },
        { field: "source_type", operator: "is", value: "google_review" },
      ]),
    ).toEqual({ kind: "some", platforms: ["google_business_profile"] });
  });

  it("ignores conditions that say nothing about where a mention came from", () => {
    const withNoise = rulePlatformScope([
      { field: "source_type", operator: "is", value: "google_review" },
      NEGATIVE,
      { field: "risk_level", operator: "at_least", value: "high" },
      { field: "rating", operator: "less_than", value: 3 },
    ]);

    expect(withNoise).toEqual({
      kind: "some",
      platforms: ["google_business_profile"],
    });
  });

  it("orders platforms consistently regardless of condition order", () => {
    const forward = rulePlatformScope([
      { field: "platform", operator: "is_not", value: "yelp" },
      { field: "platform", operator: "is_not", value: "reddit" },
    ]);
    const reversed = rulePlatformScope([
      { field: "platform", operator: "is_not", value: "reddit" },
      { field: "platform", operator: "is_not", value: "yelp" },
    ]);

    expect(forward).toEqual(reversed);
  });

  it("never returns an empty platform list under the `some` kind", () => {
    // `some` with no platforms would render as a row of nothing, which is the
    // one output the badge cannot explain.
    for (const platform of PLATFORMS) {
      const scope = rulePlatformScope([
        { field: "platform", operator: "is", value: platform },
      ]);
      expect(scope.kind).toBe("some");
      if (scope.kind === "some") expect(scope.platforms.length).toBeGreaterThan(0);
    }
  });
});

describe("the shipped templates", () => {
  it("every template resolves to a scope that can be rendered", () => {
    for (const template of RULE_TEMPLATES) {
      const scope = rulePlatformScope(template.config.conditions);
      // No template should ship contradictory, and none should ship with no
      // conditions — either would be a starter rule that can never fire.
      expect(scope.kind).not.toBe("none");
    }
  });

  it("scopes the news template to news and the Google ones to Google", () => {
    const byId = new Map(RULE_TEMPLATES.map((template) => [template.id, template]));

    const news = byId.get("escalate-negative-news");
    expect(news).toBeDefined();
    expect(rulePlatformScope(news!.config.conditions)).toEqual({
      kind: "some",
      platforms: ["news_media"],
    });
  });
});

describe("the source-type/platform maps", () => {
  it("covers every source type", () => {
    for (const sourceType of MENTION_SOURCE_TYPES) {
      expect(SOURCE_TYPE_PLATFORM[sourceType]).toBeDefined();
    }
  });

  it("gives every platform a key, even one with no source types", () => {
    for (const platform of PLATFORMS) {
      expect(Array.isArray(PLATFORM_SOURCE_TYPES[platform])).toBe(true);
    }
  });

  it("is a faithful reverse of the forward map", () => {
    for (const sourceType of MENTION_SOURCE_TYPES) {
      expect(PLATFORM_SOURCE_TYPES[SOURCE_TYPE_PLATFORM[sourceType]]).toContain(
        sourceType,
      );
    }
    for (const platform of PLATFORMS) {
      for (const sourceType of PLATFORM_SOURCE_TYPES[platform]) {
        expect(SOURCE_TYPE_PLATFORM[sourceType]).toBe(platform);
      }
    }
  });
});
