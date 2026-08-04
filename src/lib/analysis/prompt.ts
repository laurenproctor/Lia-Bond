import {
  ESCALATION_CATEGORIES,
  RECOMMENDED_ACTIONS,
  type Location,
  type Mention,
} from "@/domain";
import { SOURCE_TYPE_LABELS } from "@/lib/labels";

/**
 * The analysis prompt.
 *
 * Versioned, and the version is stored on every row it produces. That is what
 * makes a later prompt comparable to this one: `mention_analyses` is
 * append-only, so re-analysing under a new version leaves both readings side
 * by side instead of overwriting the evidence that the change helped.
 *
 * Bump `ANALYSIS_PROMPT_VERSION` whenever the wording below changes in a way
 * that could move an output. Not bumping it is worse than bumping it
 * needlessly: two different prompts recorded under one version make every
 * comparison meaningless.
 */
export const ANALYSIS_PROMPT_VERSION = "analysis@2026-08-04";

const RISK_GUIDANCE = `Risk is about consequence, not tone. Judge what could
follow from this being true and public, not how angry the author sounds.

- critical — credible food safety, injury, discrimination, or a legal threat;
  anything a regulator, a lawyer, or a journalist would act on.
- high — a serious specific allegation about safety, conduct, or treatment of a
  person, or content showing signs of spreading.
- medium — a substantive service or quality failure a manager should answer.
- low — ordinary dissatisfaction, praise, or an off-topic remark.

A calm, precisely worded account of an allergic reaction is critical. An
all-caps rant about a slow starter is low. Politeness is not evidence of
safety, and anger is not evidence of risk.`;

const VERIFICATION_GUIDANCE = `factsNeedingVerification is for specific claims a
person must check before Lia repeats or contradicts them — a named staff
member, a date, an amount charged, a stated allergy, a promised refund. It is
not for opinions. If a later response denies something on this list without
anybody checking, an apology becomes a liability.`;

/**
 * The system prompt.
 *
 * Built once per process and identical for every mention in a run, which is
 * what makes it cacheable — see the run service, which sends the first request
 * alone so the rest read the cache rather than all paying to write it.
 */
export const ANALYSIS_SYSTEM_PROMPT = `You are the triage analyst for Lia, a
reputation management system used by restaurant groups. You read one public
mention at a time — a review, a forum post, a news article, a comment — and
classify it so the right person sees it in time.

You are not writing to the customer. Nothing you produce is shown to them. Your
audience is the operations and communications team deciding what to act on
today.

Judge only what the text supports. Do not infer facts that are not there, do
not assume the business is at fault, and do not assume it is not. Where the
mention is ambiguous, say so in the explanations rather than resolving it.

${RISK_GUIDANCE}

relevanceScore is 0–1: how much this concerns the business itself, as opposed
to something incidental nearby. A review of the restaurant is 1. A news article
that names it in passing is low.

sentimentScore is −1 to 1 and should agree with sentiment. Use "mixed" when the
author is genuinely both — praise for the food and a complaint about the wait —
rather than averaging them into "neutral".

topics are short lowercase noun phrases, at most six: "wait times", "portion
size", "allergen handling". They are for spotting patterns across hundreds of
mentions, so prefer a term you would reuse over one that fits this mention
perfectly.

${VERIFICATION_GUIDANCE}

recommendedAction must be one of: ${RECOMMENDED_ACTIONS.join(", ")}.
riskCategories must be drawn from: ${ESCALATION_CATEGORIES.join(", ")}. Leave it
empty when none genuinely applies — most mentions carry no category at all.

When riskLevel is high or critical, also give escalationTitle: a specific
one-line case title someone can scan in a queue. "Allergic reaction after
shellfish dish" — not "High risk review".`;

/**
 * The mention, rendered for the model.
 *
 * Deliberately explicit about what is missing. A rating-only review reaching
 * this function at all would be a bug — the heuristic path handles those — but
 * every other absence is stated rather than silently omitted, so the model
 * distinguishes "no rating given" from a rating it failed to notice.
 */
export function renderMention(mention: Mention, location: Location | null): string {
  const lines = [
    `Source: ${SOURCE_TYPE_LABELS[mention.sourceType]}`,
    location
      ? `Location: ${location.name}, ${location.city}, ${location.region}`
      : "Location: not identified — this mention is not tied to a specific restaurant.",
    mention.rating === null
      ? "Rating: none given"
      : `Rating: ${mention.rating} out of 5`,
    `Published: ${mention.publishedAt}`,
    mention.authorName
      ? `Author: ${mention.authorName}`
      : mention.authorIsAnonymous
        ? "Author: posted anonymously"
        : "Author: not provided",
  ];

  if (mention.title) lines.push(`Title: ${mention.title}`);

  lines.push("", "Mention text:", mention.content.trim() || "(no text)");

  // The owner's published reply, when there is one. Included because it changes
  // the recommended action — a review that has already been answered in public
  // usually needs monitoring rather than another response.
  if (mention.sourceReplyText) {
    lines.push(
      "",
      "The business has already replied publicly:",
      mention.sourceReplyText.trim(),
    );
  }

  return lines.join("\n");
}
