/**
 * Plain-language rendering of an automation rule's conditions and actions.
 *
 * The rule builder shows this sentence next to the structured condition/action
 * editor so a person can sanity-check "does this actually say what I meant"
 * without mentally re-parsing a list of field/operator/value rows. It is pure
 * text generation — no I/O — so it can be reused by the builder, the rules
 * list preview, and the simulator.
 *
 * A rule with no conditions never matches anything (see
 * `matchesRule` in `evaluate.ts`), so that case is called out honestly rather
 * than rendered as an empty "When — do X" sentence, regardless of whether the
 * rule has actions.
 */

import {
  MENTION_STATUS_LABELS,
  PLATFORM_LABELS,
  RISK_LEVEL_SHORT_LABELS,
  SENTIMENT_LABELS,
  SOURCE_TYPE_LABELS,
} from "@/lib/labels";
import type { AutomationRuleConfig, RuleAction, RuleCondition } from "@/domain";

export interface SentenceContext {
  /** Location id → display name, for rendering `location` conditions. */
  locationNames: ReadonlyMap<string, string>;
}

const NO_CONDITIONS_SENTENCE =
  "This rule has no conditions yet, so it would never match anything.";

/**
 * Join a list of phrases the way a person would say them aloud:
 * one item as-is, two joined with a bare "and", three or more with a
 * trailing Oxford comma before the "and".
 */
function joinPhrases(phrases: string[]): string {
  return phrases.reduce((sentence, phrase, index) => {
    if (index === 0) return phrase;
    const isLast = index === phrases.length - 1;
    if (!isLast) return `${sentence}, ${phrase}`;
    // Two items: bare "and". Three or more: trailing Oxford comma.
    return phrases.length === 2
      ? `${sentence} and ${phrase}`
      : `${sentence}, and ${phrase}`;
  }, "");
}

function locationPhrase(
  locationId: string,
  context: SentenceContext,
): string {
  return context.locationNames.get(locationId) ?? "a specific location";
}

function conditionPhrase(
  condition: RuleCondition,
  context: SentenceContext,
): string {
  switch (condition.field) {
    case "platform": {
      const label = PLATFORM_LABELS[condition.value];
      return condition.operator === "is"
        ? `the platform is ${label}`
        : `the platform is not ${label}`;
    }

    case "source_type": {
      const label = SOURCE_TYPE_LABELS[condition.value];
      return condition.operator === "is"
        ? `the source is a ${label}`
        : `the source is not a ${label}`;
    }

    case "sentiment": {
      const label = SENTIMENT_LABELS[condition.value].toLowerCase();
      return condition.operator === "is"
        ? `the sentiment is ${label}`
        : `the sentiment is not ${label}`;
    }

    case "risk_level": {
      const label = RISK_LEVEL_SHORT_LABELS[condition.value].toLowerCase();
      switch (condition.operator) {
        case "is":
          return `the risk is ${label}`;
        case "is_not":
          return `the risk is not ${label}`;
        case "at_least":
          return `the risk is ${label} or worse`;
        case "at_most":
          return `the risk is ${label} or better`;
      }
      break;
    }

    case "rating": {
      switch (condition.operator) {
        case "is":
          return `the rating is exactly ${condition.value}`;
        case "greater_than":
          return `the rating is above ${condition.value}`;
        case "less_than":
          return `the rating is below ${condition.value}`;
      }
      break;
    }

    case "relevance_score": {
      switch (condition.operator) {
        case "greater_than":
          return `relevance is above ${condition.value}`;
        case "less_than":
          return `relevance is below ${condition.value}`;
      }
      break;
    }

    case "location": {
      const name = locationPhrase(condition.value, context);
      return condition.operator === "is"
        ? `the location is ${name}`
        : `the location is not ${name}`;
    }

    case "mention_status": {
      const label = MENTION_STATUS_LABELS[condition.value];
      return condition.operator === "is"
        ? `its status is ${label}`
        : `its status is not ${label}`;
    }
  }

  // TypeScript exhaustiveness: unreachable when every field/operator pair
  // above is handled.
  const _exhausted: never = condition;
  return _exhausted;
}

function actionPhrase(action: RuleAction): string {
  switch (action.type) {
    case "escalate":
      return "escalate it";
    case "set_status":
      return `set its status to ${MENTION_STATUS_LABELS[action.status]}`;
    case "require_approval":
      return "hold it for approval";
    case "generate_draft":
      return "draft a reply in your brand voice";
    case "auto_publish":
      return "publish the reply automatically";
    case "notify":
      return "send a notification";
    case "assign":
      return "apply an unsupported action (assign)";
    case "tag":
      return "apply an unsupported action (tag)";
    default: {
      const _exhausted: never = action;
      return _exhausted;
    }
  }
}

/**
 * Render a rule's conditions and actions as one plain-language sentence.
 *
 * A rule with no conditions never matches anything (see `matchesRule`), so
 * that is called out honestly rather than rendered as an empty "When — do X"
 * sentence — the same sentence is returned whether or not the rule has
 * actions, because the actions are moot either way.
 */
export function ruleSentence(
  config: Pick<AutomationRuleConfig, "conditions" | "actions">,
  context: SentenceContext,
): string {
  const { conditions, actions } = config;

  if (conditions.length === 0) {
    return NO_CONDITIONS_SENTENCE;
  }

  const conditionsText = joinPhrases(
    conditions.map((condition) => conditionPhrase(condition, context)),
  );

  if (actions.length === 0) {
    return `When ${conditionsText} — it would do nothing yet. Add an action.`;
  }

  const actionsText = joinPhrases(actions.map((action) => actionPhrase(action)));

  return `When ${conditionsText} — ${actionsText}.`;
}
