/**
 * The Phase 2 automation transition matrix (spec §7).
 *
 * Statuses are outcomes, not ranks — there is no lattice. This module is
 * the single statement of what automation may do to a mention's status;
 * the G1 execution RPC restates it in SQL, and the database-harness parity
 * test asserts the two agree cell for cell.
 *
 * `escalated` is reserved for the escalate executor: set_status may never
 * target it (`escalation_reserved`), and only `decideEscalate` says when
 * escalation is eligible. Automation never reopens a dismissed mention.
 */
import type { MentionStatus, RiskLevel } from "@/domain";
import { RISK_RANK } from "./evaluate";

export type TransitionDecision =
  | { kind: "apply" }
  | { kind: "no_op" }
  | { kind: "blocked";
      code: "forbidden_transition" | "high_risk_guardrail" | "escalation_reserved" };

const RESTING_TARGETS: readonly MentionStatus[] =
  ["no_action_recommended", "dismissed"];
const MOVABLE_SOURCES: readonly MentionStatus[] = ["analyzed", "monitoring"];

export function decideSetStatus(
  current: MentionStatus,
  target: MentionStatus,
  risk: RiskLevel,
): TransitionDecision {
  if (target === "escalated") {
    return { kind: "blocked", code: "escalation_reserved" };
  }
  if (current === target) return { kind: "no_op" };
  if (!MOVABLE_SOURCES.includes(current)) {
    return { kind: "blocked", code: "forbidden_transition" };
  }
  if (current === "analyzed" && target === "monitoring") return { kind: "apply" };
  if (RESTING_TARGETS.includes(target)) {
    if (RISK_RANK[risk] >= RISK_RANK.high) {
      return { kind: "blocked", code: "high_risk_guardrail" };
    }
    return { kind: "apply" };
  }
  return { kind: "blocked", code: "forbidden_transition" };
}

export function decideEscalate(current: MentionStatus): TransitionDecision {
  if (current === "escalated") return { kind: "no_op" };
  if (current === "analyzed" || current === "monitoring"
      || current === "no_action_recommended") {
    return { kind: "apply" };
  }
  return { kind: "blocked", code: "forbidden_transition" };
}
