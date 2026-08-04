import "server-only";

import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import { aiError } from "@/ai/errors";
import type {
  AiProvider,
  AnalyzeMentionInput,
  AnalyzeMentionResult,
} from "@/ai/provider";
import {
  ANALYSIS_SYSTEM_PROMPT,
  renderMention,
} from "@/lib/analysis/prompt";
import { mentionAnalysisOutputSchema } from "@/lib/analysis/schema";

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

const MODEL = "claude-opus-5";
const PROVIDER = "anthropic";

export interface AnthropicProviderConfig {
  apiKey: string;
  /** Injectable so tests drive the provider without a network. */
  fetchImpl?: typeof fetch;
  /** Overridable for a cost/latency sweep once there is data to sweep against. */
  maxTokens?: number;
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
  };
}
