import { describe, expect, it } from "vitest";
import type { Location, Mention } from "@/domain";
import {
  analyzeByRating,
  isRatingOnly,
  sentimentFromRating,
} from "@/lib/analysis/heuristic";
import {
  requiresEscalation,
  toAnalysisInput,
  toEscalationInput,
} from "@/lib/analysis/normalize";
import { renderMention } from "@/lib/analysis/prompt";
import type { MentionAnalysisOutput } from "@/lib/analysis/schema";
import { SEED_DATASET } from "@/lib/seed/dataset";

/**
 * The pure half of analysis.
 *
 * No clock, no network, no database — which is the point of keeping these
 * functions free of all three. The awkward cases they exist to handle (a
 * rating with no words, a score a hair outside its range, a critical finding
 * the model gave no title) are rare, so they would otherwise only ever be
 * exercised by a run that happened to include one.
 */

const MENTION = SEED_DATASET.mentions[0]!;
/** A run and an occurrence id: identity the contract now requires. */
const RUN_ID = "3f1a6f6c-9a1e-4b5e-8f3a-1d2c3b4a5e6f";
const OCCURRENCE_ID = "8c2d4e6a-7b1f-4c3d-9e5a-2b4c6d8e0f1a";

function mention(overrides: Partial<Mention> = {}): Mention {
  return { ...MENTION, ...overrides };
}

function output(overrides: Partial<MentionAnalysisOutput> = {}): MentionAnalysisOutput {
  return {
    relevanceScore: 0.9,
    relevanceExplanation: "Directly about the restaurant.",
    sentiment: "negative",
    sentimentScore: -0.6,
    riskLevel: "low",
    riskCategories: [],
    riskExplanation: "No risk markers.",
    topics: ["wait times"],
    factsNeedingVerification: [],
    recommendedAction: "respond_publicly",
    recommendationExplanation: "Worth a short public reply.",
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Rating heuristic                                                            */
/* -------------------------------------------------------------------------- */

describe("the rating heuristic", () => {
  it("recognises a rating with no words", () => {
    expect(isRatingOnly(mention({ rating: 4, content: "" }))).toBe(true);
    expect(isRatingOnly(mention({ rating: 4, content: "   " }))).toBe(true);
  });

  it("does not treat a written review as rating-only", () => {
    expect(isRatingOnly(mention({ rating: 4, content: "Lovely." }))).toBe(false);
  });

  it("does not treat an unrated mention as rating-only", () => {
    // A Reddit thread has no rating. There is text to read, so it goes to the
    // model like anything else.
    expect(isRatingOnly(mention({ rating: null, content: "" }))).toBe(false);
  });

  it("maps each star value onto a sentiment", () => {
    expect(sentimentFromRating(5)).toBe("positive");
    expect(sentimentFromRating(4)).toBe("positive");
    // Mixed, not neutral: a three-star review is usually satisfaction with a
    // caveat, and filing it as neutral hides it from the queue that wants it.
    expect(sentimentFromRating(3)).toBe("mixed");
    expect(sentimentFromRating(2)).toBe("negative");
    expect(sentimentFromRating(1)).toBe("negative");
  });

  it("scores sentiment linearly across the range", () => {
    expect(analyzeByRating(mention({ rating: 5, content: "" })).sentimentScore).toBe(1);
    expect(analyzeByRating(mention({ rating: 3, content: "" })).sentimentScore).toBe(0);
    expect(analyzeByRating(mention({ rating: 1, content: "" })).sentimentScore).toBe(-1);
  });

  it("never invents risk from a silent one-star rating", () => {
    // The load-bearing case. A one-star review with no words could be about
    // anything — but "could be anything" is not evidence of a food-safety
    // incident, and manufacturing one would fill the escalations queue with
    // cases nobody can act on, which is how a queue stops being read.
    const result = analyzeByRating(mention({ rating: 1, content: "" }));

    expect(result.riskLevel).toBe("low");
    expect(result.riskCategories).toEqual([]);
    expect(requiresEscalation(result.riskLevel)).toBe(false);
  });

  it("claims no topics or facts it cannot have found", () => {
    const result = analyzeByRating(mention({ rating: 2, content: "" }));

    expect(result.topics).toEqual([]);
    expect(result.factsNeedingVerification).toEqual([]);
  });

  it("suggests a reply for a low rating and monitoring for a high one", () => {
    expect(analyzeByRating(mention({ rating: 2, content: "" })).recommendedAction).toBe(
      "respond_publicly",
    );
    expect(analyzeByRating(mention({ rating: 5, content: "" })).recommendedAction).toBe(
      "monitor",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Normalisation                                                               */
/* -------------------------------------------------------------------------- */

describe("normalising an analysis", () => {
  const base = {
    mentionId: MENTION.id,
    // Non-null since the escalation contract: the run id is half the identity
    // of the analysis event, so a recording without one has none.
    analysisRunId: RUN_ID,
    modelProvider: "anthropic",
    modelName: "claude-opus-5",
    inputTokens: 1200,
    outputTokens: 300,
    analyzedAt: "2026-08-04T10:00:00.000Z",
  };

  it("clamps a score that came back slightly out of range", () => {
    // A rounding artefact is not a reason to throw away an otherwise sound
    // analysis of a food-safety complaint.
    const result = toAnalysisInput({
      ...base,
      output: output({ relevanceScore: 1.02, sentimentScore: -1.4 }),
    });

    expect(result.relevanceScore).toBe(1);
    expect(result.sentimentScore).toBe(-1);
  });

  it("lowercases and deduplicates topics", () => {
    // Their whole purpose is grouping across hundreds of mentions, and
    // "Wait Times" as a separate row from "wait times" splits the pattern
    // somebody is looking for.
    const result = toAnalysisInput({
      ...base,
      output: output({ topics: ["Wait Times", "wait times", " Portions "] }),
    });

    expect(result.topics).toEqual(["wait times", "portions"]);
  });

  it("caps topics so one verbose analysis cannot dominate a chart", () => {
    const result = toAnalysisInput({
      ...base,
      output: output({
        topics: ["a", "b", "c", "d", "e", "f", "g", "h"],
      }),
    });

    expect(result.topics).toHaveLength(6);
  });

  it("drops a risk category the model invented", () => {
    const result = toAnalysisInput({
      ...base,
      output: output({
        riskCategories: ["food_safety", "not_a_real_category"] as never,
      }),
    });

    expect(result.riskCategories).toEqual(["food_safety"]);
  });

  it("carries provenance and token counts through", () => {
    const result = toAnalysisInput({ ...base, output: output() });

    expect(result.modelProvider).toBe("anthropic");
    expect(result.modelName).toBe("claude-opus-5");
    expect(result.inputTokens).toBe(1200);
    expect(result.outputTokens).toBe(300);
  });

  it("trims and caps facts needing verification", () => {
    const result = toAnalysisInput({
      ...base,
      output: output({
        factsNeedingVerification: ["  charged twice  ", "", "named a server"],
      }),
    });

    expect(result.factsNeedingVerification).toEqual([
      "charged twice",
      "named a server",
    ]);
  });
});

/* -------------------------------------------------------------------------- */
/* Escalation                                                                  */
/* -------------------------------------------------------------------------- */

describe("deriving an escalation", () => {
  const location = SEED_DATASET.locations[0] as Location;

  it("raises one for high and critical risk", () => {
    expect(requiresEscalation("critical")).toBe(true);
    expect(requiresEscalation("high")).toBe(true);
  });

  it("raises none for medium and low", () => {
    // The decision lives in the normaliser so a call site cannot escalate a
    // low-risk mention by mistake.
    expect(requiresEscalation("medium")).toBe(false);
    expect(requiresEscalation("low")).toBe(false);
    expect(
      toEscalationInput(output({ riskLevel: "medium" }), mention(), location, OCCURRENCE_ID),
    ).toBeNull();
  });

  it("uses the model's title when it gave one", () => {
    const result = toEscalationInput(
      output({
        riskLevel: "critical",
        riskCategories: ["food_safety"],
        escalationTitle: "Allergic reaction after shellfish dish",
      }),
      mention(),
      location,
      OCCURRENCE_ID,
    );

    expect(result?.title).toBe("Allergic reaction after shellfish dish");
    expect(result?.category).toBe("food_safety");
    expect(result?.severity).toBe("critical");
  });

  it("derives a title when the model omitted one", () => {
    // escalations.title is NOT NULL with a length check, so an empty title
    // would fail the insert and the escalation would silently not exist.
    const result = toEscalationInput(
      output({ riskLevel: "high", riskCategories: ["injury"] }),
      mention(),
      location,
      OCCURRENCE_ID,
    );

    expect(result?.title).toContain("Injury risk");
    expect(result?.title).toContain(location.name);
  });

  it("falls back to `other` when the model named no category", () => {
    const result = toEscalationInput(
      output({ riskLevel: "critical", riskCategories: [] }),
      mention(),
      location,
      OCCURRENCE_ID,
    );

    expect(result?.category).toBe("other");
    expect(result?.title).toBeTruthy();
  });

  it("sets no due date", () => {
    // Inventing an SLA the organization never agreed to would put a deadline
    // in the escalations centre that nobody set and nobody owns.
    const result = toEscalationInput(
      output({ riskLevel: "critical" }),
      mention(),
      location,
      OCCURRENCE_ID,
    );

    expect(result?.dueAt).toBeNull();
  });

  it("names the occurrence that authorized it", () => {
    // The contract's idempotency evidence: a case says which reading of the
    // mention raised it, so applying that reading again finds this case
    // instead of raising a second one.
    const result = toEscalationInput(
      output({ riskLevel: "critical" }),
      mention(),
      location,
      OCCURRENCE_ID,
    );

    expect(result?.triggerAnalysisId).toBe(OCCURRENCE_ID);
  });
});

/* -------------------------------------------------------------------------- */
/* Prompt rendering                                                            */
/* -------------------------------------------------------------------------- */

describe("rendering a mention for the model", () => {
  const location = SEED_DATASET.locations[0] as Location;

  it("states an absent rating rather than omitting it", () => {
    // So the model distinguishes "no rating given" from one it failed to see.
    const rendered = renderMention(mention({ rating: null }), location);
    expect(rendered).toContain("Rating: none given");
  });

  it("says when a mention is tied to no restaurant", () => {
    const rendered = renderMention(mention(), null);
    expect(rendered).toContain("not identified");
  });

  it("includes an owner reply that is already published", () => {
    // It changes the recommended action: a review already answered in public
    // usually needs monitoring rather than another response.
    const rendered = renderMention(
      mention({ sourceReplyText: "We're sorry about the wait." }),
      location,
    );

    expect(rendered).toContain("already replied publicly");
    expect(rendered).toContain("We're sorry about the wait.");
  });

  it("omits the reply section when there is none", () => {
    const rendered = renderMention(mention({ sourceReplyText: null }), location);
    expect(rendered).not.toContain("already replied publicly");
  });
});
