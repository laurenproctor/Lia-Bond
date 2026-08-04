import type { Location, Mention } from "@/domain";
import type { MentionAnalysisOutput } from "@/lib/analysis/schema";

/**
 * The model boundary.
 *
 * Everything vendor-specific — the SDK, the request shape, the error
 * vocabulary, the retry policy — lives behind this, so nothing above it
 * contains a model name or an HTTP status. That split is what makes the
 * analysis service testable by substituting one object rather than
 * intercepting network calls scattered through it.
 *
 * This is deliberately **not** a general LLM abstraction. There is one method,
 * because there is one thing Lia asks a model to do today. Decision D9
 * established the reasoning for the connector boundary and it applies here
 * unchanged: inventing extension points for capabilities that do not exist yet
 * is guessing at their requirements. Workflow 05 adds a `draftResponse()`
 * sibling when there is a real second caller to shape it.
 *
 * Two rules hold throughout the implementations:
 *
 * 1. **No API key is ever logged**, thrown, or attached to an error cause.
 * 2. **No provider message reaches a user.** A model error can echo the
 *    prompt, and the prompt contains a customer's review and their name — so
 *    provider text is a disclosure risk, not merely unhelpful. Failures are
 *    classified into `AiError` codes and the wording a person sees comes from
 *    Lia.
 */

export interface AnalyzeMentionInput {
  mention: Mention;
  /** The restaurant, when the mention is tied to one. */
  location: Location | null;
}

export interface AnalyzeMentionResult {
  analysis: MentionAnalysisOutput;
  /** What produced it, recorded on the row for provenance and cost. */
  modelProvider: string;
  modelName: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

export interface AiProvider {
  /** Identifies the implementation in stored provenance. */
  readonly provider: string;
  readonly model: string;

  /**
   * Classify one mention.
   *
   * Throws `AiError`. Callers distinguish per-item failures from ones that
   * should end the run with `isFatalToRun()`.
   */
  analyzeMention(input: AnalyzeMentionInput): Promise<AnalyzeMentionResult>;
}
