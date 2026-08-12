/**
 * Presentation logic for the rule detail page's execution history section.
 *
 * Pure text and classification — no React, no I/O — so the mode-aware framing,
 * the three-state copy, and the per-action outcome vocabulary are all covered
 * by ordinary Vitest, the same way `readiness.ts` covers activation problems.
 * `execution-history.tsx` is a thin renderer on top of this module; it owns no
 * wording of its own.
 */

import type { AutomationExecutionMode, AutomationRuleExecution, ExecutionActionOutcome } from "@/domain";
import type { RulesExecutionMode } from "@/lib/env";
import { ACTION_CAPABILITIES } from "@/lib/rules/capabilities";

/** Mode `off`: nothing has ever run, and nothing here could be a real execution. */
export const RULES_EXECUTION_OFF_MESSAGE =
  "Rule execution is off — rules are not yet applied to mentions.";

/** Mode `dry_run` or `apply`, zero rows: the engine runs, this rule has not fired yet. */
export const NO_EXECUTIONS_MESSAGE = "No executions yet.";

/**
 * The dry-run reality check. Shown as the section's standing description
 * whenever `mode` is `dry_run`, regardless of whether any rows exist yet — a
 * projection needs the reminder attached to it, not just to its rows.
 */
export const DRY_RUN_FRAMING_MESSAGE = "Dry run only — nothing is applied yet";

/**
 * The section's mode framing, shown above the table (or the empty state).
 * `off` and `apply` have nothing extra to say beyond the state itself — only a
 * dry run needs to keep reminding a reader that nothing here was applied.
 */
export function executionHistoryFraming(mode: RulesExecutionMode): string | null {
  return mode === "dry_run" ? DRY_RUN_FRAMING_MESSAGE : null;
}

export type ExecutionHistorySection = "off" | "empty" | "rows";

/**
 * Which of the three states the section renders.
 *
 * `off` wins outright, even over rows that were recorded before execution was
 * disabled — a disabled feature must never read as still-live automation just
 * because history happens to exist from before it was turned off. Checked
 * before row count for exactly that reason: this is the one place that
 * ordering is decided, so a reordered branch anywhere else can't silently
 * resurrect stale rows behind a disabled feature.
 *
 * `dry_run` and `apply` are otherwise identical here — both are "active" as
 * far as this decision is concerned; the mode only changes wording, never
 * which of the three states shows.
 */
export function resolveExecutionHistorySection(
  mode: RulesExecutionMode,
  rowCount: number,
): ExecutionHistorySection {
  if (mode === "off") return "off";
  if (rowCount === 0) return "empty";
  return "rows";
}

/**
 * The mode badge's word. `dry_run` reads "Projection", never anything that
 * could be mistaken for a real effect — that distinction is the entire point
 * of showing a mode badge at all.
 */
export const EXECUTION_MODE_LABELS: Record<AutomationExecutionMode, string> = {
  dry_run: "Projection",
  apply: "Applied",
};

const EXECUTION_STATUS_LABELS: Record<AutomationRuleExecution["status"], string> = {
  applied: "Applied",
  partial: "Partial",
  blocked: "Blocked",
  failed: "Failed",
  no_op: "No change",
  would_apply: "Would apply",
  would_partial: "Would partially apply",
  would_block: "Would block",
  would_no_op: "Would not change anything",
  would_fail_validation: "Would fail validation",
};

/** A row's overall status, in sentence case. */
export function executionStatusLabel(status: AutomationRuleExecution["status"]): string {
  return EXECUTION_STATUS_LABELS[status];
}

/**
 * Every blocked/no-op code the transition matrix (`transitions.ts`) and the
 * execution unit (the demo adapter's `executeUnit`, and `execute.ts`'s dry-run
 * twin `projectUnit`) can produce, spelled out in sentence case. An
 * unrecognised code still renders — see `fallbackPrefix` below — rather than
 * disappearing or throwing, so a new code added to the domain without a
 * matching entry here degrades gracefully instead of breaking the page.
 */
const OUTCOME_CODE_LABELS: Record<string, string> = {
  escalation_reserved: "blocked: escalation is reserved for the escalate action",
  high_risk_guardrail: "blocked: high-risk mentions cannot be moved to a resting state",
  forbidden_transition: "blocked: transition not permitted",
  action_not_executable: "blocked: this action isn't wired to an effect yet",
  escalation_exists: "no change: an escalation already exists for this mention",
  rule_changed: "failed: the rule changed since this was queued",
  invalid_action: "failed: the action list failed validation",
  mention_missing: "failed: the mention no longer exists",
};

/** "_" to " ", nothing else — codes are already lowercase snake_case. */
function spaced(code: string): string {
  return code.replace(/_/g, " ");
}

function fallbackPrefix(outcome: ExecutionActionOutcome["outcome"]): string {
  switch (outcome) {
    case "applied":
      return "applied";
    case "would_apply":
      return "would apply";
    case "no_op":
    case "would_no_op":
      return "no change";
    case "blocked":
    case "would_block":
      return "blocked";
    case "failed":
    case "would_fail_validation":
      return "failed";
  }
}

/**
 * One action's outcome, rendered as the exact copy above or a sensible
 * fallback.
 *
 * A dry-run projection never says "applied" here either: `would_apply` reads
 * "would apply", so the projection-vs-applied distinction holds at the
 * per-action level, not just on the row's mode badge.
 */
export function describeActionOutcome(outcome: ExecutionActionOutcome): string {
  if (outcome.code) {
    return OUTCOME_CODE_LABELS[outcome.code] ?? `${fallbackPrefix(outcome.outcome)}: ${spaced(outcome.code)}`;
  }
  if (outcome.outcome === "no_op" || outcome.outcome === "would_no_op") {
    return "no change: already true";
  }
  return fallbackPrefix(outcome.outcome);
}

/**
 * A row-level terminal failure — validation never reached the action list, so
 * `outcomes` is empty and the only signal is the row's `lastErrorCode`.
 */
export function describeRowFailure(errorCode: string): string {
  return OUTCOME_CODE_LABELS[errorCode] ?? `failed: ${spaced(errorCode)}`;
}

export interface OutcomeLine {
  key: string;
  text: string;
}

/**
 * One row's outcome lines, action-labelled and in order.
 *
 * Falls back to the row's `lastErrorCode` when `outcomes` is empty — the shape
 * a terminal validation failure (`rule_changed`, `invalid_action`,
 * `mention_missing`) always takes, since nothing in the action list was ever
 * reached to produce a per-action outcome.
 */
export function describeRowOutcomes(execution: AutomationRuleExecution): OutcomeLine[] {
  if (execution.outcomes.length > 0) {
    return execution.outcomes.map((outcome) => ({
      key: `${execution.id}-${outcome.index}`,
      text: `${ACTION_CAPABILITIES[outcome.type].label}: ${describeActionOutcome(outcome)}`,
    }));
  }
  if (execution.lastErrorCode) {
    return [{ key: `${execution.id}-row`, text: describeRowFailure(execution.lastErrorCode) }];
  }
  return [];
}
