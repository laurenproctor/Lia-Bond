/**
 * Help request topics.
 *
 * Not a domain enum: nothing is persisted, so these live beside the feature
 * rather than in `@/domain`. They stay in one module because the picker, the
 * validation schema, and the email subject line all have to agree on the same
 * vocabulary — a topic the form offers but the action rejects would be a
 * silently unsendable request.
 */

export const HELP_TOPICS = [
  "bug",
  "question",
  "feature_request",
  "integrations",
  "billing",
  "account_access",
  "other",
] as const;

export type HelpTopic = (typeof HELP_TOPICS)[number];

/** Sentence case, per `CLAUDE.md`. */
export const HELP_TOPIC_LABELS: Record<HelpTopic, string> = {
  bug: "Bug",
  question: "How do I…",
  feature_request: "Feature request",
  integrations: "Integrations and connections",
  billing: "Billing and plan",
  account_access: "Account access",
  other: "Something else",
};

/** Shown under the picker so people self-route rather than guess. */
export const HELP_TOPIC_HINTS: Record<HelpTopic, string> = {
  bug: "Something in Lia is broken or showing the wrong data.",
  question: "You know what you want to do but not how to do it here.",
  feature_request: "Lia does not do this yet and you would like it to.",
  integrations: "Connecting, reauthorizing, or syncing a source.",
  billing: "Invoices, seats, or changing your plan.",
  account_access: "Sign-in, invitations, roles, or permissions.",
  other: "Anything the topics above do not cover.",
};

/**
 * The unselected state.
 *
 * The picker starts here rather than on a topic, so the routing is a choice
 * somebody made rather than whichever option happened to be first. Shown to the
 * user, never sent: the schema rejects it.
 */
export const HELP_TOPIC_PLACEHOLDER = "Choose a topic";

/** Guidance under the picker before anything is chosen. */
export const HELP_TOPIC_PLACEHOLDER_HINT =
  "This decides who picks the request up.";
