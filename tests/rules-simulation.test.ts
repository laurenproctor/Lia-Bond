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

  // No dedicated "no AI" behavioral test: the demo data source (used by every
  // test in this file) has no AI-related methods on it at all, so a call to
  // simulateRule succeeding against it is already a trivial existence proof
  // that the service never reaches for one. The zero-side-effect test above
  // is the real behavioral pin — see the doc comment on simulate.ts for the
  // import-level guarantee (no @/ai import, ever).
});
