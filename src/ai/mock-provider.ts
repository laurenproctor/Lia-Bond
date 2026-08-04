import "server-only";

import type { Mention } from "@/domain";
import { aiError } from "@/ai/errors";
import type {
  AiProvider,
  AnalyzeMentionInput,
  AnalyzeMentionResult,
} from "@/ai/provider";
import type { MentionAnalysisOutput } from "@/lib/analysis/schema";

/**
 * An analyser that never touches the network.
 *
 * Exists so the whole pipeline — the run lock, the batching, the persistence,
 * the escalation, the audit trail — can be exercised end to end without an API
 * key or a bill, including by anyone picking this repository up for the first
 * time.
 *
 * Three properties make it safe rather than merely convenient:
 *
 * - **Isolated.** Only `src/ai/registry.ts` knows it exists, and no code above
 *   that branches on real-versus-mock.
 * - **Deterministic.** The same mention always produces the same analysis, so a
 *   test asserting on an escalation is asserting on a contract rather than on
 *   a model's mood.
 * - **Refused in production.** `resolveAiMode()` throws when
 *   `NODE_ENV=production`, so this can never be the thing serving a customer.
 *
 * The classification is keyword-based and deliberately crude. It is not a
 * cheap model — it is a fixture that reacts to input, which is what makes the
 * high-risk path reachable in development without writing a review by hand
 * that happens to trip a real classifier.
 */

const PROVIDER = "mock";
const MODEL = "deterministic-fixture";

/**
 * Words that stand in for a real risk judgement.
 *
 * Crude on purpose: the point is that a developer can type "we found a hair in
 * the food" locally and watch an escalation appear, not that this approximates
 * the model.
 */
const RISK_MARKERS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly category: MentionAnalysisOutput["riskCategories"][number];
}> = [
  { pattern: /allerg|food poison|sick|hair in|undercook|raw chicken/i, category: "food_safety" },
  { pattern: /injur|burn|fell|ambulance|hospital/i, category: "injury" },
  { pattern: /racist|discriminat|sexist|refused to serve/i, category: "discrimination" },
  { pattern: /lawyer|sue|legal action|attorney/i, category: "legal_threat" },
  { pattern: /rude|shouted|manager was|threw/i, category: "employee_misconduct" },
];

function classify(mention: Mention): MentionAnalysisOutput {
  const text = `${mention.title ?? ""} ${mention.content}`;
  const marker = RISK_MARKERS.find((entry) => entry.pattern.test(text));

  const rating = mention.rating;
  const negative = rating !== null && rating <= 2;

  const riskLevel: MentionAnalysisOutput["riskLevel"] = marker
    ? marker.category === "food_safety" ||
      marker.category === "injury" ||
      marker.category === "discrimination"
      ? "critical"
      : "high"
    : negative
      ? "medium"
      : "low";

  const sentiment: MentionAnalysisOutput["sentiment"] =
    rating === null
      ? marker || negative
        ? "negative"
        : "neutral"
      : rating >= 4
        ? "positive"
        : rating === 3
          ? "mixed"
          : "negative";

  return {
    relevanceScore: 0.9,
    relevanceExplanation:
      "Deterministic mock analysis. This mention is treated as directly about the business.",
    sentiment,
    sentimentScore: sentiment === "positive" ? 0.7 : sentiment === "negative" ? -0.7 : 0,
    riskLevel,
    riskCategories: marker ? [marker.category] : [],
    riskExplanation: marker
      ? `Mock analysis matched a ${marker.category.replace(/_/g, " ")} marker in the text.`
      : "Mock analysis found no risk markers in the text.",
    topics: ["mock analysis"],
    factsNeedingVerification: marker
      ? ["Mock analysis flagged a claim that would need checking."]
      : [],
    recommendedAction:
      riskLevel === "critical" || riskLevel === "high"
        ? "escalate"
        : sentiment === "negative"
          ? "respond_publicly"
          : "monitor",
    recommendationExplanation:
      "Deterministic mock recommendation, derived from the rating and keyword markers.",
    ...(riskLevel === "critical" || riskLevel === "high"
      ? {
          escalationTitle: `Mock escalation: ${marker?.category.replace(/_/g, " ") ?? "risk"}`,
        }
      : {}),
  };
}

export interface MockProviderOptions {
  /**
   * Make every call fail with this code.
   *
   * For exercising the failure paths in development without waiting for a real
   * provider to have a bad day.
   */
  failWith?: Parameters<typeof aiError>[0];
}

export function createMockAiProvider(
  options: MockProviderOptions = {},
): AiProvider {
  return {
    provider: PROVIDER,
    model: MODEL,

    async analyzeMention(
      input: AnalyzeMentionInput,
    ): Promise<AnalyzeMentionResult> {
      if (options.failWith) throw aiError(options.failWith);

      return {
        analysis: classify(input.mention),
        modelProvider: PROVIDER,
        modelName: MODEL,
        // Null rather than a plausible-looking number: fabricating token
        // counts would put fictional figures into a cost record somebody may
        // later add up.
        inputTokens: null,
        outputTokens: null,
      };
    },
  };
}
