import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { aiError } from "@/ai/errors";
import { draftingOutputSchema, renderDraftingPrompt } from "@/ai/anthropic/drafting-prompt";
import type {
  AiProvider,
  AnalyzeMentionInput,
  AnalyzeMentionResult,
  DraftResult,
} from "@/ai/provider";
import {
  ANALYSIS_SYSTEM_PROMPT,
  renderMention,
} from "@/lib/analysis/prompt";
import { mentionAnalysisOutputSchema } from "@/lib/analysis/schema";
import type { DraftingContext } from "@/lib/responses/drafting-context";

/**
 * The Anthropic boundary.
 *
 * Every model request Lia makes is issued from this file, and nothing here
 * knows about organizations, runs, or the database.
 *
 * The two rules from `provider.ts` are enforced here specifically: the API key
 * is read once into the client and never appears in a message or a thrown
 * cause, and no SDK error text is propagated — a model error can quote the
 * prompt, and the prompt contains a customer's review.
 */

/**
 * Thinking is on by default on this model and shares `max_tokens` with the
 * response. The structured analysis itself is small; the headroom is for
 * thinking, and undersizing it shows up as a truncated analysis rather than an
 * obvious error.
 */
const MAX_TOKENS = 8_000;

/**
 * Same reasoning as `MAX_TOKENS`, sized for the drafting call instead: a
 * draft targets 900 characters of plain prose (`DRAFTING_SYSTEM_PROMPT`'s
 * "Length and format" section), which is small next to the thinking budget it
 * shares `max_tokens` with. Undersizing this shows up as a truncated draft —
 * `output_truncated` below — rather than an obvious error.
 */
const DRAFTING_MAX_TOKENS = 4_000;

const MODEL = "claude-opus-5";
const PROVIDER = "anthropic";

export interface AnthropicProviderConfig {
  apiKey: string;
  /** Injectable so tests drive the provider without a network. */
  fetchImpl?: typeof fetch;
  /** Overridable for a cost/latency sweep once there is data to sweep against. */
  maxTokens?: number;
  /** Same as `maxTokens`, for the drafting call. Kept separate because the
   * two calls' output sizes have nothing in common — a shared knob would
   * force one sweep to fit both. */
  draftingMaxTokens?: number;
  /**
   * Retry attempts for 429 and 5xx, handled by the SDK.
   *
   * Left at the SDK default in production — waiting out a rate limit is
   * exactly right for a batch operation. Tests pin it to zero so a suite that
   * asserts on failures does not spend its time in backoff.
   */
  maxRetries?: number;
}

/**
 * Classify an SDK failure.
 *
 * Ordered most-specific first, per the SDK's typed exception hierarchy.
 * `APIConnectionError` is checked before `APIError` because it extends it in
 * this SDK — the reverse order would swallow every network failure into the
 * generic branch.
 */
function classify(error: unknown): never {
  if (error instanceof Anthropic.AuthenticationError) {
    throw aiError("not_authorized", { cause: error });
  }
  if (error instanceof Anthropic.PermissionDeniedError) {
    throw aiError("not_authorized", { cause: error });
  }
  if (error instanceof Anthropic.RateLimitError) {
    throw aiError("rate_limited", { cause: error });
  }
  if (error instanceof Anthropic.APIConnectionError) {
    throw aiError("provider_unavailable", { cause: error });
  }
  if (error instanceof Anthropic.APIError) {
    // 529 overloaded and every 5xx are the same thing to a caller: try later.
    const status = error.status ?? 0;
    if (status >= 500) throw aiError("provider_unavailable", { cause: error });
    throw aiError("unknown", { cause: error });
  }
  throw aiError("unknown", { cause: error });
}

export function createAnthropicProvider(
  config: AnthropicProviderConfig,
): AiProvider {
  const client = new Anthropic({
    apiKey: config.apiKey,
    ...(config.fetchImpl ? { fetch: config.fetchImpl } : {}),
    ...(config.maxRetries === undefined ? {} : { maxRetries: config.maxRetries }),
  });

  const maxTokens = config.maxTokens ?? MAX_TOKENS;
  const draftingMaxTokens = config.draftingMaxTokens ?? DRAFTING_MAX_TOKENS;

  return {
    provider: PROVIDER,
    model: MODEL,

    async analyzeMention(
      input: AnalyzeMentionInput,
    ): Promise<AnalyzeMentionResult> {
      let response;

      try {
        response = await client.messages.parse({
          model: MODEL,
          max_tokens: maxTokens,
          system: [
            {
              type: "text",
              text: ANALYSIS_SYSTEM_PROMPT,
              // Identical for every mention in a run. The run service issues
              // the first request alone so this is written once and the rest
              // read it — parallel requests cannot read a cache entry another
              // is still writing, so firing them all at once would pay full
              // price every time.
              cache_control: { type: "ephemeral" },
            },
          ],
          output_config: {
            format: zodOutputFormat(mentionAnalysisOutputSchema),
          },
          messages: [
            {
              role: "user",
              content: renderMention(input.mention, input.location),
            },
          ],
        });
      } catch (error) {
        classify(error);
      }

      // Checked before reading content, which is empty or partial on a
      // refusal. Real for this product rather than theoretical: a review
      // describing an injury or an assault can trip a safety classifier, and
      // those are exactly the reviews that most need reading.
      if (response.stop_reason === "refusal") {
        throw aiError("refused");
      }

      if (response.stop_reason === "max_tokens") {
        throw aiError("output_truncated");
      }

      // Null when the response did not satisfy the schema. Not an exception in
      // the SDK, so an unchecked read would surface three layers up as a
      // missing field rather than as a classified failure here.
      if (!response.parsed_output) {
        throw aiError("unexpected_output");
      }

      return {
        analysis: response.parsed_output,
        modelProvider: PROVIDER,
        modelName: MODEL,
        inputTokens: response.usage?.input_tokens ?? null,
        outputTokens: response.usage?.output_tokens ?? null,
      };
    },

    async draftResponse(context: DraftingContext): Promise<DraftResult> {
      // System and user text come from the renderer verbatim — this call
      // never re-assembles or edits prompt wording, which is what keeps the
      // pinned template (`tests/drafting-prompt.test.ts`, "template pin")
      // meaningful as a guarantee about what the model actually receives.
      const { system, user } = renderDraftingPrompt(context);

      let response;
      const startedAt = Date.now();

      try {
        response = await client.messages.parse({
          model: MODEL,
          max_tokens: draftingMaxTokens,
          // Not cached, unlike the analysis system prompt: that one is
          // identical across every mention in a batch run, so caching it pays
          // for itself immediately. A single draft has no sibling call in the
          // same run yet to read a cache entry back — see the comment on
          // `renderDraftingPrompt` in drafting-prompt.ts.
          system,
          // Temperature is deliberately left unset — the provider default,
          // recorded as `null` below rather than a guessed number.
          output_config: {
            format: zodOutputFormat(draftingOutputSchema),
          },
          messages: [{ role: "user", content: user }],
        });
      } catch (error) {
        classify(error);
      }

      const latencyMs = Date.now() - startedAt;

      // Same checks, same order, same reasoning as analyzeMention above: a
      // refusal or a truncation leaves content empty or partial, and the
      // drafting prompt carries a customer's review and name just as the
      // analysis one does.
      if (response.stop_reason === "refusal") {
        throw aiError("refused");
      }

      if (response.stop_reason === "max_tokens") {
        throw aiError("output_truncated");
      }

      if (!response.parsed_output) {
        throw aiError("unexpected_output");
      }

      return {
        draftText: response.parsed_output.draftText,
        modelProvider: PROVIDER,
        modelName: MODEL,
        maxOutputTokens: draftingMaxTokens,
        temperature: null,
        providerRequestId: response.id ?? null,
        inputTokens: response.usage?.input_tokens ?? null,
        outputTokens: response.usage?.output_tokens ?? null,
        latencyMs,
      };
    },
  };
}
