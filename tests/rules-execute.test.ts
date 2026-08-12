import { beforeEach, describe, expect, it } from "vitest";
import { freshDataSource, ushg } from "./helpers/scope";
import { demoRuntimeStore, demoStore } from "@/lib/data/demo/store";
import { executeRules } from "@/lib/rules/execute";
import type { ExecuteRulesOptions } from "@/lib/rules/execute";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import type {
  AutomationRule,
  AutomationRuleConfig,
  AutomationRuleExecution,
  AutomationSweep,
} from "@/domain";

/**
 * The sweep engine (`executeRules`), against the demo adapter.
 *
 * These are service-level tests, not repository tests: the unit's own
 * behaviour (idempotency, rollback, retry) is proved in
 * `automation-execution-repository.test.ts`. What is proved here is what the
 * loop around it promises — that it claims before it works, stops honestly at
 * its caps, reports what it skipped instead of swallowing it, and that a dry
 * run leaves every business table byte-identical.
 */

let ds: LiaDataSource;
let scope: OrganizationScope;
/** Analysed, low risk, `analyzed` status — a google review. */
let mentionA: string;
/** Analysed, medium risk, `analyzed` status — an article comment. */
let mentionB: string;
let analysisA: string;
let analysisB: string;

const ZERO_COUNTERS = {
  mentionsEvaluated: 0,
  rulesMatched: 0,
  actionsApplied: 0,
  actionsBlocked: 0,
  actionsSkipped: 0,
  actionsFailed: 0,
  retryableFailures: 0,
  terminalFailures: 0,
} as const;

async function seedAnalysis(mentionId: string, analyzedAt: string): Promise<string> {
  const created = await ds.mentions.createAnalysis(scope, {
    mentionId,
    // Its own analysis event, hence its own run id: the escalation contract
    // identifies an occurrence by (organization, run, mention).
    analysisRunId: crypto.randomUUID(),
    modelProvider: "lia",
    modelName: "rating-heuristic",
    promptVersion: "test-1",
    relevanceScore: 0.8,
    relevanceExplanation: null,
    sentiment: "mixed",
    sentimentScore: 0,
    riskLevel: "low",
    riskCategories: [],
    riskExplanation: null,
    topics: [],
    factsNeedingVerification: [],
    recommendedAction: "monitor",
    recommendationExplanation: null,
    analyzedAt,
  });
  return created.id;
}

/**
 * Create, simulate, and enable a rule — the only path to `active`, since
 * `setEnabled` refuses a rule with outstanding activation problems.
 */
async function activateRule(
  config: Partial<AutomationRuleConfig> & { name: string },
): Promise<AutomationRule> {
  const draft = await ds.automationRules.create(scope, {
    description: null,
    priority: 100,
    conditions: [{ field: "mention_status", operator: "is", value: "analyzed" }],
    actions: [{ type: "set_status", status: "monitoring" }],
    ...config,
  });
  await ds.automationRules.recordSimulation(scope, draft.id, draft.revision);
  return ds.automationRules.setEnabled(scope, draft.id, true);
}

/** The seed ships two active USHG rules; tests declare their own rule set. */
async function disableSeededRules(): Promise<void> {
  for (const rule of await ds.automationRules.listActiveForExecution(scope)) {
    await ds.automationRules.setEnabled(scope, rule.id, false);
  }
}

function executions(): AutomationRuleExecution[] {
  return demoRuntimeStore().automationRuleExecutions;
}

function sweeps(): AutomationSweep[] {
  return demoRuntimeStore().automationSweeps;
}

function ruleRow(ruleId: string): AutomationRule {
  const row = demoStore().automationRules.find((entry) => entry.id === ruleId);
  if (!row) throw new Error(`Rule ${ruleId} not found`);
  return row;
}

/**
 * Push a rule's activity stamps back to a clearly ancient instant.
 *
 * `markActivity` is monotonic and both sweeps in a replay test claim within the
 * same millisecond or two, so "did not advance" is only a real assertion when
 * the starting point is unmistakably older than anything a sweep could write.
 */
function backdateActivity(ruleId: string, at: string): void {
  const rows = demoStore().automationRules;
  const index = rows.findIndex((row) => row.id === ruleId);
  const row = rows[index];
  if (!row) throw new Error(`Rule ${ruleId} not found`);
  rows[index] = { ...row, lastEvaluatedAt: at, lastMatchedAt: at, lastAppliedAt: at };
}

/** Rewrite a rule's `createdAt` directly: the demo clock is frozen. */
function setCreatedAt(ruleId: string, createdAt: string): void {
  const rows = demoStore().automationRules;
  const index = rows.findIndex((row) => row.id === ruleId);
  const row = rows[index];
  if (!row) throw new Error(`Rule ${ruleId} not found`);
  rows[index] = { ...row, createdAt };
}

/**
 * Run something once, between the sweep's claim and its first unit.
 *
 * `mentions.get` is the first call the loop makes per mention, which makes it
 * the honest seam for "the world changed mid-sweep" — the rules snapshot is
 * already loaded, the sweep is already claimed, and the unit has not run.
 */
function onFirstMentionLoad(effect: () => void): void {
  const original = ds.mentions.get.bind(ds.mentions);
  let fired = false;
  ds.mentions.get = async (...args: Parameters<typeof original>) => {
    const mention = await original(...args);
    if (!fired) {
      fired = true;
      effect();
    }
    return mention;
  };
}

function pairs(): { mentionId: string; analysisId: string }[] {
  return [
    { mentionId: mentionA, analysisId: analysisA },
    { mentionId: mentionB, analysisId: analysisB },
  ];
}

function onlyA(): { mentionId: string; analysisId: string }[] {
  return [{ mentionId: mentionA, analysisId: analysisA }];
}

function run(
  mode: "dry_run" | "apply",
  processed = onlyA(),
  options?: ExecuteRulesOptions,
) {
  return executeRules({ dataSource: ds, scope }, { mode, processed }, options);
}

/** Deep, order-preserving snapshot of the tables a dry run must not touch. */
function businessSnapshot(): string {
  const store = demoStore();
  return JSON.stringify({
    mentions: store.mentions,
    escalations: store.escalations,
    automationRules: store.automationRules,
    auditEvents: store.auditEvents,
  });
}

beforeEach(async () => {
  ds = freshDataSource();
  scope = ushg.admin();
  await disableSeededRules();

  const analysed = await ds.mentions.list(scope, { statuses: ["analyzed"] });
  const low = analysed.find((row) => row.riskLevel === "low");
  const other = analysed.find((row) => row.id !== low?.id);
  if (!low || !other) throw new Error("Expected two seeded analysed USHG mentions");
  mentionA = low.id;
  mentionB = other.id;

  analysisA = await seedAnalysis(mentionA, "2026-08-01T12:00:00.000Z");
  analysisB = await seedAnalysis(mentionB, "2026-08-01T12:00:00.000Z");
});

describe("executeRules: when there is nothing to do", () => {
  it("returns without claiming when no rule is active", async () => {
    const result = await run("apply");

    expect(result).toEqual({
      sweepId: null,
      claimed: false,
      counters: ZERO_COUNTERS,
      mentionsSkipped: 0,
      budgetExhausted: false,
    });
    expect(sweeps()).toHaveLength(0);
    expect(executions()).toHaveLength(0);
  });

  it("returns without claiming when the processed list is empty", async () => {
    await activateRule({ name: "Watch analysed mentions" });

    const result = await run("apply", []);

    expect(result.claimed).toBe(false);
    expect(result.sweepId).toBeNull();
    expect(sweeps()).toHaveLength(0);
  });

  it("evaluates nothing when the claim is refused", async () => {
    await activateRule({ name: "Watch analysed mentions" });
    const held = await ds.automationSweeps.claim(scope, { mode: "apply" });

    const result = await run("apply");

    expect(result.claimed).toBe(false);
    expect(result.sweepId).toBeNull();
    expect(result.counters).toEqual(ZERO_COUNTERS);
    expect(executions()).toHaveLength(0);
    // The other holder's sweep is untouched and still the only one.
    expect(sweeps()).toHaveLength(1);
    expect(sweeps()[0]!.id).toBe(held.sweep.id);
    expect(sweeps()[0]!.status).toBe("running");
  });
});

describe("executeRules: ordering", () => {
  it("runs equal-priority rules in createdAt order", async () => {
    const first = await activateRule({ name: "Rule one", priority: 50 });
    const second = await activateRule({ name: "Rule two", priority: 50 });

    // Give the id that sorts *later* the *earlier* createdAt, so the assertion
    // can only pass if createdAt beat the id tie-break rather than agreeing
    // with it by accident.
    const [earlier, later] =
      first.id.localeCompare(second.id) > 0 ? [first, second] : [second, first];
    setCreatedAt(earlier.id, "2026-07-01T00:00:00.000Z");
    setCreatedAt(later.id, "2026-07-02T00:00:00.000Z");

    await run("dry_run");

    expect(executions().map((row) => row.automationRuleId)).toEqual([
      earlier.id,
      later.id,
    ]);
  });
});

describe("executeRules: dry run", () => {
  it("projects would_apply and mutates no business table", async () => {
    const rule = await activateRule({ name: "Move analysed to monitoring" });
    const before = businessSnapshot();

    const result = await run("dry_run");

    expect(result.claimed).toBe(true);
    expect(result.sweepId).not.toBeNull();
    expect(result.counters.mentionsEvaluated).toBe(1);
    expect(result.counters.rulesMatched).toBe(1);
    expect(result.counters.actionsApplied).toBe(1);

    const row = executions()[0]!;
    expect(executions()).toHaveLength(1);
    expect(row.mode).toBe("dry_run");
    expect(row.status).toBe("would_apply");
    expect(row.automationRuleId).toBe(rule.id);
    expect(row.ruleRevision).toBe(rule.revision);
    expect(row.triggerAnalysisId).toBe(analysisA);
    expect(row.outcomes).toEqual([
      { index: 0, type: "set_status", outcome: "would_apply", code: null },
    ]);

    // Table by table: only the sweep and the projection may have changed.
    expect(businessSnapshot()).toBe(before);
    expect(sweeps()).toHaveLength(1);
    expect(sweeps()[0]!.status).toBe("completed");
    expect(sweeps()[0]!.counters.mentionsEvaluated).toBe(1);
  });

  it("projects would_block for a status the matrix refuses", async () => {
    await activateRule({
      name: "Escalate everything analysed",
      actions: [{ type: "set_status", status: "escalated" }],
    });
    const before = businessSnapshot();

    const result = await run("dry_run");

    expect(executions()[0]!.status).toBe("would_block");
    expect(executions()[0]!.outcomes).toEqual([
      {
        index: 0,
        type: "set_status",
        outcome: "would_block",
        code: "escalation_reserved",
      },
    ]);
    expect(result.counters.actionsBlocked).toBe(1);
    expect(result.counters.actionsApplied).toBe(0);
    expect(businessSnapshot()).toBe(before);
  });

  it("projects an escalation without raising one", async () => {
    await activateRule({
      name: "Escalate analysed mentions",
      actions: [{ type: "escalate", assigneeUserId: null }],
    });
    const before = businessSnapshot();

    const result = await run("dry_run");

    expect(executions()[0]!.status).toBe("would_apply");
    expect(executions()[0]!.outcomes).toEqual([
      { index: 0, type: "escalate", outcome: "would_apply", code: null },
    ]);
    expect(result.counters.actionsApplied).toBe(1);
    expect(businessSnapshot()).toBe(before);
  });

  it("projects would_no_op when the mention already carries an open escalation", async () => {
    await activateRule({
      name: "Escalate google reviews",
      conditions: [{ field: "source_type", operator: "is", value: "google_review" }],
      actions: [{ type: "escalate", assigneeUserId: null }],
    });
    // Raising a case moves the mention to `escalated` — that transition is
    // part of the creation, not a separate step a caller may skip — so the
    // fixture re-triages afterwards to reach the state this test is about:
    // eligible for escalation, and already carrying an open case.
    await ds.escalations.create(scope, {
      mentionId: mentionA,
      category: "other",
      severity: "medium",
      title: "Already open",
      summary: null,
      dueAt: null,
      triggerAnalysisId: analysisA,
    });
    await ds.mentions.updateStatus(scope, mentionA, "monitoring");
    const before = businessSnapshot();

    await run("dry_run");

    expect(executions()[0]!.status).toBe("would_no_op");
    expect(executions()[0]!.outcomes).toEqual([
      {
        index: 0,
        type: "escalate",
        outcome: "would_no_op",
        code: "escalation_exists",
      },
    ]);
    expect(businessSnapshot()).toBe(before);
  });

  it("writes no execution row when the rule does not match", async () => {
    await activateRule({
      name: "Only dismissed mentions",
      conditions: [{ field: "mention_status", operator: "is", value: "dismissed" }],
    });

    const result = await run("dry_run");

    expect(executions()).toHaveLength(0);
    expect(result.counters.mentionsEvaluated).toBe(1);
    expect(result.counters.rulesMatched).toBe(0);
  });
});

describe("executeRules: apply", () => {
  it("applies a permitted set_status and stamps rule activity", async () => {
    const rule = await activateRule({ name: "Move analysed to monitoring" });

    const result = await run("apply");

    expect(result.claimed).toBe(true);
    expect(result.counters).toEqual({
      ...ZERO_COUNTERS,
      mentionsEvaluated: 1,
      rulesMatched: 1,
      actionsApplied: 1,
    });
    expect(result.mentionsSkipped).toBe(0);
    expect(result.budgetExhausted).toBe(false);

    expect((await ds.mentions.get(scope, mentionA))!.status).toBe("monitoring");

    const row = executions()[0]!;
    expect(row.mode).toBe("apply");
    expect(row.status).toBe("applied");

    const stamped = ruleRow(rule.id);
    expect(stamped.lastEvaluatedAt).not.toBeNull();
    expect(stamped.lastMatchedAt).not.toBeNull();
    expect(stamped.lastAppliedAt).not.toBeNull();

    const sweep = sweeps()[0]!;
    expect(sweep.status).toBe("completed");
    expect(sweep.counters.actionsApplied).toBe(1);
  });

  it("advances evaluation but not matched or applied for a rule that matched nothing", async () => {
    const matching = await activateRule({ name: "Matches" });
    const idle = await activateRule({
      name: "Matches nothing",
      conditions: [{ field: "mention_status", operator: "is", value: "dismissed" }],
    });

    await run("apply");

    expect(ruleRow(idle.id).lastEvaluatedAt).not.toBeNull();
    expect(ruleRow(idle.id).lastMatchedAt).toBeNull();
    expect(ruleRow(idle.id).lastAppliedAt).toBeNull();
    expect(ruleRow(matching.id).lastMatchedAt).not.toBeNull();
  });

  it("records a terminal rule_changed when the rule moves under the sweep", async () => {
    const rule = await activateRule({ name: "Move analysed to monitoring" });
    onFirstMentionLoad(() => {
      const rows = demoStore().automationRules;
      const index = rows.findIndex((row) => row.id === rule.id);
      rows[index] = { ...rows[index]!, revision: rows[index]!.revision + 1 };
    });

    const result = await run("apply");

    const row = executions()[0]!;
    expect(row.status).toBe("failed");
    expect(row.errorClass).toBe("terminal");
    expect(row.lastErrorCode).toBe("rule_changed");
    expect(result.counters.terminalFailures).toBe(1);
    expect(result.counters.actionsApplied).toBe(0);
    // The stale snapshot changed nothing.
    expect((await ds.mentions.get(scope, mentionA))!.status).toBe("analyzed");
  });

  it("counts a mention it cannot load as a terminal failure and keeps going", async () => {
    await activateRule({ name: "Move analysed to monitoring" });
    const original = ds.mentions.get.bind(ds.mentions);
    ds.mentions.get = async (...args: Parameters<typeof original>) => {
      if (args[1] === mentionA) throw new Error("Injected read failure");
      return original(...args);
    };

    const result = await run("apply", pairs());

    expect(result.counters.terminalFailures).toBe(1);
    expect(result.counters.mentionsEvaluated).toBe(1);
    expect(result.counters.actionsApplied).toBe(1);
    expect(sweeps()[0]!.status).toBe("completed");
  });
});

/**
 * The contract that makes a dry run worth running: what it projects is what the
 * apply that follows it does. Each of these runs both modes over the same
 * fixture and pairs the rows up, rather than asserting one mode in isolation.
 */
describe("executeRules: dry run previews the apply faithfully", () => {
  it("replays a resolved case for the same occurrence in both modes", async () => {
    await activateRule({
      name: "Escalate google reviews",
      conditions: [{ field: "source_type", operator: "is", value: "google_review" }],
      actions: [{ type: "escalate", assigneeUserId: null }],
    });
    const raised = await ds.escalations.create(scope, {
      mentionId: mentionA,
      category: "other",
      severity: "medium",
      title: "Handled already",
      summary: null,
      dueAt: null,
      // The same occurrence the sweep runs on, which is what makes both modes
      // treat this as a replay rather than as a fresh decision.
      triggerAnalysisId: analysisA,
    });
    // Closed, not open — and still decisive: the contract's replay arm returns
    // the case this occurrence already produced whatever became of it, so
    // running the same unit again reports history instead of raising a second
    // case. Re-triaging afterwards is what makes the mention eligible again,
    // so the refusal under test is the replay and not the matrix.
    await ds.escalations.updateStatus(
      scope,
      raised.escalation!.id,
      "resolved",
      "Spoke to the guest.",
    );
    await ds.mentions.updateStatus(scope, mentionA, "monitoring");

    await run("dry_run");
    await run("apply");

    const [projected, applied] = executions();
    expect(projected!.mode).toBe("dry_run");
    expect(projected!.status).toBe("would_no_op");
    expect(projected!.outcomes).toEqual([
      { index: 0, type: "escalate", outcome: "would_no_op", code: "escalation_exists" },
    ]);
    expect(applied!.mode).toBe("apply");
    expect(applied!.status).toBe("no_op");
    expect(applied!.outcomes).toEqual([
      { index: 0, type: "escalate", outcome: "no_op", code: "escalation_exists" },
    ]);
    // Still exactly one escalation, and it is the resolved one.
    expect(demoStore().escalations.filter((row) => row.mentionId === mentionA)).toHaveLength(1);
  });

  it("carries a rule's projected effect into the next rule's preview", async () => {
    const first = await activateRule({
      name: "Rule one",
      priority: 10,
      conditions: [{ field: "source_type", operator: "is", value: "google_review" }],
      actions: [{ type: "set_status", status: "monitoring" }],
    });
    const second = await activateRule({
      name: "Rule two",
      priority: 20,
      conditions: [{ field: "source_type", operator: "is", value: "google_review" }],
      actions: [{ type: "set_status", status: "monitoring" }],
    });

    await run("dry_run");
    await run("apply");

    const rows = executions();
    expect(rows.map((row) => [row.automationRuleId, row.mode, row.status])).toEqual([
      [first.id, "dry_run", "would_apply"],
      [second.id, "dry_run", "would_no_op"],
      [first.id, "apply", "applied"],
      // The second rule finds the mention already moved — exactly what the
      // dry run said it would find.
      [second.id, "apply", "no_op"],
    ]);
  });
});

describe("executeRules: replay", () => {
  it("keeps a replayed unit out of the second sweep's counters and activity", async () => {
    const rule = await activateRule({
      name: "Move google reviews to monitoring",
      conditions: [{ field: "source_type", operator: "is", value: "google_review" }],
    });

    const first = await run("apply");
    expect(first.counters.actionsApplied).toBe(1);
    expect(ruleRow(rule.id).lastAppliedAt).not.toBeNull();

    // An unmistakably old floor, so "did not advance" cannot be an artifact of
    // two sweeps claiming in the same millisecond.
    backdateActivity(rule.id, "2020-01-01T00:00:00.000Z");

    const second = await run("apply");

    expect(second.counters).toEqual({
      ...ZERO_COUNTERS,
      mentionsEvaluated: 1,
      rulesMatched: 1,
    });
    // No second execution row either: the unit was already terminal.
    expect(executions()).toHaveLength(1);
    expect(executions()[0]!.attemptCount).toBe(1);

    const stamped = ruleRow(rule.id);
    // Evaluated and matched are honest — the rule was considered and matched.
    expect(stamped.lastEvaluatedAt! > "2020-01-01T00:00:00.000Z").toBe(true);
    expect(stamped.lastMatchedAt! > "2020-01-01T00:00:00.000Z").toBe(true);
    // Applied is not: nothing was applied in the second sweep.
    expect(stamped.lastAppliedAt).toBe("2020-01-01T00:00:00.000Z");
  });

  it("keeps a replayed projection out of the second dry run's counters", async () => {
    await activateRule({ name: "Move analysed to monitoring" });

    const first = await run("dry_run");
    expect(first.counters.actionsApplied).toBe(1);
    expect(executions()).toHaveLength(1);
    const projection = executions()[0]!;

    const second = await run("dry_run");

    // `recordProjection` returned the first sweep's row unchanged, so the
    // second sweep has nothing of its own to count. Only evaluated and matched
    // survive — the rule really was considered, and it really did match.
    expect(second.counters).toEqual({
      ...ZERO_COUNTERS,
      mentionsEvaluated: 1,
      rulesMatched: 1,
    });
    expect(executions()).toHaveLength(1);
    expect(executions()[0]).toEqual(projection);
    expect(executions()[0]!.sweepId).toBe(first.sweepId);
    expect(second.sweepId).not.toBe(first.sweepId);
  });
});

describe("executeRules: caps and budget", () => {
  it("stops at the mention cap and reports the skip", async () => {
    await activateRule({ name: "Move analysed to monitoring" });

    const result = await run("apply", pairs(), {
      limits: {
        maxMentionsPerSweep: 1,
        maxActionsPerSweep: 500,
        maxRulesPerMention: 50,
        budgetMs: 60_000,
      },
    });

    expect(result.counters.mentionsEvaluated).toBe(1);
    expect(result.mentionsSkipped).toBe(1);
    expect(result.budgetExhausted).toBe(false);
    expect(executions()).toHaveLength(1);
  });

  it("stops at the action cap, counting the actions it declined to schedule", async () => {
    await activateRule({ name: "Move analysed to monitoring" });

    const result = await run("apply", pairs(), {
      limits: {
        maxMentionsPerSweep: 200,
        maxActionsPerSweep: 1,
        maxRulesPerMention: 50,
        budgetMs: 60_000,
      },
    });

    expect(result.counters.actionsApplied).toBe(1);
    expect(result.counters.actionsSkipped).toBe(1);
    // The second mention had its turn cut short, so it is not a silent drop.
    expect(result.counters.mentionsEvaluated).toBe(2);
    expect(executions()).toHaveLength(1);
  });

  it("stops cleanly when the time budget runs out between mentions", async () => {
    await activateRule({ name: "Move analysed to monitoring" });

    let elapsed = 0;
    onFirstMentionLoad(() => {
      elapsed = 5_000;
    });

    const result = await run("apply", pairs(), {
      now: () => elapsed,
      limits: {
        maxMentionsPerSweep: 200,
        maxActionsPerSweep: 500,
        maxRulesPerMention: 50,
        budgetMs: 1_000,
      },
    });

    expect(result.budgetExhausted).toBe(true);
    expect(result.counters.mentionsEvaluated).toBe(1);
    expect(result.mentionsSkipped).toBe(1);
    expect(sweeps()[0]!.status).toBe("completed");
  });

  it("evaluates only the first maxRulesPerMention rules", async () => {
    const first = await activateRule({ name: "Rule one", priority: 10 });
    const second = await activateRule({ name: "Rule two", priority: 20 });

    const result = await run("dry_run", onlyA(), {
      limits: {
        maxMentionsPerSweep: 200,
        maxActionsPerSweep: 500,
        maxRulesPerMention: 1,
        budgetMs: 60_000,
      },
    });

    expect(result.counters.rulesMatched).toBe(1);
    expect(executions().map((row) => row.automationRuleId)).toEqual([first.id]);
    expect(second.id).not.toBe(first.id);
  });
});
