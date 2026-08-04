import type { Mention } from "@/domain";
import type { MentionAnalysisOutput } from "@/lib/analysis/schema";

/**
 * Analysis for a mention with a rating and no words.
 *
 * Workflow 03 imports a great many of these — a rating-only review is the
 * majority of Google's, not an edge case. There is nothing in one for a model
 * to classify: no claim to assess, no topic to extract, no fact to verify. So
 * it is analysed here instead, for free and instantly.
 *
 * The point is not the money saved. It is that asking a model to explain a
 * four-star review with no text invites it to invent a reason, and an invented
 * reason stored as an analysis is worse than an honest shallow one — a later
 * drafting workflow would quote it back.
 *
 * Everything this produces is stored under `HEURISTIC_MODEL_PROVIDER`, so a
 * reader can always tell which analyses a model actually weighed.
 */

/** True when a mention has a rating and nothing worth reading. */
export function isRatingOnly(mention: Mention): boolean {
  return mention.rating !== null && mention.content.trim().length === 0;
}

/**
 * Sentiment from a star rating.
 *
 * Three is `mixed` rather than `neutral`, deliberately. A three-star review is
 * rarely indifference — it is usually satisfaction with a caveat — and filing
 * it as neutral hides it from exactly the queue that should see it.
 */
export function sentimentFromRating(rating: number): MentionAnalysisOutput["sentiment"] {
  if (rating >= 4) return "positive";
  if (rating >= 3) return "mixed";
  return "negative";
}

export function analyzeByRating(mention: Mention): MentionAnalysisOutput {
  // Callers gate on isRatingOnly, so this is a total function rather than a
  // real fallback. Zero is a valid stored rating and must not become "no rating".
  const rating = mention.rating ?? 0;
  const sentiment = sentimentFromRating(rating);

  return {
    // High: a star rating left on the business's own listing is unambiguously
    // about the business, whatever else it fails to say.
    relevanceScore: 0.9,
    relevanceExplanation:
      "Rating with no written review. Scored from the rating alone; no text was available to assess.",
    sentiment,
    // Maps 1–5 onto −1–1 linearly. Honest arithmetic rather than a judgement
    // dressed up as one.
    sentimentScore: Number(((rating - 3) / 2).toFixed(2)),
    // Always low, and this is the load-bearing decision. A one-star review with
    // no words could be about anything — but "could be about anything" is not
    // evidence of a food-safety incident, and inventing a high risk from a
    // silent rating would fill the escalations queue with cases nobody can act
    // on, which is how a queue stops being read at all.
    riskLevel: "low",
    riskCategories: [],
    riskExplanation:
      "No written review, so there is nothing to assess for risk. A low rating alone is not evidence of a specific problem.",
    topics: [],
    factsNeedingVerification: [],
    // A low rating still deserves an answer; a high one does not need chasing.
    recommendedAction: rating <= 2 ? "respond_publicly" : "monitor",
    recommendationExplanation:
      rating <= 2
        ? "A low rating with no explanation is worth a brief public reply inviting the guest to say more."
        : "A rating with no written review needs no response. Counted for trend reporting.",
  };
}
