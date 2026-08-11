import { z } from "zod";
import { RULE_ACTION_TYPES } from "./automation";
import { uuidSchema, timestampSchema } from "../primitives";

/**
 * Sweep and rule-execution vocabulary.
 *
 * A sweep is one pass of the automation engine over pending mentions; each
 * rule that matches during that pass produces one `AutomationRuleExecution`
 * row. Both dry-run (simulation) and apply (real) passes share this shape, but
 * their outcome vocabularies never mix — a dry-run row can never claim
 * `applied`, and an apply row can never claim `would_apply`. That pairing is
 * enforced below in `automationRuleExecutionSchema`'s `superRefine`, not left
 * to callers to get right.
 */

export const AUTOMATION_EXECUTION_MODES = ["dry_run", "apply"] as const;
export type AutomationExecutionMode = (typeof AUTOMATION_EXECUTION_MODES)[number];

export const APPLY_EXECUTION_STATUSES =
  ["applied", "partial", "blocked", "failed", "no_op"] as const;
export type ApplyExecutionStatus = (typeof APPLY_EXECUTION_STATUSES)[number];

export const DRY_RUN_EXECUTION_STATUSES = [
  "would_apply", "would_partial", "would_block", "would_no_op",
  "would_fail_validation",
] as const;
export type DryRunExecutionStatus = (typeof DRY_RUN_EXECUTION_STATUSES)[number];

export const APPLY_ACTION_OUTCOMES =
  ["applied", "no_op", "blocked", "failed"] as const;
export type ApplyActionOutcome = (typeof APPLY_ACTION_OUTCOMES)[number];

export const DRY_RUN_ACTION_OUTCOMES =
  ["would_apply", "would_no_op", "would_block", "would_fail_validation"] as const;
export type DryRunActionOutcome = (typeof DRY_RUN_ACTION_OUTCOMES)[number];

export const sweepCountersSchema = z.object({
  mentionsEvaluated: z.number().int().min(0),
  rulesMatched: z.number().int().min(0),
  actionsApplied: z.number().int().min(0),
  actionsBlocked: z.number().int().min(0),
  actionsSkipped: z.number().int().min(0),
  actionsFailed: z.number().int().min(0),
  retryableFailures: z.number().int().min(0),
  terminalFailures: z.number().int().min(0),
});
export type SweepCounters = z.infer<typeof sweepCountersSchema>;

export const automationSweepSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  mode: z.enum(AUTOMATION_EXECUTION_MODES),
  status: z.enum(["running", "completed", "failed"]),
  startedAt: timestampSchema,
  completedAt: timestampSchema.nullable(),
  counters: sweepCountersSchema,
  errorCode: z.string().nullable(),
});
export type AutomationSweep = z.infer<typeof automationSweepSchema>;

export const executionActionOutcomeSchema = z.object({
  /** Position in the executed revision's actions array — the stable action identity. */
  index: z.number().int().min(0),
  type: z.enum(RULE_ACTION_TYPES),
  outcome: z.enum([...APPLY_ACTION_OUTCOMES, ...DRY_RUN_ACTION_OUTCOMES]),
  code: z.string().nullable(),
});
export type ExecutionActionOutcome = z.infer<typeof executionActionOutcomeSchema>;

export const automationRuleExecutionSchema = z
  .object({
    id: uuidSchema,
    organizationId: uuidSchema,
    sweepId: uuidSchema,
    automationRuleId: uuidSchema,
    ruleRevision: z.number().int().min(1),
    mentionId: uuidSchema,
    /** The mention_analyses row that authorized reconsidering this mention. */
    triggerAnalysisId: uuidSchema,
    locationId: uuidSchema.nullable(),
    mode: z.enum(AUTOMATION_EXECUTION_MODES),
    status: z.enum([...APPLY_EXECUTION_STATUSES, ...DRY_RUN_EXECUTION_STATUSES]),
    outcomes: z.array(executionActionOutcomeSchema),
    outcomeSchemaVersion: z.number().int().min(1),
    attemptCount: z.number().int().min(1),
    lastErrorCode: z.string().nullable(),
    errorClass: z.enum(["retryable", "terminal"]).nullable(),
    startedAt: timestampSchema,
    completedAt: timestampSchema.nullable(),
  })
  .superRefine((row, ctx) => {
    const applyStatus = (APPLY_EXECUTION_STATUSES as readonly string[])
      .includes(row.status);
    if (row.mode === "apply" && !applyStatus) {
      ctx.addIssue({ code: "custom", message: "apply rows carry apply statuses" });
    }
    if (row.mode === "dry_run" && applyStatus) {
      ctx.addIssue({ code: "custom", message: "dry_run rows carry projected statuses" });
    }
  });
export type AutomationRuleExecution = z.infer<typeof automationRuleExecutionSchema>;
