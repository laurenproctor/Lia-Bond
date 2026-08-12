/**
 * About page copy.
 *
 * List-shaped content and prose blocks live here — the pieces `/about`
 * renders through `.map()` or by mapping over prose arrays. Plain prose
 * (no inline JSX) is extracted to keep the page component under ~300 lines.
 * Prose with inline `<strong>` or positioned around `PullLine` stays in the
 * page. Spec: docs/superpowers/specs/2026-08-12-about-page-design.md
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

/** Introductory prose in the header section. */
export const ABOUT_INTRO_PROSE: readonly string[] = [
  "Customers are constantly telling businesses what they think. They leave reviews, ask questions, post comments, share frustrations, recommend products, describe experiences, and signal what they want next.",
  "The problem is no longer a lack of feedback. The problem is making sense of it all, responding thoughtfully, and turning thousands of individual interactions into something useful. Lia exists to help businesses do that.",
] as const;

/** Prose blocks on AI philosophy and judgment. */
export const ABOUT_AI_PHILOSOPHY_PROSE: readonly string[] = [
  "Artificial intelligence makes it possible to process more customer conversations than any individual team could reasonably manage. But scale alone is not the goal.",
  "A technically correct response can still feel indifferent. A perfectly efficient system can still misunderstand context. And automation without judgment can create distance at precisely the moment a customer is trying to be heard.",
  "We believe the strongest applications of AI do something different: they give people greater capacity to listen.",
  "Lia uses technology to help organizations understand what customers are saying, identify what matters, respond consistently, and recognize patterns that would otherwise disappear inside thousands of individual interactions. The technology does the work computers are good at. People remain responsible for judgment.",
] as const;

/** Prose introducing the capabilities list. */
export const ABOUT_CAPABILITIES_INTRO: string =
  "Lia brings customer conversations into a single intelligence layer. The platform is designed to help businesses:";

/** Prose concluding the capabilities section. */
export const ABOUT_CAPABILITIES_CONCLUSION: string =
  "The objective is not to automate every conversation. It is to make every conversation more manageable, more informed, and more useful.";

/** Prose introducing the feedback signals list. */
export const ABOUT_FEEDBACK_INTRO: string =
  "A review is not merely something to answer. It is evidence. Thousands of reviews become a record of what customers experience repeatedly.";

/** Prose concluding the feedback section. */
export const ABOUT_FEEDBACK_CONCLUSION: string =
  "Feedback contains information about the business itself. Lia is being built to help organizations move beyond responding to individual reviews and toward understanding the larger story those interactions tell.";

/** Prose about the target organizations. */
export const ABOUT_TARGET_ORGS_PROSE: readonly string[] = [
  "Lia is designed for businesses where customer experience happens repeatedly, across teams, locations, and channels: hospitality groups, restaurants, retailers, service businesses, multi-location organizations, and other companies whose reputation is shaped one interaction at a time.",
  "As those organizations grow, maintaining attentiveness becomes harder. The founder may once have read every review. A general manager may once have known every customer complaint. A small team may once have understood instinctively how the business should respond. Scale changes that.",
  "Lia is intended to preserve that institutional awareness as organizations become more complex.",
] as const;

/** Prose on Storyworlding's philosophy (excludes the paragraph with inline <strong>). */
export const ABOUT_STORYWORLDING_PROSE: readonly string[] = [
  "Lia is a Storyworlding company. Founded by Lauren Proctor, Storyworlding builds and stewards a portfolio of companies that place human judgment, relationships, and agency at the center of emerging technology.",
  "We believe emerging technologies will change not only what people can do, but how people relate to businesses, institutions, information, one another, and eventually themselves. That creates an enormous field of technological possibility. It also creates questions technology cannot answer on its own.",
  "What should remain human? Where should judgment live? Which relationships are worth protecting? What becomes more important when intelligence becomes abundant?",
] as const;

/** Prose about Lauren Proctor. */
export const ABOUT_FOUNDER_PROSE: readonly string[] = [
  "Lauren Proctor is an entrepreneur and marketing strategist who has spent her career working at the intersection of technology, media, brands, and human behavior. She previously co-founded a technology platform in the creator and influencer economy that was acquired by Twitter, and has since worked with organizations on positioning, growth, digital strategy, customer acquisition, and emerging technologies.",
  "Lia grew from a simple observation: businesses have never had access to more information about what their customers think, yet many still struggle to hear them at scale.",
  "Artificial intelligence changes what is possible. The opportunity is not simply to generate more responses. It is to build better systems for listening.",
] as const;

/** Prose on the future vision. */
export const ABOUT_FUTURE_VISION_PROSE: readonly string[] = [
  "Today, Lia helps businesses manage and understand customer conversations. The larger ambition is to create an intelligence system around the relationship between businesses and their customers.",
  "A system that can recognize patterns across thousands of interactions. A system that understands the difference between an isolated complaint and an emerging problem. A system that knows when automation is sufficient and when someone should pay attention. A system that helps organizations become more responsive without becoming less human.",
  "The most valuable outcome of artificial intelligence may not be removing people from every process. It may be giving people enough leverage to pay attention to the things that deserve them.",
] as const;
