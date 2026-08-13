/**
 * Rule templates — five starter configurations for restaurant groups.
 *
 * Each template is a complete `AutomationRuleConfig` ready to instantiate as
 * a rule. Templates are authored with no org/location/user ids; those are
 * resolved (or left null for the user to fill in) at instantiation time.
 *
 * Every template defines `requiredActionTypes` so the UI can warn when
 * a template cannot run — see `available` and `unavailableReason` below.
 */

import type {
  AutomationRuleConfig,
  RuleAction,
  RuleCondition,
} from "@/domain";
import {
  isActionExecutable,
  type RuleActionType,
} from "@/lib/rules/capabilities";

export interface RuleTemplate {
  id: string;
  name: string;
  description: string;
  requiredActionTypes: RuleActionType[];
  available: boolean;
  unavailableReason: string | null;
  config: AutomationRuleConfig;
}

/**
 * Template 1: Quiet low-relevance chatter
 *
 * Marks mentions with low relevance and low risk as dismissed.
 * Available now: `set_status` is executable.
 */
function createQuietLowRelevanceTemplate(): RuleTemplate {
  const requiredActionTypes: RuleActionType[] = ["set_status"];
  const available = requiredActionTypes.every(isActionExecutable);

  const conditions: RuleCondition[] = [
    {
      field: "relevance_score",
      operator: "less_than",
      value: 0.3,
    },
    {
      field: "risk_level",
      operator: "at_most",
      value: "low",
    },
  ];

  const actions: RuleAction[] = [
    {
      type: "set_status",
      status: "dismissed",
    },
  ];

  return {
    id: "quiet-low-relevance",
    name: "Quiet low-relevance chatter",
    description:
      "Automatically dismiss low-relevance, low-risk mentions to focus on what matters.",
    requiredActionTypes,
    available,
    unavailableReason: null,
    config: {
      name: "Quiet low-relevance chatter",
      description: null,
      priority: 90,
      conditions,
      actions,
    },
  };
}

/**
 * Template 2: Escalate negative news coverage
 *
 * Escalates negative news articles for immediate review.
 * Available now: `escalate` is executable.
 */
function createEscalateNegativeNewsTemplate(): RuleTemplate {
  const requiredActionTypes: RuleActionType[] = ["escalate"];
  const available = requiredActionTypes.every(isActionExecutable);

  const conditions: RuleCondition[] = [
    {
      field: "source_type",
      operator: "is",
      value: "news_article",
    },
    {
      field: "sentiment",
      operator: "is",
      value: "negative",
    },
  ];

  const actions: RuleAction[] = [
    {
      type: "escalate",
      assigneeUserId: null,
    },
  ];

  return {
    id: "escalate-negative-news",
    name: "Escalate negative news coverage",
    description:
      "Route negative news articles to a person immediately — these need brand judgment.",
    requiredActionTypes,
    available,
    unavailableReason: null,
    config: {
      name: "Escalate negative news coverage",
      description: null,
      priority: 20,
      conditions,
      actions,
    },
  };
}

/**
 * Template 3: Escalate one-star reviews
 *
 * Escalates very poor reviews for human response.
 * Available now: `escalate` is executable.
 */
function createEscalateOneStarTemplate(): RuleTemplate {
  const requiredActionTypes: RuleActionType[] = ["escalate"];
  const available = requiredActionTypes.every(isActionExecutable);

  const conditions: RuleCondition[] = [
    {
      field: "source_type",
      operator: "is",
      value: "google_review",
    },
    {
      field: "rating",
      operator: "less_than",
      value: 2,
    },
  ];

  const actions: RuleAction[] = [
    {
      type: "escalate",
      assigneeUserId: null,
    },
  ];

  return {
    id: "escalate-one-star",
    name: "Escalate one-star reviews",
    description:
      "Flag the worst reviews for immediate attention — response can turn sentiment around.",
    requiredActionTypes,
    available,
    unavailableReason: null,
    config: {
      name: "Escalate one-star reviews",
      description: null,
      priority: 15,
      conditions,
      actions,
    },
  };
}

/**
 * Template 4: Approval-first Reddit replies
 *
 * Drafts replies to Reddit and holds them for approval — avoiding
 * the need for real-time moderation on fast-moving threads.
 * Unavailable: neither `generate_draft` nor `require_approval` execute today.
 */
function createApprovalFirstRedditTemplate(): RuleTemplate {
  const requiredActionTypes: RuleActionType[] = [
    "generate_draft",
    "require_approval",
  ];
  const available = requiredActionTypes.every(isActionExecutable);

  const conditions: RuleCondition[] = [
    {
      field: "platform",
      operator: "is",
      value: "reddit",
    },
  ];

  const actions: RuleAction[] = [
    {
      type: "generate_draft",
      voiceProfile: null,
    },
    {
      type: "require_approval",
      approverUserId: null,
    },
  ];

  return {
    id: "approval-first-reddit",
    name: "Approval-first Reddit replies",
    description:
      "Draft responses to Reddit mentions, holding them for approval before routing anywhere.",
    requiredActionTypes,
    available,
    unavailableReason: available
      ? null
      : "Needs automated drafting and approval routing, which are manual steps today.",
    config: {
      name: "Approval-first Reddit replies",
      description: null,
      priority: 30,
      conditions,
      actions,
    },
  };
}

/**
 * Template 5: Auto-publish glowing Google replies
 *
 * Publishes automatically to positive, low-risk Google reviews — letting
 * genuinely happy customers see acknowledgement without delay.
 * Unavailable: neither `generate_draft` nor `auto_publish` execute today.
 */
function createAutoPublishGlowingTemplate(): RuleTemplate {
  const requiredActionTypes: RuleActionType[] = [
    "generate_draft",
    "auto_publish",
  ];
  const available = requiredActionTypes.every(isActionExecutable);

  const conditions: RuleCondition[] = [
    {
      field: "source_type",
      operator: "is",
      value: "google_review",
    },
    {
      field: "sentiment",
      operator: "is",
      value: "positive",
    },
    {
      field: "risk_level",
      operator: "at_most",
      value: "low",
    },
    {
      field: "rating",
      operator: "greater_than",
      value: 3,
    },
  ];

  const actions: RuleAction[] = [
    {
      type: "generate_draft",
      voiceProfile: null,
    },
    {
      type: "auto_publish",
    },
  ];

  return {
    id: "auto-publish-glowing",
    name: "Auto-publish glowing Google replies",
    description:
      "Automatically reply to positive, low-risk Google reviews with gratitude — no wait required.",
    requiredActionTypes,
    available,
    unavailableReason: available
      ? null
      : "Needs publishing support Lia does not have yet.",
    config: {
      name: "Auto-publish glowing Google replies",
      description: null,
      priority: 25,
      conditions,
      actions,
    },
  };
}

export const RULE_TEMPLATES: readonly RuleTemplate[] = [
  createQuietLowRelevanceTemplate(),
  createEscalateNegativeNewsTemplate(),
  createEscalateOneStarTemplate(),
  createApprovalFirstRedditTemplate(),
  createAutoPublishGlowingTemplate(),
];

/**
 * Resolve the `?template=` search param on `/rules/new` into the template the
 * builder should be seeded from.
 *
 * The id is bookmarkable, user-editable URL input, so an unknown or absent one
 * is not an error — it falls back to `null` (an empty builder), the same way
 * `parseRuleStatusParam` falls back for an unrecognised status.
 */
export function resolveRuleTemplate(
  templateId: string | undefined,
): RuleTemplate | null {
  if (!templateId) return null;
  return RULE_TEMPLATES.find((entry) => entry.id === templateId) ?? null;
}
