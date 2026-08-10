/**
 * Activation readiness for automation rules.
 *
 * A rule can be saved in an incomplete or unsafe shape (that's normal for a
 * draft-in-progress), but it should not be possible to *enable* one without
 * surfacing every reason it isn't ready. `activationProblems` is the single
 * place that judgement lives — the rule builder, the rules list's enable
 * toggle, and any future execution guard should all call this rather than
 * re-deriving their own checks.
 *
 * Checks run in a fixed order (see Section 7 of the plan) and problems
 * accumulate — a rule can carry several problems at once. Some pairs
 * deliberately overlap (an unsafe auto_publish combined with require_approval
 * reports both `auto_publish_unsafe` and `approval_conflicts_auto_publish`)
 * because each names a distinct, independently actionable reason.
 */

import type {
  AutomationRule,
  RuleAction,
  RuleCondition,
} from "@/domain/entities/automation";
import { isAutoPublishSafe } from "@/domain/entities/automation";
import {
  ACTION_CAPABILITIES,
  isActionExecutable,
} from "@/lib/rules/capabilities";

/** set_status values that end a mention's lifecycle with no further action. */
export const TERMINAL_STATUSES = [
  "dismissed",
  "no_action_recommended",
] as const;

export interface ActivationProblem {
  code: string;
  message: string;
}

/**
 * Whether a rule's conditions leave the door open to high-risk (or critical)
 * mentions. Returns false only when a condition explicitly pins risk to low
 * or medium — `risk_level is low`, `is medium`, `at_most low`, or
 * `at_most medium`. Everything else, including `risk_level is_not high`,
 * still admits high or critical risk (`is_not high` excludes exactly one
 * value; critical is still open), so this deliberately returns true for it.
 */
export function admitsHighRisk(conditions: readonly RuleCondition[]): boolean {
  const excludesHighRisk = conditions.some((condition) => {
    if (condition.field !== "risk_level") return false;
    if (condition.operator === "is") {
      return condition.value === "low" || condition.value === "medium";
    }
    if (condition.operator === "at_most") {
      return condition.value === "low" || condition.value === "medium";
    }
    return false;
  });
  return !excludesHighRisk;
}

export function activationProblems(
  rule: Pick<
    AutomationRule,
    "conditions" | "actions" | "revision" | "simulatedRevision"
  >,
): ActivationProblem[] {
  const problems: ActivationProblem[] = [];
  const { conditions, actions, revision, simulatedRevision } = rule;

  if (conditions.length === 0) {
    problems.push({
      code: "no_conditions",
      message:
        "Add at least one condition. A rule with no conditions would never match anything.",
    });
  }

  if (actions.length === 0) {
    problems.push({ code: "no_actions", message: "Add at least one action." });
  }

  for (const action of actions) {
    if (!isActionExecutable(action.type)) {
      const capability = ACTION_CAPABILITIES[action.type];
      problems.push({
        code: `unexecutable_action:${action.type}`,
        message: `${capability.label}: ${capability.blockedReason}`,
      });
    }
  }

  const hasAutoPublish = actions.some(
    (action) => action.type === "auto_publish",
  );
  const hasRequireApproval = actions.some(
    (action) => action.type === "require_approval",
  );

  if (hasAutoPublish && !isAutoPublishSafe({ conditions, actions })) {
    problems.push({
      code: "auto_publish_unsafe",
      message:
        "Auto-publish requires positive sentiment, low risk only, and a routine review source.",
    });
  }

  if (hasAutoPublish && hasRequireApproval) {
    problems.push({
      code: "approval_conflicts_auto_publish",
      message:
        "Approval and auto-publish cannot be combined — approval always wins.",
    });
  }

  const setStatusCount = actions.filter(
    (action) => action.type === "set_status",
  ).length;
  if (setStatusCount >= 2) {
    problems.push({
      code: "conflicting_set_status",
      message: "Two set-status actions conflict with each other.",
    });
  }

  const hasHighRiskTerminalStatus = actions.some(
    (action): action is Extract<RuleAction, { type: "set_status" }> =>
      action.type === "set_status" &&
      (TERMINAL_STATUSES as readonly string[]).includes(action.status),
  );
  if (hasHighRiskTerminalStatus && admitsHighRisk(conditions)) {
    problems.push({
      code: "high_risk_terminal_status",
      message:
        "This rule could dismiss high-risk mentions. Add a risk condition that keeps it to low or medium risk.",
    });
  }

  if (simulatedRevision === null || simulatedRevision !== revision) {
    problems.push({
      code: "stale_simulation",
      message: "Simulate this rule before enabling it.",
    });
  }

  return problems;
}
