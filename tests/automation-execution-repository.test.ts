import { beforeEach, describe, expect, it } from "vitest";
import { freshDataSource, ushg } from "./helpers/scope";
import { demoRuntimeStore, demoStore } from "@/lib/data/demo/store";
import { DataError } from "@/lib/data/errors";
import type { ExecuteUnitInput, LiaDataSource, OrganizationScope } from "@/lib/data/types";
import { mapEscalationRefusal } from "@/lib/rules/transitions";
import {
  isEscalationClosed,
  type AuditEvent,
  type AutomationRule,
  type AutomationSweep,
  type MentionAnalysis,
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

/**
 * An analysis row for the mention, so `triggerAnalysisId` names a real
 * occurrence — which the escalation contract requires: an escalate action
 * whose occurrence is not an analysis of its own mention is refused.
 *
 * Each call is its own analysis event, hence its own run id.
 */
async function seedAnalysis(
  analyzedAt: string,
  riskCategories: MentionAnalysis["riskCategories"] = [],
): Promise<string> {
  const created = await ds.mentions.createAnalysis(scope, {
    mentionId,
    analysisRunId: crypto.randomUUID(),
    modelProvider: "lia",
    modelName: "rating-heuristic",
    promptVersion: "test-1",
    relevanceScore: 0.8,
    relevanceExplanation: null,
    sentiment: "mixed",
    sentimentScore: 0,
    riskLevel: "low",
    riskCategories,
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
 * A unit names a rule, a revision, a mention, and an occurrence — never a list
 * of actions. What runs is whatever the *stored* revision says, which is why
 * every test below that cares about actions writes them to the rule first.
 */
function unit(overrides: Partial<ExecuteUnitInput> = {}): ExecuteUnitInput {
  return {
    sweepId,
    automationRuleId: ruleId,
    ruleRevision: 1,
    mentionId,
    triggerAnalysisId: analysisId,
    ...overrides,
  };
}

/**
 * Rewrite the stored rule's actions in place, leaving its revision alone.
 *
 * Written straight to the store rather than through `automationRules.update`
 * because that path re-validates and bumps the revision, and half of what is
 * under test here is what happens when the stored revision carries something
 * the authoring path would never have accepted — a past schema, a hand-edited
 * row, a partially migrated column.
 */
function setStoredActions(actions: unknown): void {
  const rows = demoStore().automationRules;
  const index = rows.findIndex((row) => row.id === ruleId);
  const rule = rows[index];
  if (!rule) throw new Error("Fixture rule not found");
  rows[index] = { ...rule, actions: actions as AutomationRule["actions"] };
}

/** Move the stored rule to another revision, keeping it active. */
function setStoredRevision(revision: number): void {
  const rows = demoStore().automationRules;
  const index = rows.findIndex((row) => row.id === ruleId);
  const rule = rows[index];
  if (!rule) throw new Error("Fixture rule not found");
  rows[index] = { ...rule, revision };
}

function auditEventsOfType(eventType: AuditEvent["eventType"]): AuditEvent[] {
  return demoStore().auditEvents.filter((row) => row.eventType === eventType);
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
    setStoredActions([{ type: "set_status", status: "monitoring" }]);
    const row = await ds.automationRuleExecutions.executeUnit(scope, unit());

    expect(row.status).toBe("applied");
    expect(row.mode).toBe("apply");
    expect(row.outcomes).toEqual([
      { index: 0, type: "set_status", outcome: "applied", code: null },
    ]);
    expect((await ds.mentions.get(scope, mentionId))!.status).toBe("monitoring");
  });

  it("copies the mention's location onto the execution row", async () => {
    setStoredActions([{ type: "set_status", status: "monitoring" }]);
    const mention = (await ds.mentions.get(scope, mentionId))!;
    const row = await ds.automationRuleExecutions.executeUnit(scope, unit({}));
    expect(row.locationId).toBe(mention.locationId);
  });

  it("replays a terminal row with zero effects", async () => {
    setStoredActions([{ type: "set_status", status: "monitoring" }]);
    await ds.automationRuleExecutions.executeUnit(scope, unit());
    const statusBefore = (await ds.mentions.get(scope, mentionId))!.status;

    const replay = await ds.automationRuleExecutions.executeUnit(scope, unit());

    expect(replay.attemptCount).toBe(1); // untouched replay, not a retry
    expect((await ds.mentions.get(scope, mentionId))!.status).toBe(statusBefore);
    expect(countExecutionRows()).toBe(1);
  });

  it("a new trigger analysis id permits the same rule revision to run again", async () => {
    setStoredActions([{ type: "set_status", status: "monitoring" }]);
    await ds.automationRuleExecutions.executeUnit(scope, unit({}));
    const again = await ds.automationRuleExecutions.executeUnit(
      scope,
      unit({ triggerAnalysisId: newAnalysisId }),
    );

    expect(again.id).not.toBe(firstRowId());
    expect(countExecutionRows()).toBe(2);
  });

  it("escalate is validated before mutation and dedupes to no_op", async () => {
    const first = await ds.automationRuleExecutions.executeUnit(scope, unit());
    expect(first.status).toBe("applied");
    expect((await ds.mentions.get(scope, mentionId))!.status).toBe("escalated");

    const dupe = await ds.automationRuleExecutions.executeUnit(
      scope,
      unit({ triggerAnalysisId: newAnalysisId }),
    );
    expect(dupe.status).toBe("no_op");
    expect(countOpenEscalations(mentionId)).toBe(1);
  });

  it("set_status can never produce escalated", async () => {
    setStoredActions([{ type: "set_status", status: "escalated" }]);
    const row = await ds.automationRuleExecutions.executeUnit(scope, unit());

    expect(row.status).toBe("blocked");
    expect(row.outcomes[0]).toMatchObject({
      outcome: "blocked",
      code: "escalation_reserved",
    });
    expect((await ds.mentions.get(scope, mentionId))!.status).toBe("analyzed");
  });

  it("records partial when one action applies and another is blocked", async () => {
    setStoredActions([
      { type: "set_status", status: "monitoring" },
      { type: "set_status", status: "escalated" },
    ]);
    const row = await ds.automationRuleExecutions.executeUnit(scope, unit());

    expect(row.status).toBe("partial");
    expect(row.outcomes.map((outcome) => outcome.outcome)).toEqual([
      "applied",
      "blocked",
    ]);
    expect((await ds.mentions.get(scope, mentionId))!.status).toBe("monitoring");
  });

  it("technical failure rolls back the whole unit and records retryable failed", async () => {
    setStoredActions([
      { type: "set_status", status: "monitoring" },
      { type: "escalate", assigneeUserId: null },
    ]);
    injectEscalationFailure(); // make the escalation write throw once

    const row = await ds.automationRuleExecutions.executeUnit(scope, unit());

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
    await ds.automationRuleExecutions.executeUnit(scope, unit());

    const retried = await ds.automationRuleExecutions.executeUnit(scope, unit());

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
    const escalate = unit();
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
    // A case was raised off a different occurrence and later the mention was
    // re-triaged back to monitoring, so the matrix says escalation is eligible
    // and only the contract's open-case dedupe stands between the rule and a
    // second case for one mention.
    await ds.escalations.create(scope, {
      mentionId,
      category: "other",
      severity: "medium",
      title: "Raised by a person",
      summary: null,
      dueAt: null,
      triggerAnalysisId: newAnalysisId,
    });
    await ds.mentions.updateStatus(scope, mentionId, "monitoring");
    const escalationsBefore = demoStore().escalations.length;

    const row = await ds.automationRuleExecutions.executeUnit(scope, unit());

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
    const failing = unit();
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

  it("an action Lia cannot execute yet is blocked, never silently applied", async () => {
    setStoredActions([{ type: "notify", channel: "email" }]);
    const row = await ds.automationRuleExecutions.executeUnit(scope, unit());

    expect(row.status).toBe("blocked");
    expect(row.outcomes[0]).toMatchObject({ type: "notify", outcome: "blocked" });
  });

  /**
   * The unit executes the STORED revision, not the caller's idea of it.
   *
   * A sweep names a rule and a revision; the actions come from the row. So the
   * question these tests ask is what happens when the row carries something the
   * authoring path would never have produced — a column written by an older
   * schema, a hand-edited record, a half-finished migration. The answer is one
   * answer for every shape: terminal `invalid_action`, decided before anything
   * is touched, because a list that cannot be understood cannot be partially
   * obeyed either.
   */
  describe("stored-action validation", () => {
    const malformed: [string, unknown][] = [
      ["generate_draft without voiceProfile", { type: "generate_draft" }],
      [
        "generate_draft whose voiceProfile is not a string",
        { type: "generate_draft", voiceProfile: 12 },
      ],
      [
        "generate_draft whose voiceProfile is over 80 characters",
        { type: "generate_draft", voiceProfile: "x".repeat(81) },
      ],
      ["require_approval without approverUserId", { type: "require_approval" }],
      [
        "require_approval whose approverUserId is not a uuid",
        { type: "require_approval", approverUserId: "somebody" },
      ],
      ["assign without assigneeUserId", { type: "assign" }],
      [
        "assign whose assigneeUserId is not a uuid",
        { type: "assign", assigneeUserId: 7 },
      ],
      ["escalate without assigneeUserId", { type: "escalate" }],
      [
        "escalate whose assigneeUserId is not a uuid",
        { type: "escalate", assigneeUserId: "nobody" },
      ],
      ["notify without a channel", { type: "notify" }],
      ["notify whose channel is null", { type: "notify", channel: null }],
      [
        "notify whose channel is outside the vocabulary",
        { type: "notify", channel: "sms" },
      ],
      ["tag without a label", { type: "tag" }],
      ["tag whose label is empty", { type: "tag", label: "" }],
      ["tag whose label is over 80 characters", { type: "tag", label: "x".repeat(81) }],
      ["set_status without a status", { type: "set_status" }],
      [
        "set_status outside the mention_status vocabulary",
        { type: "set_status", status: "not_a_status" },
      ],
      ["an action with no type at all", { voiceProfile: null }],
      ["an action type nothing knows about", { type: "publish_to_tiktok" }],
    ];

    it.each(malformed)("%s fails terminally before any mutation", async (_name, action) => {
      setStoredActions([action]);

      const row = await ds.automationRuleExecutions.executeUnit(scope, unit());

      expect(row.status).toBe("failed");
      expect(row.errorClass).toBe("terminal");
      expect(row.lastErrorCode).toBe("invalid_action");
      expect(row.outcomes).toEqual([]);
      expect((await ds.mentions.get(scope, mentionId))!.status).toBe("analyzed");
      expect(countOpenEscalations(mentionId)).toBe(0);
    });

    it("refuses a valid action list that follows a malformed one", async () => {
      // The malformed element is second: validation is a property of the whole
      // list, so the executable action ahead of it must not run either.
      setStoredActions([
        { type: "set_status", status: "monitoring" },
        { type: "notify", channel: "carrier_pigeon" },
      ]);

      const row = await ds.automationRuleExecutions.executeUnit(scope, unit());

      expect(row.lastErrorCode).toBe("invalid_action");
      expect((await ds.mentions.get(scope, mentionId))!.status).toBe("analyzed");
    });

    it("ignores unknown fields on an otherwise valid action", async () => {
      // Zod strips unknown keys, and the SQL validator checks only the fields
      // the type declares. `auto_publish` is the shape that proves it: a type
      // and nothing else, so anything extra is by definition unknown. It is
      // valid, and then separately refused for not being wired to an effect.
      setStoredActions([
        { type: "auto_publish", tone: "friendly", maxLength: 400, dryRun: true },
      ]);

      const row = await ds.automationRuleExecutions.executeUnit(scope, unit());

      expect(row.status).toBe("blocked");
      expect(row.lastErrorCode).toBeNull();
      expect(row.outcomes).toEqual([
        {
          index: 0,
          type: "auto_publish",
          outcome: "blocked",
          code: "action_not_executable",
        },
      ]);
    });

    it("treats a null actions column as invalid rather than as no actions", async () => {
      setStoredActions(null);

      const row = await ds.automationRuleExecutions.executeUnit(scope, unit());

      expect(row.status).toBe("failed");
      expect(row.lastErrorCode).toBe("invalid_action");
    });

    it("treats a non-array actions column as invalid", async () => {
      setStoredActions({ type: "set_status", status: "monitoring" });

      const row = await ds.automationRuleExecutions.executeUnit(scope, unit());

      expect(row.status).toBe("failed");
      expect(row.lastErrorCode).toBe("invalid_action");
    });

    it("an empty action list is a valid unit that does nothing", async () => {
      // An empty list is well-formed — a rule may legitimately have had its
      // actions removed — so it is a `no_op` with no outcomes, not a failure.
      setStoredActions([]);
      const escalationsBefore = demoStore().escalations.length;

      const row = await ds.automationRuleExecutions.executeUnit(scope, unit());

      expect(row.status).toBe("no_op");
      expect(row.outcomes).toEqual([]);
      expect(row.errorClass).toBeNull();
      expect(row.lastErrorCode).toBeNull();
      expect((await ds.mentions.get(scope, mentionId))!.status).toBe("analyzed");
      expect(demoStore().escalations.length).toBe(escalationsBefore);
    });
  });

  /**
   * What a case raised by a rule says about itself.
   *
   * Three fields, and none of them decorative. The **category** is routing
   * data — it decides which queue and which severity filter a person finds
   * this in — so it comes from the occurrence's own classification, never a
   * hardcoded default. The **title** is what a reader sees in the list, in
   * sentence case, naming the location when there is one. The **summary**
   * names the rule, because somebody opening a case Lia raised has to be able
   * to tell why it exists without guessing. The G1 RPC builds the same three
   * from the same sources; pinning them here is what the SQL is held to.
   */
  describe("the case a rule raises", () => {
    it("carries the occurrence's category, a located title, and the rule's name", async () => {
      const occurrence = await seedAnalysis("2026-08-01T14:00:00.000Z", [
        "food_safety",
      ]);
      const mention = (await ds.mentions.get(scope, mentionId))!;
      const location = (await ds.locations.list(scope)).find(
        (row) => row.id === mention.locationId,
      );
      if (!location) throw new Error("Expected the fixture mention to be located");

      const row = await ds.automationRuleExecutions.executeUnit(
        scope,
        unit({ triggerAnalysisId: occurrence }),
      );
      expect(row.status).toBe("applied");

      const raised = demoStore().escalations.find(
        (escalation) => escalation.triggerAnalysisId === occurrence,
      );
      expect(raised).toBeDefined();
      // Not `other`: the classification that authorized the rule is the one
      // that routes the case.
      expect(raised!.category).toBe("food_safety");
      expect(raised!.severity).toBe(mention.riskLevel);
      // Sentence case, and the underscore spelled out as a space.
      expect(raised!.title).toBe(`Food safety risk at ${location.name}`);
      expect(raised!.summary).toBe(
        'Raised automatically by the rule "Execution unit fixture".',
      );
    });

    it("drops the location clause when the mention has none", async () => {
      const occurrence = await seedAnalysis("2026-08-01T15:00:00.000Z", [
        "food_safety",
      ]);
      relocateMention(null);

      await ds.automationRuleExecutions.executeUnit(
        scope,
        unit({ triggerAnalysisId: occurrence }),
      );

      const raised = demoStore().escalations.find(
        (escalation) => escalation.triggerAnalysisId === occurrence,
      );
      expect(raised!.title).toBe("Food safety risk");
    });

    it("falls back to `other` when the occurrence classified no risk category", async () => {
      const row = await ds.automationRuleExecutions.executeUnit(scope, unit());
      expect(row.status).toBe("applied");

      const raised = demoStore().escalations.find(
        (escalation) => escalation.triggerAnalysisId === analysisId,
      );
      expect(raised!.category).toBe("other");
      expect(raised!.title).toMatch(/^Other risk/);
    });
  });

  /**
   * The escalation contract answers in its own vocabulary; the execution row
   * speaks the outcome vocabulary. `mapEscalationRefusal` is the boundary, and
   * it is exported so both sides of it can be pinned.
   */
  describe("escalation refusal mapping", () => {
    it("maps every refusal reason into the outcome vocabulary", () => {
      expect(mapEscalationRefusal("occurrence_replayed")).toEqual({
        outcome: "no_op",
        code: "escalation_exists",
      });
      expect(mapEscalationRefusal("escalation_exists")).toEqual({
        outcome: "no_op",
        code: "escalation_exists",
      });
      // Hard refusals. Both are unreachable behind the transition matrix — it
      // blocks `dismissed` and no-ops `escalated` before the ladder is asked —
      // so this mapping is defensive, and deliberately does not invent a code
      // outside the pinned set to say so.
      expect(mapEscalationRefusal("mention_dismissed")).toEqual({
        outcome: "blocked",
        code: "forbidden_transition",
      });
      expect(mapEscalationRefusal("awaiting_retriage")).toEqual({
        outcome: "blocked",
        code: "forbidden_transition",
      });
    });

    it("reports a replayed occurrence as escalation_exists, not as a second case", async () => {
      // The case this occurrence already produced, later resolved, and the
      // mention re-triaged — so neither the matrix nor the open-case dedupe is
      // what refuses here. Only the replay arm is left.
      const raised = await ds.escalations.create(scope, {
        mentionId,
        category: "other",
        severity: "medium",
        title: "Raised off this very occurrence",
        summary: null,
        dueAt: null,
        triggerAnalysisId: analysisId,
      });
      await ds.escalations.updateStatus(
        scope,
        raised.escalation!.id,
        "resolved",
        "Spoke to the guest.",
      );
      await ds.mentions.updateStatus(scope, mentionId, "monitoring");

      // A new revision, so the unit is not itself a replay of an execution row
      // — the replay under test is the occurrence's, inside the contract.
      setStoredRevision(2);
      const row = await ds.automationRuleExecutions.executeUnit(
        scope,
        unit({ ruleRevision: 2 }),
      );

      expect(row.status).toBe("no_op");
      expect(row.outcomes).toEqual([
        { index: 0, type: "escalate", outcome: "no_op", code: "escalation_exists" },
      ]);
      // The replay reported history; it did not reopen or restate it.
      expect(demoStore().escalations.filter((e) => e.mentionId === mentionId)).toHaveLength(1);
      expect((await ds.mentions.get(scope, mentionId))!.status).toBe("monitoring");
    });
  });

  /**
   * A unit belongs to the sweep that opened it, and is attempted by whichever
   * sweep is running now. When a retry crosses a sweep boundary those are two
   * different sweeps, and the audit trail has to name both — one answers "where
   * did this unit come from", the other "who ran it".
   */
  describe("audit trail", () => {
    it("names the origin and attempt sweeps on a cross-sweep retry", async () => {
      injectEscalationFailure();
      const failed = await ds.automationRuleExecutions.executeUnit(scope, unit());
      expect(failed.status).toBe("failed");

      const failure = auditEventsOfType("automation_rule.execution_failed");
      expect(failure).toHaveLength(1);
      expect(failure[0]!.entityType).toBe("automation_rule");
      expect(failure[0]!.entityId).toBe(ruleId);
      expect(failure[0]!.metadata).toMatchObject({
        // The first attempt ran in the sweep that opened the unit, so both
        // names point at the same sweep here.
        originSweepId: sweepId,
        attemptSweepId: sweepId,
        mentionId,
        analysisId: analysisId,
      });

      await ds.automationSweeps.finalize(scope, sweepId, {
        status: "completed",
        counters: zeroCounters(),
      });
      const later = await ds.automationSweeps.claim(scope, { mode: "apply" });

      const retried = await ds.automationRuleExecutions.executeUnit(scope, {
        ...unit(),
        sweepId: later.sweep.id,
      });
      expect(retried.status).toBe("applied");

      const executed = auditEventsOfType("automation_rule.executed");
      expect(executed).toHaveLength(1);
      expect(executed[0]!.actorType).toBe("system");
      expect(executed[0]!.metadata).toMatchObject({
        originSweepId: sweepId,
        attemptSweepId: later.sweep.id,
        mentionId,
        analysisId: analysisId,
        status: "applied",
        applied: 1,
        blocked: 0,
        noOp: 0,
      });
      expect(later.sweep.id).not.toBe(sweepId);
    });

    it("writes no executed event for a unit that never reached its actions", async () => {
      const row = await ds.automationRuleExecutions.executeUnit(
        scope,
        unit({ ruleRevision: 999 }),
      );

      expect(row.lastErrorCode).toBe("rule_changed");
      // Nothing was executed and nothing failed technically: the execution row
      // itself is the whole record of a unit refused before it began.
      expect(auditEventsOfType("automation_rule.executed")).toHaveLength(0);
      expect(auditEventsOfType("automation_rule.execution_failed")).toHaveLength(0);
    });
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
      ...unit(),
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
