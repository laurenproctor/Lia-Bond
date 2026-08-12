import type { GenerationAttempt, Mention } from "@/domain";

/**
 * What the composer's generate control should be doing right now.
 *
 * Pure, and deliberately outside the component: every one of these states is a
 * claim about what the server would do with a click, and those claims are worth
 * testing directly rather than through a rendered tree. The component's job is
 * to draw the answer, not to work it out.
 *
 * The button is an *offer*, never an authority — a click still goes through
 * `generateResponseDraftAction`, which re-checks the role, and through
 * `claim_generation_attempt`, which re-checks everything else. A stale
 * `"ready"` here costs a request that answers `in_progress` or `draft_exists`;
 * it cannot produce a second draft or a second model call.
 */
export type GenerateButtonState = "hidden" | "ready" | "pending" | "failed_retry";

export interface GenerateButtonView {
  state: GenerateButtonState;
  /** The control's label, or null when there is no control. */
  label: string | null;
  /** The sentence under it, when there is something to explain. */
  hint: string | null;
}

/** Sentence case throughout, and never the model's own words about a failure. */
const FAILURE_HINTS: Record<GenerationAttempt["failureCategory"] & string, string> = {
  provider_error: "Generation failed — try again",
  invalid_output: "The response didn't pass validation — try again",
  lease_expired: "The last attempt timed out — try again",
};

/**
 * Resolve the control's state for one mention.
 *
 * Hidden unless this is a Google review with no draft: generation writes a
 * public reply, and a public reply is only something Lia knows how to write for
 * the one source that has the shape for it. Any existing draft — whatever its
 * status — takes the offer away, matching what `claim_generation_attempt`
 * would answer (D132).
 */
export function resolveGenerateButtonState(
  mention: Mention,
  latestAttempt: GenerationAttempt | null,
  hasDraft: boolean,
): GenerateButtonState {
  if (mention.sourceType !== "google_review") return "hidden";
  if (hasDraft) return "hidden";

  // Only the newest attempt is consulted: an older failure that has since been
  // retried says nothing about what a click does now.
  if (latestAttempt?.status === "pending") return "pending";
  if (latestAttempt?.status === "failed") return "failed_retry";

  return "ready";
}

/** The state, plus the words that go with it. */
export function resolveGenerateButtonView(
  mention: Mention,
  latestAttempt: GenerationAttempt | null,
  hasDraft: boolean,
): GenerateButtonView {
  const state = resolveGenerateButtonState(mention, latestAttempt, hasDraft);

  if (state === "hidden") return { state, label: null, hint: null };
  if (state === "pending") {
    return {
      state,
      label: "Generating response",
      hint: "Lia is writing a reply. This usually takes a few seconds.",
    };
  }
  if (state === "failed_retry") {
    const category = latestAttempt?.failureCategory;
    return {
      state,
      label: "Generate response",
      // A failed attempt always carries a category; the fallback covers a row
      // written before this vocabulary existed rather than inventing a cause.
      hint: category ? FAILURE_HINTS[category] : "The last attempt didn't finish — try again",
    };
  }

  return { state, label: "Generate response", hint: null };
}
