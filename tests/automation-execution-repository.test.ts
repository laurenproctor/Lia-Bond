import { beforeEach, describe, expect, it } from "vitest";
import { freshDataSource, ushg } from "./helpers/scope";
import { demoRuntimeStore, demoStore } from "@/lib/data/demo/store";
import { DataError } from "@/lib/data/errors";
import type { ExecuteUnitInput, LiaDataSource, OrganizationScope } from "@/lib/data/types";
import {
  isEscalationClosed,
  type AutomationSweep,
  type SweepCounters,
} from "@/domain";

/**
 * The demo adapter's execution unit (spec §7).
 *
 * The demo adapter is the in-memory twin of the G1 execution RPC: claim,
 * replay, retry, and whole-unit rollback are specified here first, and the
 * PostgreSQL harness is later held to the same behaviour. So these tests are
 * about semantics — what survives a failure, what a replay must *not* do —
 * rather than about the store's shape.
 */

let ds: LiaDataSource;
let scope: OrganizationScope;
let ruleId: string;
let mentionId: string;
let analysisId: string;
let newAnalysisId: string;
let sweepId: string;

/** An analysis row for the mention, so `triggerAnalysisId` names a real occurrence. */
async function seedAnalysis(analyzedAt: string): Promise<string> {
  const created = await ds.mentions.createAnalysis(scope, {
    mentionId,
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

function unit(overrides: Partial<ExecuteUnitInput> = {}): ExecuteUnitInput {
  return {
    sweepId,
    automationRuleId: ruleId,
    ruleRevision: 1,
    mentionId,
    triggerAnalysisId: analysisId,
    actions: [{ type: "set_status", status: "monitoring" }],
    ...overrides,
  };
}

function getSweep(id: string): AutomationSweep {
  const sweep = demoRuntimeStore().automationSweeps.find((row) => row.id === id);
  if (!sweep) throw new Error(`Sweep ${id} not found`);
  return sweep;
}

/** Push the running sweep's claim into the past, the way a stalled process would. */
function backdateSweep(id: string, minutes: number): void {
  const rows = demoRuntimeStore().automationSweeps;
  const index = rows.findIndex((row) => row.id === id);
  const sweep = rows[index];
  if (!sweep) throw new Error(`Sweep ${id} not found`);
  rows[index] = {
    ...sweep,
    startedAt: new Date(Date.now() - minutes * 60_000).toISOString(),
  };
}

/**
 * Make the next escalation write fail.
 *
 * The escalation insert is the one step of an execution unit that touches a
 * second table, so failing it is how a real technical failure mid-unit is
 * reproduced. Patching the store array's `push` (rather than the repository
 * method) fails the write itself, which is what the rollback has to survive.
 */
function injectEscalationFailure(): void {
  const rows = demoStore().escalations;
  const original = rows.push.bind(rows);
  let fired = false;
  rows.push = ((...items: Parameters<typeof original>) => {
    if (!fired) {
      fired = true;
      throw new DataError("unavailable", "Injected escalation write failure.");
    }
    return original(...items);
  }) as typeof rows.push;
}

/** Move the mention to another of the organization's locations. */
function relocateMention(locationId: string | null): void {
  const rows = demoStore().mentions;
  const index = rows.findIndex((row) => row.id === mentionId);
  const mention = rows[index];
  if (!mention) throw new Error("Fixture mention not found");
  rows[index] = { ...mention, locationId };
}

function zeroCounters(): SweepCounters {
  return {
    mentionsEvaluated: 0,
    rulesMatched: 0,
    actionsApplied: 0,
    actionsBlocked: 0,
    actionsSkipped: 0,
    actionsFailed: 0,
    retryableFailures: 0,
    terminalFailures: 0,
  };
}

function countExecutionRows(): number {
  return demoRuntimeStore().automationRuleExecutions.length;
}

function countOpenEscalations(forMentionId: string): number {
  return demoStore().escalations.filter(
    (row) => row.mentionId === forMentionId && !isEscalationClosed(row.status),
  ).length;
}

function firstRowId(): string {
  const row = demoRuntimeStore().automationRuleExecutions[0];
  if (!row) throw new Error("No execution rows recorded");
  return row.id;
}

beforeEach(async () => {
  ds = freshDataSource();
  scope = ushg.admin();

  // An active rule at revision 1. Created rather than seeded so the revision
  // the unit is asked to honour is unambiguous.
  const draft = await ds.automationRules.create(scope, {
    name: "Execution unit fixture",
    description: null,
    priority: 100,
    conditions: [{ field: "risk_level", operator: "at_least", value: "high" }],
    actions: [{ type: "escalate", assigneeUserId: null }],
  });
  await ds.automationRules.recordSimulation(scope, draft.id, draft.revision);
  const active = await ds.automationRules.setEnabled(scope, draft.id, true);
  ruleId = active.id;

  // The one seeded USHG mention that is analysed, low risk, and carries no
  // escalation — so `analyzed` is a true starting point for every case below.
  const mentions = await ds.mentions.list(scope, { statuses: ["analyzed"] });
  const subject = mentions.find((row) => row.riskLevel === "low");
  if (!subject) throw new Error("Expected a seeded analysed, low-risk mention");
  mentionId = subject.id;

  analysisId = await seedAnalysis("2026-08-01T12:00:00.000Z");
  newAnalysisId = await seedAnalysis("2026-08-01T13:00:00.000Z");
});

describe("automationSweeps.claim", () => {
  it("claims when no sweep is running and refuses a second claim", async () => {
    const first = await ds.automationSweeps.claim(scope, { mode: "dry_run" });
    expect(first.claimed).toBe(true);
    const second = await ds.automationSweeps.claim(scope, { mode: "dry_run" });
    expect(second.claimed).toBe(false);
    expect(second.sweep.id).toBe(first.sweep.id);
  });

  it("expires a running sweep older than 30 minutes and claims fresh", async () => {
    const stale = await ds.automationSweeps.claim(scope, { mode: "apply" });
    backdateSweep(stale.sweep.id, 31);

    const next = await ds.automationSweeps.claim(scope, { mode: "apply" });
    expect(next.claimed).toBe(true);
    expect(next.sweep.id).not.toBe(stale.sweep.id);

    const expired = getSweep(stale.sweep.id);
    expect(expired.status).toBe("failed");
    expect(expired.errorCode).toBe("lease_expired");
  });

  it("finalize records the status, counters, and completion", async () => {
    const claimed = await ds.automationSweeps.claim(scope, { mode: "apply" });
    const finalized = await ds.automationSweeps.finalize(scope, claimed.sweep.id, {
      status: "completed",
      counters: {
        mentionsEvaluated: 3,
        rulesMatched: 1,
        actionsApplied: 1,
        actionsBlocked: 0,
        actionsSkipped: 0,
        actionsFailed: 0,
        retryableFailures: 0,
        terminalFailures: 0,
      },
    });

    expect(finalized.status).toBe("completed");
    expect(finalized.counters.mentionsEvaluated).toBe(3);
    expect(finalized.completedAt).not.toBeNull();
    expect(finalized.errorCode).toBeNull();

    // A finalized sweep no longer holds the organization's claim.
    const next = await ds.automationSweeps.claim(scope, { mode: "apply" });
    expect(next.claimed).toBe(true);
  });
});

describe("automationRuleExecutions.executeUnit", () => {
  beforeEach(async () => {
    const claimed = await ds.automationSweeps.claim(scope, { mode: "apply" });
    sweepId = claimed.sweep.id;
  });

  it("applies a permitted set_status and records applied", async () => {
    const row = await ds.automationRuleExecutions.executeUnit(
      scope,
      unit({ actions: [{ type: "set_status", status: "monitoring" }] }),
    );

    expect(row.status).toBe("applied");
    expect(row.mode).toBe("apply");
    expect(row.outcomes).toEqual([
      { index: 0, type: "set_status", outcome: "applied", code: null },
    ]);
    expect((await ds.mentions.get(scope, mentionId))!.status).toBe("monitoring");
  });

  it("copies the mention's location onto the execution row", async () => {
    const mention = (await ds.mentions.get(scope, mentionId))!;
    const row = await ds.automationRuleExecutions.executeUnit(scope, unit({}));
    expect(row.locationId).toBe(mention.locationId);
  });

  it("replays a terminal row with zero effects", async () => {
    await ds.automationRuleExecutions.executeUnit(
      scope,
      unit({ actions: [{ type: "set_status", status: "monitoring" }] }),
    );
    const statusBefore = (await ds.mentions.get(scope, mentionId))!.status;

    const replay = await ds.automationRuleExecutions.executeUnit(
      scope,
      unit({ actions: [{ type: "set_status", status: "monitoring" }] }),
    );

    expect(replay.attemptCount).toBe(1); // untouched replay, not a retry
    expect((await ds.mentions.get(scope, mentionId))!.status).toBe(statusBefore);
    expect(countExecutionRows()).toBe(1);
  });

  it("a new trigger analysis id permits the same rule revision to run again", async () => {
    await ds.automationRuleExecutions.executeUnit(scope, unit({}));
    const again = await ds.automationRuleExecutions.executeUnit(
      scope,
      unit({ triggerAnalysisId: newAnalysisId }),
    );

    expect(again.id).not.toBe(firstRowId());
    expect(countExecutionRows()).toBe(2);
  });

  it("escalate is validated before mutation and dedupes to no_op", async () => {
    const first = await ds.automationRuleExecutions.executeUnit(
      scope,
      unit({ actions: [{ type: "escalate", assigneeUserId: null }] }),
    );
    expect(first.status).toBe("applied");
    expect((await ds.mentions.get(scope, mentionId))!.status).toBe("escalated");

    const dupe = await ds.automationRuleExecutions.executeUnit(
      scope,
      unit({
        triggerAnalysisId: newAnalysisId,
        actions: [{ type: "escalate", assigneeUserId: null }],
      }),
    );
    expect(dupe.status).toBe("no_op");
    expect(countOpenEscalations(mentionId)).toBe(1);
  });

  it("set_status can never produce escalated", async () => {
    const row = await ds.automationRuleExecutions.executeUnit(
      scope,
      unit({ actions: [{ type: "set_status", status: "escalated" }] }),
    );

    expect(row.status).toBe("blocked");
    expect(row.outcomes[0]).toMatchObject({
      outcome: "blocked",
      code: "escalation_reserved",
    });
    expect((await ds.mentions.get(scope, mentionId))!.status).toBe("analyzed");
  });

  it("records partial when one action applies and another is blocked", async () => {
    const row = await ds.automationRuleExecutions.executeUnit(
      scope,
      unit({
        actions: [
          { type: "set_status", status: "monitoring" },
          { type: "set_status", status: "escalated" },
        ],
      }),
    );

    expect(row.status).toBe("partial");
    expect(row.outcomes.map((outcome) => outcome.outcome)).toEqual([
      "applied",
      "blocked",
    ]);
    expect((await ds.mentions.get(scope, mentionId))!.status).toBe("monitoring");
  });

  it("technical failure rolls back the whole unit and records retryable failed", async () => {
    injectEscalationFailure(); // make the escalation write throw once

    const row = await ds.automationRuleExecutions.executeUnit(
      scope,
      unit({
        actions: [
          { type: "set_status", status: "monitoring" },
          { type: "escalate", assigneeUserId: null },
        ],
      }),
    );

    expect(row.status).toBe("failed");
    expect(row.errorClass).toBe("retryable");
    expect(row.lastErrorCode).not.toBeNull();
    // The earlier set_status rolled back with the unit:
    expect((await ds.mentions.get(scope, mentionId))!.status).toBe("analyzed");
    expect(countOpenEscalations(mentionId)).toBe(0);
    // A failure claims no outcomes: the effects it would describe do not exist.
    expect(row.outcomes).toEqual([]);
  });

  it("retry after a retryable failure re-runs from committed state", async () => {
    injectEscalationFailure();
    await ds.automationRuleExecutions.executeUnit(
      scope,
      unit({ actions: [{ type: "escalate", assigneeUserId: null }] }),
    );

    const retried = await ds.automationRuleExecutions.executeUnit(
      scope,
      unit({ actions: [{ type: "escalate", assigneeUserId: null }] }),
    );

    expect(retried.status).toBe("applied");
    expect(retried.attemptCount).toBe(2);
    expect(countExecutionRows()).toBe(1);
    expect((await ds.mentions.get(scope, mentionId))!.status).toBe("escalated");
    // Success clears the previous attempt's diagnosis. A row that succeeded
    // while still carrying an error class reads as a failure in the history,
    // and the G1 RPC's SUCCESS update has to null the same two columns.
    expect(retried.errorClass).toBeNull();
    expect(retried.lastErrorCode).toBeNull();
  });

  it("a retry keeps the unit's first sweep and follows the mention's location", async () => {
    injectEscalationFailure();
    const escalate = unit({ actions: [{ type: "escalate", assigneeUserId: null }] });
    const failed = await ds.automationRuleExecutions.executeUnit(scope, escalate);
    expect(failed.status).toBe("failed");
    expect(failed.locationId).not.toBeNull();

    // A later sweep picks the unit up, and the mention has moved location in
    // the meantime. The sweep the unit began in may not be rewritten (`on
    // conflict do nothing` discards the retrying caller's sweep id), but the
    // location must follow the mention: `execs_location_is_mentions` is `on
    // update cascade`, so the stored row's location tracks the mention's
    // current assignment (spec §5).
    await ds.automationSweeps.finalize(scope, sweepId, {
      status: "completed",
      counters: zeroCounters(),
    });
    const later = await ds.automationSweeps.claim(scope, { mode: "apply" });
    const elsewhere = (await ds.locations.list(scope)).find(
      (row) => row.id !== failed.locationId,
    );
    if (!elsewhere) throw new Error("Expected a second seeded location");
    relocateMention(elsewhere.id);

    const retried = await ds.automationRuleExecutions.executeUnit(scope, {
      ...escalate,
      sweepId: later.sweep.id,
    });

    expect(retried.attemptCount).toBe(2);
    expect(retried.sweepId).toBe(sweepId);
    expect(retried.locationId).toBe(elsewhere.id);
    expect(retried.locationId).not.toBe(failed.locationId);
    expect(countExecutionRows()).toBe(1);
  });

  it("escalating a mention that already has a case dedupes to no_op", async () => {
    // A person raised the case and later re-triaged the mention back to
    // monitoring, so the matrix says escalation is eligible and only the
    // dedupe stands between the rule and a second case for one mention.
    await ds.escalations.create(scope, {
      mentionId,
      category: "other",
      severity: "medium",
      title: "Raised by a person",
      summary: null,
      dueAt: null,
    });
    await ds.mentions.updateStatus(scope, mentionId, "monitoring");
    const escalationsBefore = demoStore().escalations.length;

    const row = await ds.automationRuleExecutions.executeUnit(
      scope,
      unit({ actions: [{ type: "escalate", assigneeUserId: null }] }),
    );

    expect(row.status).toBe("no_op");
    expect(row.outcomes[0]).toMatchObject({
      type: "escalate",
      outcome: "no_op",
      code: "escalation_exists",
    });
    expect((await ds.mentions.get(scope, mentionId))!.status).toBe("monitoring");
    expect(demoStore().escalations.length).toBe(escalationsBefore);
  });

  it("stops retrying at the attempt cap", async () => {
    const failing = unit({ actions: [{ type: "escalate", assigneeUserId: null }] });
    for (let attempt = 0; attempt < 3; attempt += 1) {
      injectEscalationFailure();
      await ds.automationRuleExecutions.executeUnit(scope, failing);
    }

    const capped = await ds.automationRuleExecutions.executeUnit(scope, failing);
    expect(capped.status).toBe("failed");
    expect(capped.attemptCount).toBe(3);
    expect((await ds.mentions.get(scope, mentionId))!.status).toBe("analyzed");
  });

  it("stale revision fails terminally before any mutation", async () => {
    const row = await ds.automationRuleExecutions.executeUnit(
      scope,
      unit({ ruleRevision: 999 }),
    );

    expect(row.status).toBe("failed");
    expect(row.errorClass).toBe("terminal");
    expect(row.lastErrorCode).toBe("rule_changed");
    expect((await ds.mentions.get(scope, mentionId))!.status).toBe("analyzed");
  });

  it("a malformed action fails terminally with invalid_action", async () => {
    const row = await ds.automationRuleExecutions.executeUnit(
      scope,
      unit({
        // Deliberately not a RuleAction: the snapshot could carry anything a
        // past revision stored, and validation is what stops it executing.
        actions: [{ type: "set_status", status: "not_a_status" }] as never,
      }),
    );

    expect(row.status).toBe("failed");
    expect(row.errorClass).toBe("terminal");
    expect(row.lastErrorCode).toBe("invalid_action");
    expect((await ds.mentions.get(scope, mentionId))!.status).toBe("analyzed");
  });

  it("an action Lia cannot execute yet is blocked, never silently applied", async () => {
    const row = await ds.automationRuleExecutions.executeUnit(
      scope,
      unit({ actions: [{ type: "notify", channel: "email" }] }),
    );

    expect(row.status).toBe("blocked");
    expect(row.outcomes[0]).toMatchObject({ type: "notify", outcome: "blocked" });
  });
});

describe("automationRuleExecutions.recordProjection", () => {
  beforeEach(async () => {
    const claimed = await ds.automationSweeps.claim(scope, { mode: "dry_run" });
    sweepId = claimed.sweep.id;
  });

  it("inserts a dry-run row and mutates nothing else", async () => {
    const before = {
      status: (await ds.mentions.get(scope, mentionId))!.status,
      escalations: demoStore().escalations.length,
      audit: demoStore().auditEvents.length,
    };

    const row = await ds.automationRuleExecutions.recordProjection(scope, {
      ...unit({ actions: [{ type: "set_status", status: "monitoring" }] }),
      status: "would_apply",
      outcomes: [
        { index: 0, type: "set_status", outcome: "would_apply", code: null },
      ],
    });

    expect(row.mode).toBe("dry_run");
    expect(row.status).toBe("would_apply");
    expect((await ds.mentions.get(scope, mentionId))!.status).toBe(before.status);
    expect(demoStore().escalations.length).toBe(before.escalations);
    expect(demoStore().auditEvents.length).toBe(before.audit);
  });

  it("lists a rule's executions newest first", async () => {
    await ds.automationRuleExecutions.recordProjection(scope, {
      ...unit({}),
      status: "would_apply",
      outcomes: [],
    });

    const rows = await ds.automationRuleExecutions.listForRule(scope, ruleId, 10);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.automationRuleId).toBe(ruleId);
  });
});

describe("markActivity", () => {
  it("is monotonic: an older stamp never overwrites a newer one", async () => {
    await ds.automationRules.markActivity(scope, ruleId, {
      at: "2026-08-11T10:00:00.000Z",
      matched: true,
      applied: true,
    });
    await ds.automationRules.markActivity(scope, ruleId, {
      at: "2026-08-11T09:00:00.000Z",
      matched: true,
      applied: true,
    });

    const rule = (await ds.automationRules.get(scope, ruleId))!;
    expect(rule.lastAppliedAt).toBe("2026-08-11T10:00:00.000Z");
    expect(rule.lastMatchedAt).toBe("2026-08-11T10:00:00.000Z");
    expect(rule.lastEvaluatedAt).toBe("2026-08-11T10:00:00.000Z");
  });

  it("advances evaluated without claiming a match or an application", async () => {
    await ds.automationRules.markActivity(scope, ruleId, {
      at: "2026-08-11T10:00:00.000Z",
      matched: false,
      applied: false,
    });

    const rule = (await ds.automationRules.get(scope, ruleId))!;
    expect(rule.lastEvaluatedAt).toBe("2026-08-11T10:00:00.000Z");
    expect(rule.lastMatchedAt).toBeNull();
    expect(rule.lastAppliedAt).toBeNull();
  });
});
