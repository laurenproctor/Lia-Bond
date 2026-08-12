import { describe, expect, it } from "vitest";
import {
  describeActionOutcome,
  describeRowFailure,
  describeRowOutcomes,
  DRY_RUN_FRAMING_MESSAGE,
  EXECUTION_MODE_LABELS,
  executionHistoryFraming,
  executionStatusLabel,
  NO_EXECUTIONS_MESSAGE,
  RULES_EXECUTION_OFF_MESSAGE,
} from "@/lib/rules/execution-history";
import type { AutomationRuleExecution, ExecutionActionOutcome } from "@/domain";

/**
 * TDD for the rule detail page's execution history section (Task 12).
 *
 * `execution-history.tsx` is a thin, untested renderer over this module —
 * consistent with `readiness-checklist.tsx` sitting over `readiness.ts` — so
 * every state, every outcome code, and the projection-vs-applied distinction
 * are pinned here in plain Vitest rather than through component rendering,
 * which this suite has no harness for (node environment, no DOM).
 */

const BASE: AutomationRuleExecution = {
  id: "11111111-1111-1111-1111-111111111111",
  organizationId: "22222222-2222-2222-2222-222222222222",
  sweepId: "33333333-3333-3333-3333-333333333333",
  automationRuleId: "44444444-4444-4444-4444-444444444444",
  ruleRevision: 1,
  mentionId: "55555555-5555-5555-5555-555555555555",
  triggerAnalysisId: "66666666-6666-6666-6666-666666666666",
  locationId: null,
  mode: "apply",
  status: "applied",
  outcomes: [{ index: 0, type: "escalate", outcome: "applied", code: null }],
  outcomeSchemaVersion: 1,
  attemptCount: 1,
  lastErrorCode: null,
  errorClass: null,
  startedAt: "2026-08-01T12:00:00.000Z",
  completedAt: "2026-08-01T12:00:01.000Z",
};

function execution(overrides: Partial<AutomationRuleExecution>): AutomationRuleExecution {
  return { ...BASE, ...overrides };
}

function outcome(overrides: Partial<ExecutionActionOutcome>): ExecutionActionOutcome {
  return { index: 0, type: "escalate", outcome: "applied", code: null, ...overrides };
}

describe("copy constants", () => {
  it("the off-mode message is exact", () => {
    expect(RULES_EXECUTION_OFF_MESSAGE).toBe(
      "Rule execution is off — rules are not yet applied to mentions.",
    );
  });

  it("the no-executions message is exact", () => {
    expect(NO_EXECUTIONS_MESSAGE).toBe("No executions yet.");
  });

  it("the dry-run framing message is exact", () => {
    expect(DRY_RUN_FRAMING_MESSAGE).toBe("Dry run only — nothing is applied yet");
  });
});

describe("executionHistoryFraming", () => {
  it("is null for off", () => {
    expect(executionHistoryFraming("off")).toBeNull();
  });

  it("is null for apply — an apply row already reads as applied, nothing more to add", () => {
    expect(executionHistoryFraming("apply")).toBeNull();
  });

  it("is the dry-run framing message for dry_run", () => {
    expect(executionHistoryFraming("dry_run")).toBe(DRY_RUN_FRAMING_MESSAGE);
  });
});

describe("EXECUTION_MODE_LABELS", () => {
  it('dry_run reads "Projection" — never a word that could read as an applied action', () => {
    expect(EXECUTION_MODE_LABELS.dry_run).toBe("Projection");
    expect(EXECUTION_MODE_LABELS.dry_run.toLowerCase()).not.toContain("applied");
  });

  it('apply reads "Applied"', () => {
    expect(EXECUTION_MODE_LABELS.apply).toBe("Applied");
  });
});

describe("executionStatusLabel", () => {
  it("renders apply-mode statuses in sentence case", () => {
    expect(executionStatusLabel("applied")).toBe("Applied");
    expect(executionStatusLabel("partial")).toBe("Partial");
    expect(executionStatusLabel("blocked")).toBe("Blocked");
    expect(executionStatusLabel("failed")).toBe("Failed");
    expect(executionStatusLabel("no_op")).toBe("No change");
  });

  it("renders dry-run statuses distinctly from their apply-mode twins", () => {
    expect(executionStatusLabel("would_apply")).toBe("Would apply");
    expect(executionStatusLabel("would_apply")).not.toBe(executionStatusLabel("applied"));
    expect(executionStatusLabel("would_partial")).toBe("Would partially apply");
    expect(executionStatusLabel("would_block")).toBe("Would block");
    expect(executionStatusLabel("would_no_op")).toBe("Would not change anything");
    expect(executionStatusLabel("would_fail_validation")).toBe("Would fail validation");
  });
});

describe("describeActionOutcome — blocked codes, copy exact", () => {
  it("escalation_reserved", () => {
    expect(describeActionOutcome(outcome({ outcome: "blocked", code: "escalation_reserved" }))).toBe(
      "blocked: escalation is reserved for the escalate action",
    );
  });

  it("high_risk_guardrail", () => {
    expect(describeActionOutcome(outcome({ outcome: "blocked", code: "high_risk_guardrail" }))).toBe(
      "blocked: high-risk mentions cannot be moved to a resting state",
    );
  });

  it("forbidden_transition", () => {
    expect(describeActionOutcome(outcome({ outcome: "blocked", code: "forbidden_transition" }))).toBe(
      "blocked: transition not permitted",
    );
  });

  it("the same codes read identically off a dry-run would_block outcome", () => {
    expect(
      describeActionOutcome(outcome({ outcome: "would_block", code: "escalation_reserved" })),
    ).toBe("blocked: escalation is reserved for the escalate action");
  });
});

describe("describeActionOutcome — no-op, copy exact", () => {
  it('a no_op with no code reads "no change: already true"', () => {
    expect(describeActionOutcome(outcome({ outcome: "no_op", code: null }))).toBe(
      "no change: already true",
    );
  });

  it('a would_no_op with no code reads the same "no change: already true"', () => {
    expect(describeActionOutcome(outcome({ outcome: "would_no_op", code: null }))).toBe(
      "no change: already true",
    );
  });

  it("a no_op with escalation_exists is distinguished from the plain already-true case", () => {
    const text = describeActionOutcome(outcome({ outcome: "no_op", code: "escalation_exists" }));
    expect(text).not.toBe("no change: already true");
    expect(text.toLowerCase()).toContain("no change");
    expect(text.toLowerCase()).toContain("escalation");
  });
});

describe("describeActionOutcome — sensible renderings for the remaining named codes", () => {
  it("action_not_executable reads as blocked", () => {
    const text = describeActionOutcome(outcome({ outcome: "blocked", code: "action_not_executable" }));
    expect(text.toLowerCase().startsWith("blocked:")).toBe(true);
  });

  it("an unrecognised code still renders, sentence case, never throws", () => {
    const text = describeActionOutcome(outcome({ outcome: "blocked", code: "some_future_code" }));
    expect(text).toBe("blocked: some future code");
  });
});

describe("describeActionOutcome — applied vs would_apply, never conflated", () => {
  it('applied with no code reads "applied"', () => {
    expect(describeActionOutcome(outcome({ outcome: "applied", code: null }))).toBe("applied");
  });

  it('would_apply with no code reads "would apply", never "applied"', () => {
    const text = describeActionOutcome(outcome({ outcome: "would_apply", code: null }));
    expect(text).toBe("would apply");
    expect(text).not.toBe("applied");
  });
});

describe("describeRowFailure — row-level terminal codes", () => {
  it("rule_changed", () => {
    expect(describeRowFailure("rule_changed")).toBe("failed: the rule changed since this was queued");
  });

  it("invalid_action", () => {
    expect(describeRowFailure("invalid_action")).toBe("failed: the action list failed validation");
  });

  it("an unrecognised row-level code still renders", () => {
    expect(describeRowFailure("mystery_code")).toBe("failed: mystery code");
  });
});

describe("describeRowOutcomes", () => {
  it("labels each action outcome with its action type, in order", () => {
    const row = execution({
      outcomes: [
        outcome({ index: 0, type: "escalate", outcome: "blocked", code: "escalation_reserved" }),
        outcome({ index: 1, type: "set_status", outcome: "no_op", code: null }),
      ],
    });

    const lines = describeRowOutcomes(row).map((line) => line.text);
    expect(lines).toEqual([
      "Escalate for a person to handle: blocked: escalation is reserved for the escalate action",
      "Set the mention's status: no change: already true",
    ]);
  });

  it("keys are stable and unique per outcome", () => {
    const row = execution({
      outcomes: [
        outcome({ index: 0, type: "escalate", outcome: "applied", code: null }),
        outcome({ index: 1, type: "set_status", outcome: "applied", code: null }),
      ],
    });
    const keys = describeRowOutcomes(row).map((line) => line.key);
    expect(new Set(keys).size).toBe(2);
  });

  it("falls back to the row's lastErrorCode when outcomes is empty (a terminal validation failure)", () => {
    const row = execution({
      mode: "apply",
      status: "failed",
      outcomes: [],
      lastErrorCode: "rule_changed",
      errorClass: "terminal",
    });

    expect(describeRowOutcomes(row)).toEqual([
      { key: `${row.id}-row`, text: "failed: the rule changed since this was queued" },
    ]);
  });

  it("returns an empty list when there is neither an outcome nor a row-level error", () => {
    const row = execution({ outcomes: [], lastErrorCode: null });
    expect(describeRowOutcomes(row)).toEqual([]);
  });
});
