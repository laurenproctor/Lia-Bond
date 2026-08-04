/**
 * Model failures, normalised.
 *
 * The same shape and the same discipline as `src/integrations/errors.ts`: the
 * provider's own wording never reaches a screen, and every failure is
 * classified by **what the caller must do next** rather than by what the
 * provider said.
 *
 * There is one extra reason for that here. A model error can echo the prompt,
 * and the prompt contains a customer's review and their name. So a provider
 * message is not merely unhelpful to render — it is a disclosure risk, and it
 * is never stored, logged, or returned.
 */
export type AiErrorCode =
  /** No API key configured. An operator problem, not a user one. */
  | "not_configured"
  /** The key was rejected. Nobody can fix this by retrying. */
  | "not_authorized"
  /** Rate limited or overloaded. Transient, retryable. */
  | "rate_limited"
  /** 5xx, timeout, network failure. Transient, retryable. */
  | "provider_unavailable"
  /**
   * The model declined to answer.
   *
   * Real for this product rather than theoretical: a review describing an
   * injury, an assault, or a threat can trip a safety classifier, and those are
   * exactly the reviews a reputation tool most needs to read. Handled per item
   * so one such review never costs the rest of the batch.
   */
  | "refused"
  /** The response was cut off before the analysis was complete. */
  | "output_truncated"
  /** The response did not match the schema we constrained it to. */
  | "unexpected_output"
  /** Anything we could not classify. */
  | "unknown";

export class AiError extends Error {
  readonly code: AiErrorCode;
  /** True when retrying the same request later could plausibly succeed. */
  readonly retryable: boolean;

  constructor(code: AiErrorCode, message: string, options: { cause?: unknown } = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "AiError";
    this.code = code;
    this.retryable = RETRYABLE_CODES.includes(code);
  }
}

const RETRYABLE_CODES: AiErrorCode[] = ["rate_limited", "provider_unavailable"];

/**
 * Whether a failure should end the whole run or only cost one mention.
 *
 * `not_authorized` and `not_configured` will not fix themselves, so continuing
 * would burn the rest of the batch producing the same error while delaying the
 * one message an operator can act on. Everything else is per-item: a single
 * unreadable review must not cost the other forty-nine.
 */
export function isFatalToRun(error: unknown): boolean {
  return (
    error instanceof AiError &&
    (error.code === "not_authorized" || error.code === "not_configured")
  );
}

/** Remediation copy, written once so every surface says the same thing. */
export const AI_ERROR_MESSAGES: Record<AiErrorCode, string> = {
  not_configured:
    "Analysis is not configured on this server. Ask your administrator to finish setup.",
  not_authorized:
    "Lia's analysis credentials were rejected. Ask your administrator to check them.",
  rate_limited:
    "Analysis is being rate-limited right now. Try again in a few minutes.",
  provider_unavailable:
    "The analysis service did not respond. This is usually temporary — try again shortly.",
  refused:
    "This mention could not be analyzed automatically. Review it by hand — it may describe something the model declined to assess.",
  output_truncated:
    "The analysis of this mention was cut off before it finished. Try again.",
  unexpected_output:
    "The analysis came back in a form Lia did not understand. Let your administrator know if this keeps happening.",
  unknown: "Something went wrong during analysis. Try again shortly.",
};

export function aiError(
  code: AiErrorCode,
  options: { message?: string; cause?: unknown } = {},
): AiError {
  return new AiError(code, options.message ?? AI_ERROR_MESSAGES[code], options);
}

/** A message safe to render, for anything thrown by the AI layer. */
export function toAiMessage(error: unknown): string {
  if (error instanceof AiError) return error.message;
  return AI_ERROR_MESSAGES.unknown;
}

export function aiErrorCode(error: unknown): AiErrorCode {
  return error instanceof AiError ? error.code : "unknown";
}
