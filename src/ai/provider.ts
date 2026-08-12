import type { Location, Mention } from "@/domain";
import type { MentionAnalysisOutput } from "@/lib/analysis/schema";
import type { DraftingContext } from "@/lib/responses/drafting-context";

/**
 * The model boundary.
 *
 * Everything vendor-specific — the SDK, the request shape, the error
 * vocabulary, the retry policy — lives behind this, so nothing above it
 * contains a model name or an HTTP status. That split is what makes the
 * analysis and drafting services testable by substituting one object rather
 * than intercepting network calls scattered through them.
 *
 * This is deliberately **not** a general LLM abstraction. There are exactly
 * two methods, because there are exactly two things Lia asks a model to do
 * today. Decision D9 established the reasoning for the connector boundary and
 * it applies here unchanged: inventing extension points for capabilities that
 * do not exist yet is guessing at their requirements — `draftResponse` was
 * added only once there was a real second caller (Workflow 05) to shape it,
 * and a third method waits for the same.
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

/**
 * What one drafting call produced, plus the telemetry Task 9's service layer
 * persists onto `generation_attempts` for provenance and cost. Every field
 * here is an honest report of what happened on this call — `null` where the
 * provider genuinely did not supply a value, never a fabricated stand-in.
 */
export interface DraftResult {
  /** The model's raw output. Not yet run through the Global Constraints gate
   * (`validateDraftText`) — that is the caller's job, same as it is for the
   * mock's fixture text. */
  draftText: string;
  /** What produced it, recorded on the row for provenance and cost. */
  modelProvider: string;
  modelName: string;
  /** The `max_tokens` this call was actually sent with. */
  maxOutputTokens: number;
  /** Always `null` today: temperature is left at the provider default,
   * never set from here. Typed nullable because a provider config knob for
   * it is a plausible future addition, not because this call fabricates one. */
  temperature: number | null;
  /** The provider's own id for this request, for support and audit trails. */
  providerRequestId: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  /** Wall-clock time spent waiting on the provider for this call. */
  latencyMs: number;
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

  /**
   * Draft a public reply for one mention.
   *
   * Throws `AiError`, the same codes and the same "no provider text reaches a
   * caller" rule as `analyzeMention` — a model error here can echo the
   * drafting prompt, and that prompt contains the review and the reviewer's
   * name. This method only makes the call and reports what happened; failure
   * categorization for retry/escalation policy is Task 9's service layer, not
   * this boundary.
   */
  draftResponse(context: DraftingContext): Promise<DraftResult>;
}
