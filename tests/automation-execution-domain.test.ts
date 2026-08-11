import { describe, expect, it } from "vitest";
import {
  automationRuleExecutionSchema,
  automationSweepSchema,
} from "@/domain";

const baseExecution = {
  id: "7c9a1f4e-0000-4000-8000-000000000001",
  organizationId: "7c9a1f4e-0000-4000-8000-000000000002",
  sweepId: "7c9a1f4e-0000-4000-8000-000000000003",
  automationRuleId: "7c9a1f4e-0000-4000-8000-000000000004",
  ruleRevision: 1,
  mentionId: "7c9a1f4e-0000-4000-8000-000000000005",
  triggerAnalysisId: "7c9a1f4e-0000-4000-8000-000000000006",
  locationId: null,
  outcomes: [],
  outcomeSchemaVersion: 1,
  attemptCount: 1,
  lastErrorCode: null,
  errorClass: null,
  startedAt: "2026-08-11T00:00:00.000Z",
  completedAt: null,
};

describe("automation execution domain", () => {
  it("accepts an apply row with an apply status", () => {
    expect(
      automationRuleExecutionSchema.safeParse({
        ...baseExecution, mode: "apply", status: "applied",
      }).success,
    ).toBe(true);
  });

  it("rejects an apply row carrying a projected status", () => {
    expect(
      automationRuleExecutionSchema.safeParse({
        ...baseExecution, mode: "apply", status: "would_apply",
      }).success,
    ).toBe(false);
  });

  it("rejects a dry_run row carrying an applied status", () => {
    expect(
      automationRuleExecutionSchema.safeParse({
        ...baseExecution, mode: "dry_run", status: "applied",
      }).success,
    ).toBe(false);
  });

  it("parses a running sweep with zeroed counters", () => {
    expect(
      automationSweepSchema.safeParse({
        id: baseExecution.id,
        organizationId: baseExecution.organizationId,
        mode: "dry_run",
        status: "running",
        startedAt: baseExecution.startedAt,
        completedAt: null,
        errorCode: null,
        counters: {
          mentionsEvaluated: 0, rulesMatched: 0, actionsApplied: 0,
          actionsBlocked: 0, actionsSkipped: 0, actionsFailed: 0,
          retryableFailures: 0, terminalFailures: 0,
        },
      }).success,
    ).toBe(true);
  });
});
