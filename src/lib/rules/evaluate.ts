/**
 * Pure condition evaluator for automation rules.
 *
 * This module evaluates rule conditions against mention subjects. It is used
 * by both the simulation engine (Phase 1) and the future Phase 2 execution
 * engine — they must use this exact module, never diverge with a separate
 * evaluator.
 *
 * Null semantics: A condition never matches a subject whose field is unknown
 * (null), regardless of the operator, including `is_not`. The rule is: if a
 * field is null, the subject does not satisfy any condition on that field.
 * This is a deliberate choice to avoid silent rule behavior when data is
 * incomplete. Execution engines must ensure subjects passed here have complete
 * field values (or explicitly null where the schema allows), not defaults.
 */

import type {
  MentionSourceType,
  MentionStatus,
  Platform,
  RiskLevel,
  RuleCondition,
  Sentiment,
} from "@/domain";

/** Risk levels ordered ascending: low (0) < medium (1) < high (2) < critical (3). */
export const RISK_RANK: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

/**
 * A mention subject for rule evaluation.
 *
 * This is the pure data shape — no I/O, no database queries, no side effects.
 * Field nulls are explicitly allowed and handled per the null rule above.
 */
export interface RuleSubject {
  mentionId: string;
  platform: Platform | null;
  sourceType: MentionSourceType;
  locationId: string | null;
  rating: number | null;
  status: MentionStatus;
  sentiment: Sentiment;
  riskLevel: RiskLevel;
  relevanceScore: number | null;
}

/**
 * Evaluate whether a subject matches a single condition.
 *
 * @param subject The mention subject to test.
 * @param condition The rule condition to evaluate.
 * @returns true if the subject satisfies the condition; false otherwise.
 *
 * **Null rule:** If any field is null, the condition never matches, including
 * with `is_not` operators. This is by design and not a bug.
 */
export function matchesCondition(subject: RuleSubject, condition: RuleCondition): boolean {
  switch (condition.field) {
    case "platform": {
      // Null rule: null platform never matches any condition.
      if (subject.platform === null) return false;

      if (condition.operator === "is") {
        return subject.platform === condition.value;
      } else if (condition.operator === "is_not") {
        return subject.platform !== condition.value;
      }
      // TypeScript exhaustiveness: unreachable
      const _exhausted: never = condition.operator;
      return _exhausted;
    }

    case "source_type": {
      // source_type is never null; no null check needed.
      if (condition.operator === "is") {
        return subject.sourceType === condition.value;
      } else if (condition.operator === "is_not") {
        return subject.sourceType !== condition.value;
      }
      const _exhausted: never = condition.operator;
      return _exhausted;
    }

    case "sentiment": {
      // Sentiment is never null; "unknown" is a real, matchable value.
      if (condition.operator === "is") {
        return subject.sentiment === condition.value;
      } else if (condition.operator === "is_not") {
        return subject.sentiment !== condition.value;
      }
      const _exhausted: never = condition.operator;
      return _exhausted;
    }

    case "risk_level": {
      // risk_level is never null.
      if (condition.operator === "is") {
        return subject.riskLevel === condition.value;
      } else if (condition.operator === "is_not") {
        return subject.riskLevel !== condition.value;
      } else if (condition.operator === "at_least") {
        // >= in RISK_RANK (inclusive).
        const subjectRank = RISK_RANK[subject.riskLevel];
        const conditionRank = RISK_RANK[condition.value];
        return subjectRank >= conditionRank;
      } else if (condition.operator === "at_most") {
        // <= in RISK_RANK (inclusive).
        const subjectRank = RISK_RANK[subject.riskLevel];
        const conditionRank = RISK_RANK[condition.value];
        return subjectRank <= conditionRank;
      }
      const _exhausted: never = condition.operator;
      return _exhausted;
    }

    case "rating": {
      // Null rule: null rating never matches.
      if (subject.rating === null) return false;

      if (condition.operator === "is") {
        return subject.rating === condition.value;
      } else if (condition.operator === "greater_than") {
        return subject.rating > condition.value; // Strict >, not >=
      } else if (condition.operator === "less_than") {
        return subject.rating < condition.value; // Strict <, not <=
      }
      const _exhausted: never = condition.operator;
      return _exhausted;
    }

    case "relevance_score": {
      // Null rule: null relevance_score never matches.
      if (subject.relevanceScore === null) return false;

      if (condition.operator === "greater_than") {
        return subject.relevanceScore > condition.value; // Strict >, not >=
      } else if (condition.operator === "less_than") {
        return subject.relevanceScore < condition.value; // Strict <, not <=
      }
      const _exhausted: never = condition.operator;
      return _exhausted;
    }

    case "location": {
      // Null rule: null locationId never matches any condition (including is_not).
      if (subject.locationId === null) return false;

      if (condition.operator === "is") {
        return subject.locationId === condition.value;
      } else if (condition.operator === "is_not") {
        return subject.locationId !== condition.value;
      }
      const _exhausted: never = condition.operator;
      return _exhausted;
    }

    case "mention_status": {
      // mention_status is never null.
      if (condition.operator === "is") {
        return subject.status === condition.value;
      } else if (condition.operator === "is_not") {
        return subject.status !== condition.value;
      }
      const _exhausted: never = condition.operator;
      return _exhausted;
    }

    // TypeScript exhaustiveness check: if a new field is added to RuleCondition,
    // this will not compile until it is handled above.
    default: {
      const _exhausted: never = condition;
      return _exhausted;
    }
  }
}

/**
 * Evaluate whether a subject matches all conditions in a rule (AND).
 *
 * @param subject The mention subject to test.
 * @param conditions The rule conditions to evaluate.
 * @returns true if all conditions match; false if any condition fails or if
 *   conditions is empty (a rule with no conditions never matches).
 *
 * Empty conditions list returns false: a rule that says nothing about a subject
 * should not fire. This is a deliberate choice to avoid accidentally triggering
 * overly broad automation.
 */
export function matchesRule(
  subject: RuleSubject,
  conditions: readonly RuleCondition[],
): boolean {
  // Empty conditions never match.
  if (conditions.length === 0) return false;

  // All conditions must pass (AND logic).
  return conditions.every((condition) => matchesCondition(subject, condition));
}
