/**
 * About page copy.
 *
 * Only the list-shaped content lives here — the pieces `/about` renders
 * through `.map()`. Running prose stays in the page component, where each
 * paragraph is used once. Spec:
 * docs/superpowers/specs/2026-08-12-about-page-design.md
 */

export interface Principle {
  name: string;
  body: string;
}

/** The "What Lia does" capability list, rendered as a two-column grid. */
export const ABOUT_CAPABILITIES: readonly string[] = [
  "Monitor reviews, mentions, and customer feedback across channels.",
  "Understand sentiment, subjects, recurring themes, and emerging issues.",
  "Draft thoughtful responses using the context of the business and the individual interaction.",
  "Establish rules for when responses can be automated and when human review is appropriate.",
  "Escalate sensitive or important conversations to the right people.",
  "Maintain a consistent brand voice across locations and teams.",
  "Learn from customer feedback over time.",
  "Turn individual interactions into broader operational and reputational intelligence.",
] as const;

/** What different kinds of feedback reveal about the business itself. */
export const ABOUT_FEEDBACK_SIGNALS: readonly string[] = [
  "A recurring complaint can reveal an operational problem.",
  "A frequently praised employee can reveal what exceptional service actually looks like.",
  "A sudden change in sentiment can signal that something has changed before traditional reporting catches it.",
  "Questions can reveal confusion in the customer journey.",
  "Compliments can reveal what a company should protect.",
] as const;

export const ABOUT_PRINCIPLES: readonly Principle[] = [
  {
    name: "Listen before responding",
    body: "The first responsibility is understanding what someone is actually saying. Good responses begin with context.",
  },
  {
    name: "Automate deliberately",
    body: "Automation should be earned through confidence, rules, and clear boundaries. The question is not whether something can be automated — it is whether it should be.",
  },
  {
    name: "Preserve human judgment",
    body: "Some decisions cannot be reduced to templates, probabilities, or workflows. When context matters, people should remain in control.",
  },
  {
    name: "Treat feedback as intelligence",
    body: "Customer conversations contain operational, reputational, and strategic information. They should not disappear after a response is published.",
  },
  {
    name: "Build institutional memory",
    body: "Organizations should become better listeners over time — remembering what customers have told them and recognizing patterns across individual interactions.",
  },
  {
    name: "Make technology accountable",
    body: "AI systems should operate within understandable rules. Businesses should know why something happened, when automation occurred, and when a person intervened.",
  },
] as const;
