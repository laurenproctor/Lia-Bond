/**
 * Builder field metadata for automation rule conditions.
 *
 * This is the single source of truth the rule builder UI reads to render a
 * field picker, an operator picker, and the right value editor for each
 * condition field. It exists so the builder never hand-rolls its own list of
 * fields/operators that could silently drift from `ruleConditionSchema` — the
 * parity test in `tests/rules-sentence.test.ts` walks the schema's
 * discriminated union and asserts every field/operator pair here matches it
 * exactly.
 */

import type { RuleCondition } from "@/domain";

export interface ConditionOperatorMeta {
  value: RuleCondition["operator"];
  label: string;
}

export interface ConditionFieldMeta {
  field: RuleCondition["field"];
  /** Sentence-case label shown in the builder's field picker. */
  label: string;
  /** Exactly the operators `ruleConditionSchema` allows for this field. */
  operators: ConditionOperatorMeta[];
  /** Which value editor the builder should render for this field. */
  input:
    | "platform"
    | "source_type"
    | "sentiment"
    | "risk_level"
    | "mention_status"
    | "location"
    | "rating"
    | "relevance_score";
}

const IS: ConditionOperatorMeta = { value: "is", label: "is" };
const IS_NOT: ConditionOperatorMeta = { value: "is_not", label: "is not" };
const AT_LEAST: ConditionOperatorMeta = { value: "at_least", label: "is at least" };
const AT_MOST: ConditionOperatorMeta = { value: "at_most", label: "is at most" };
const GREATER_THAN: ConditionOperatorMeta = {
  value: "greater_than",
  label: "is above",
};
const LESS_THAN: ConditionOperatorMeta = { value: "less_than", label: "is below" };

export const CONDITION_FIELDS: ConditionFieldMeta[] = [
  {
    field: "platform",
    label: "Platform",
    operators: [IS, IS_NOT],
    input: "platform",
  },
  {
    field: "source_type",
    label: "Source type",
    operators: [IS, IS_NOT],
    input: "source_type",
  },
  {
    field: "sentiment",
    label: "Sentiment",
    operators: [IS, IS_NOT],
    input: "sentiment",
  },
  {
    field: "risk_level",
    label: "Risk level",
    operators: [IS, IS_NOT, AT_LEAST, AT_MOST],
    input: "risk_level",
  },
  {
    field: "rating",
    label: "Rating",
    operators: [IS, GREATER_THAN, LESS_THAN],
    input: "rating",
  },
  {
    field: "relevance_score",
    label: "Relevance score",
    operators: [GREATER_THAN, LESS_THAN],
    input: "relevance_score",
  },
  {
    field: "location",
    label: "Location",
    operators: [IS, IS_NOT],
    input: "location",
  },
  {
    field: "mention_status",
    label: "Mention status",
    operators: [IS, IS_NOT],
    input: "mention_status",
  },
];
