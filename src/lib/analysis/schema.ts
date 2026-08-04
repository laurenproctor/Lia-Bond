import { z } from "zod";
import {
  escalationCategorySchema,
  recommendedActionSchema,
  riskLevelSchema,
  sentimentSchema,
} from "@/domain/enums";

/**
 * What the model is constrained to return.
 *
 * Declared once, in Zod, and used twice: the SDK turns it into the API's
 * output constraint, and the same object validates what comes back. One
 * declaration means there is no hand-written JSON Schema to drift from the
 * runtime parse — which is the failure mode that produces a field the model
 * dutifully fills and nothing ever reads.
 *
 * The field names and vocabularies match `mention_analyses` deliberately.
 * Every enum here is the domain enum, so a value the database would reject is
 * a value the model is never offered.
 *
 * Structured outputs do not support numeric or string length constraints, so
 * the bounds below are enforced at parse time rather than by the API. The
 * normaliser clamps rather than rejects — a relevance of 1.02 is a rounding
 * artefact, not a reason to throw away an otherwise good analysis.
 */
export const mentionAnalysisOutputSchema = z.object({
  /** 0–1. How much this mention actually concerns the business. */
  relevanceScore: z.number(),
  relevanceExplanation: z.string(),

  sentiment: sentimentSchema,
  /** −1 (most negative) to 1 (most positive). */
  sentimentScore: z.number(),

  riskLevel: riskLevelSchema,
  /**
   * Empty when nothing applies. An empty array is a real answer — most
   * reviews carry no risk category at all, and forcing one would manufacture
   * a food-safety flag out of a complaint about parking.
   */
  riskCategories: z.array(escalationCategorySchema),
  riskExplanation: z.string(),

  topics: z.array(z.string()),
  /**
   * Claims a human must check before Lia repeats or contradicts them.
   *
   * The most load-bearing field for the workflow that follows this one: a
   * draft that confidently denies something the reviewer asserted, without
   * anybody having checked, is how an apology becomes a liability.
   */
  factsNeedingVerification: z.array(z.string()),

  recommendedAction: recommendedActionSchema,
  recommendationExplanation: z.string(),

  /**
   * A short case title, when this warrants escalation.
   *
   * Optional rather than conditionally required: JSON Schema support for
   * conditional requirements is limited, and a missing title must never be
   * what blocks an escalation from being raised. The service derives one
   * deterministically when the model omits it.
   */
  escalationTitle: z.string().optional(),
});

export type MentionAnalysisOutput = z.infer<typeof mentionAnalysisOutputSchema>;
