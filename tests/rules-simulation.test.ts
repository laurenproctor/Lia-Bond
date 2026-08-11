import { beforeEach, describe, expect, it } from "vitest";
import { freshDataSource, ushg } from "./helpers/scope";
import { demoStore } from "@/lib/data/demo/store";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import type { AutomationRule, AutomationRuleConfig, RuleAction, RuleCondition } from "@/domain";
import { ACTION_CAPABILITIES } from "@/lib/rules/capabilities";
import {
  SIMULATION_CANDIDATE_LIMIT,
  SIMULATION_WINDOW_DAYS,
  simulateRule,
} from "@/lib/rules/simulate";
import { REFERENCE_NOW } from "@/lib/seed/clock";
import { ORG_USHG, SEED_DATASET } from "@/lib/seed/dataset";

/**
 * TDD for the side-effect-free simulation service (Task 10).
 *
 * All expected counts are computed from `SEED_DATASET` in-line, never as
 * magic numbers, so these tests stay correct if the seed corpus changes.
 */

let data: LiaDataSource;
let scope: OrganizationScope;

beforeEach(() => {
  data = freshDataSource();
  scope = ushg.admin();
});

/** publishedAfter cutoff mirroring the service's own window math. */
function cutoffFor(now: Date): number {
  return now.getTime() - SIMULATION_WINDOW_DAYS * 24 * 60 * 60 * 1000;
}

function withinWindow(publishedAt: string, now: Date): boolean {
  return Date.parse(publishedAt) >= cutoffFor(now);
}

const SENTIMENT_NEGATIVE: RuleCondition = {
  field: "sentiment",
  operator: "is",
  value: "negative",
};
const SOURCE_GOOGLE: RuleCondition = {
  field: "source_type",
  operator: "is",
  value: "google_review",
};
const PLATFORM_REDDIT: RuleCondition = {
  field: "platform",
  operator: "is",
  value: "reddit",
};
const RISK_ANY: RuleCondition = {
  field: "risk_level",
  operator: "at_least",
  value: "low",
};
const SOURCE_REDDIT_POST: RuleCondition = {
  field: "source_type",
  operator: "is",
  value: "reddit_post",
};

const ESCALATE: RuleAction = { type: "escalate", assigneeUserId: null };
const NOTIFY_EMAIL: RuleAction = { type: "notify", channel: "email" };

function config(
  name: string,
  conditions: RuleCondition[],
  actions: RuleAction[],
): AutomationRuleConfig {
  return { name, description: null, priority: 100, conditions, actions };
}

async function createRule(
  name: string,
  conditions: RuleCondition[],
  actions: RuleAction[] = [ESCALATE],
): Promise<AutomationRule> {
  return data.automationRules.create(scope, config(name, conditions, actions));
}

/** Count `items` into a `Record<string, number>` by `key`, the same shape breakdowns take. */
function breakdownBy<T>(items: T[], key: (item: T) => string): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    const bucket = key(item);
    counts[bucket] = (counts[bucket] ?? 0) + 1;
  }
  return counts;
}

/** Sum of every bucket in a breakdown record. */
function sumValues(record: Record<string, number>): number {
  return Object.values(record).reduce((total, count) => total + count, 0);
}

describe("simulateRule", () => {
  it("matches the exact count for sentiment is negative AND source_type is google_review", async () => {
    const now = new Date(REFERENCE_NOW);
    const rule = await createRule("Negative Google reviews", [SENTIMENT_NEGATIVE, SOURCE_GOOGLE]);

    const expectedMatched = SEED_DATASET.mentions.filter(
      (mention) =>
        mention.organizationId === ORG_USHG &&
        mention.sentiment === "negative" &&
        mention.sourceType === "google_review" &&
        withinWindow(mention.publishedAt, now),
    ).length;
    const expectedEvaluated = SEED_DATASET.mentions.filter(
      (mention) => mention.organizationId === ORG_USHG && withinWindow(mention.publishedAt, now),
    ).length;

    const result = await simulateRule({ dataSource: data, scope }, rule, now);

    expect(result.evaluated).toBe(expectedEvaluated);
    expect(result.matched).toBe(expectedMatched);
    expect(expectedMatched).toBeGreaterThan(0); // sanity: the hand-built rule is not vacuous
  });

  it("performs zero side effects: mentions, drafts, escalations, audit events, and the rule row are untouched", async () => {
    const now = new Date(REFERENCE_NOW);
    const rule = await createRule("Escalate high risk", [
      { field: "risk_level", operator: "at_least", value: "high" },
    ]);

    const before = {
      mentions: JSON.stringify(demoStore().mentions),
      responseDrafts: JSON.stringify(demoStore().responseDrafts),
      escalations: JSON.stringify(demoStore().escalations),
      auditEvents: JSON.stringify(await data.auditEvents.list(scope)),
    };
    const ruleBefore = await data.automationRules.get(scope, rule.id);

    await simulateRule({ dataSource: data, scope }, rule, now);

    const after = {
      mentions: JSON.stringify(demoStore().mentions),
      responseDrafts: JSON.stringify(demoStore().responseDrafts),
      escalations: JSON.stringify(demoStore().escalations),
      auditEvents: JSON.stringify(await data.auditEvents.list(scope)),
    };
    const ruleAfter = await data.automationRules.get(scope, rule.id);

    expect(after.mentions).toBe(before.mentions);
    expect(after.responseDrafts).toBe(before.responseDrafts);
    expect(after.escalations).toBe(before.escalations);
    expect(after.auditEvents).toBe(before.auditEvents);
    expect(ruleAfter).toEqual(ruleBefore);
  });

  it("resolves platform conditions through connections: platform is reddit matches only reddit-connection mentions", async () => {
    const now = new Date(REFERENCE_NOW);
    const rule = await createRule("Reddit mentions", [PLATFORM_REDDIT]);

    const redditConnectionIds = new Set(
      SEED_DATASET.platformConnections
        .filter((connection) => connection.platform === "reddit")
        .map((connection) => connection.id),
    );
    const expectedMatched = SEED_DATASET.mentions.filter(
      (mention) =>
        mention.organizationId === ORG_USHG &&
        redditConnectionIds.has(mention.platformConnectionId) &&
        withinWindow(mention.publishedAt, now),
    ).length;

    const result = await simulateRule({ dataSource: data, scope }, rule, now);

    expect(result.matched).toBe(expectedMatched);
    expect(expectedMatched).toBeGreaterThan(0); // sanity: the seed does have reddit mentions
  });

  it("excludes mentions outside the 30-day window", async () => {
    // Push `now` far enough into the future that every seeded mention (all
    // anchored to REFERENCE_NOW) falls outside the trailing 30-day window.
    const farFuture = new Date(Date.parse(REFERENCE_NOW) + 400 * 24 * 60 * 60 * 1000);
    const rule = await createRule("Anything at all", [RISK_ANY]);

    const result = await simulateRule({ dataSource: data, scope }, rule, farFuture);

    expect(result.evaluated).toBe(0);
    expect(result.matched).toBe(0);
    expect(result.matchRate).toBe(0);
    expect(result.sample).toEqual([]);
  });

  it("projectedActions marks executable actions unblocked and non-executable actions blocked with the registry's reason", async () => {
    const now = new Date(REFERENCE_NOW);
    const rule = await createRule(
      "Escalate and notify",
      [{ field: "risk_level", operator: "at_least", value: "high" }],
      [ESCALATE, NOTIFY_EMAIL],
    );

    const result = await simulateRule({ dataSource: data, scope }, rule, now);

    expect(result.projectedActions).toHaveLength(2);

    const escalate = result.projectedActions.find((action) => action.type === "escalate");
    expect(escalate).toMatchObject({ blocked: false, blockedReason: null });
    expect(escalate?.count).toBe(result.matched);

    const notify = result.projectedActions.find((action) => action.type === "notify");
    expect(notify).toMatchObject({
      blocked: true,
      blockedReason: ACTION_CAPABILITIES.notify.blockedReason,
    });
    expect(notify?.count).toBe(result.matched);
  });

  it("sample has at most 5 entries and every excerpt is at most 140 characters", async () => {
    const now = new Date(REFERENCE_NOW);
    // risk_level at_least low matches every candidate, so the seed corpus
    // (well over 5 USHG mentions) exercises the cap.
    const rule = await createRule("Everything", [RISK_ANY]);

    const result = await simulateRule({ dataSource: data, scope }, rule, now);

    expect(result.sample.length).toBeLessThanOrEqual(5);
    for (const entry of result.sample) {
      expect(entry.excerpt.length).toBeLessThanOrEqual(140);
    }
  });

  it("truncated is false for the seed corpus, and matchRate is matched / evaluated", async () => {
    const now = new Date(REFERENCE_NOW);
    const rule = await createRule("Everything else", [RISK_ANY]);

    const result = await simulateRule({ dataSource: data, scope }, rule, now);

    expect(result.evaluated).toBeLessThan(SIMULATION_CANDIDATE_LIMIT);
    expect(result.truncated).toBe(false);
    expect(result.matchRate).toBeCloseTo(result.matched / result.evaluated);
  });

  it("breakdowns (sourceType, sentiment, riskLevel) match hand-computed counts from the seed, over matched candidates only", async () => {
    const now = new Date(REFERENCE_NOW);
    const rule = await createRule("Negative Google reviews breakdown", [
      SENTIMENT_NEGATIVE,
      SOURCE_GOOGLE,
    ]);

    const matchedMentions = SEED_DATASET.mentions.filter(
      (mention) =>
        mention.organizationId === ORG_USHG &&
        mention.sentiment === "negative" &&
        mention.sourceType === "google_review" &&
        withinWindow(mention.publishedAt, now),
    );
    expect(matchedMentions.length).toBeGreaterThan(0); // sanity: exercises a non-empty breakdown

    const result = await simulateRule({ dataSource: data, scope }, rule, now);

    expect(result.breakdowns.sourceType).toEqual(
      breakdownBy(matchedMentions, (mention) => mention.sourceType),
    );
    expect(result.breakdowns.sentiment).toEqual(
      breakdownBy(matchedMentions, (mention) => mention.sentiment),
    );
    expect(result.breakdowns.riskLevel).toEqual(
      breakdownBy(matchedMentions, (mention) => mention.riskLevel),
    );
  });

  it("breakdown values sum to matched, not evaluated, for a rule where matched < evaluated", async () => {
    const now = new Date(REFERENCE_NOW);
    const rule = await createRule("Negative Google reviews sum check", [
      SENTIMENT_NEGATIVE,
      SOURCE_GOOGLE,
    ]);

    const result = await simulateRule({ dataSource: data, scope }, rule, now);

    // Precondition for this to be a meaningful check: the rule is selective,
    // so matched is strictly less than evaluated (an "aggregate over evaluated"
    // bug and an "aggregate over matched" implementation would disagree here).
    expect(result.matched).toBeLessThan(result.evaluated);

    expect(sumValues(result.breakdowns.sourceType)).toBe(result.matched);
    expect(sumValues(result.breakdowns.locationId)).toBe(result.matched);
    expect(sumValues(result.breakdowns.sentiment)).toBe(result.matched);
    expect(sumValues(result.breakdowns.riskLevel)).toBe(result.matched);
    expect(sumValues(result.breakdowns.rating)).toBe(result.matched);
  });

  it('locationId breakdown buckets a null-location matched candidate under the literal key "none"', async () => {
    const now = new Date(REFERENCE_NOW);
    // The seed's reddit_post fixtures include a brand-wide post ("Maison
    // Laurent — worth the hype?") with no location, alongside location-specific
    // ones — exactly the mix this bucket exists to distinguish.
    const rule = await createRule("Reddit posts for location bucketing", [SOURCE_REDDIT_POST]);

    const matchedMentions = SEED_DATASET.mentions.filter(
      (mention) =>
        mention.organizationId === ORG_USHG &&
        mention.sourceType === "reddit_post" &&
        withinWindow(mention.publishedAt, now),
    );
    expect(matchedMentions.some((mention) => mention.locationId === null)).toBe(true);

    const expectedLocationBreakdown = breakdownBy(
      matchedMentions,
      (mention) => mention.locationId ?? "none",
    );

    const result = await simulateRule({ dataSource: data, scope }, rule, now);

    expect(result.breakdowns.locationId).toEqual(expectedLocationBreakdown);
    expect(result.breakdowns.locationId.none).toBe(
      matchedMentions.filter((mention) => mention.locationId === null).length,
    );
  });

  it('rating breakdown buckets integer ratings as their string and null ratings as "unrated"', async () => {
    // The seed corpus carries only whole-star ratings (1–5) or none at all —
    // no fractional rating exists to exercise Math.round's rounding behavior,
    // and every rated value already falls inside 1..5 so the clamp never
    // engages either. This test therefore covers the two branches the seed
    // *can* exercise (integer pass-through, null → "unrated"); rounding and
    // clamping at the edges are covered by the production code's own
    // documented contract, not by seed data, since none exists to drive them.
    const now = new Date(REFERENCE_NOW);
    const rule = await createRule("Everything for rating buckets", [RISK_ANY]);

    const matchedMentions = SEED_DATASET.mentions.filter(
      (mention) => mention.organizationId === ORG_USHG && withinWindow(mention.publishedAt, now),
    );
    const expectedRatingBreakdown = breakdownBy(matchedMentions, (mention) =>
      mention.rating === null ? "unrated" : String(mention.rating),
    );

    const result = await simulateRule({ dataSource: data, scope }, rule, now);

    expect(result.breakdowns.rating).toEqual(expectedRatingBreakdown);
    // Sanity: the seed corpus exercises both the rated and unrated branches.
    expect(result.breakdowns.rating.unrated).toBeGreaterThan(0);
    expect(Object.keys(result.breakdowns.rating).some((key) => key !== "unrated")).toBe(true);
  });

  // No dedicated "no AI" behavioral test: the demo data source (used by every
  // test in this file) has no AI-related methods on it at all, so a call to
  // simulateRule succeeding against it is already a trivial existence proof
  // that the service never reaches for one. The zero-side-effect test above
  // is the real behavioral pin — see the doc comment on simulate.ts for the
  // import-level guarantee (no @/ai import, ever).
});
