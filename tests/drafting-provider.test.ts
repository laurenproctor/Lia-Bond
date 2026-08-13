import { describe, expect, it, vi } from "vitest";
import { AiError } from "@/ai/errors";
import { createAnthropicProvider } from "@/ai/anthropic/client";
import { renderDraftingPrompt } from "@/ai/anthropic/drafting-prompt";
import { createMockAiProvider } from "@/ai/mock-provider";
import type { DraftingContext } from "@/lib/responses/drafting-context";
import { validateDraftText } from "@/lib/responses/validate-draft";

/**
 * The drafting provider call.
 *
 * Mirrors `tests/analysis-client.test.ts` exactly: `fetch` is stubbed, so what
 * is under test is the client's own policy for the drafting path — the exact
 * request it sends, what it does with `stop_reason`, and what it refuses to
 * propagate. None of it needs a real API key.
 */

const TEST_KEY = "test-key-not-a-real-credential";

const CONTEXT: DraftingContext = {
  review: {
    text: "The service was slow but the food was great. Will come back.",
    rating: 4,
    authorName: "Jordan P.",
    publishedAt: "2026-08-10T12:00:00.000Z",
    locationName: "Lia Bistro - Downtown",
  },
  business: {
    organizationName: "Lia Bistro Group",
    defaultLanguage: "en",
  },
  analysis: {
    sentiment: "mixed",
    riskLevel: "low",
    topics: ["service speed", "food quality"],
  },
  voice: {
    warmth: 30,
    detail: 55,
    formality: 60,
    confidence: 40,
    hospitality: 70,
    toneNotes: "Keep it upbeat and specific.",
    preferredPhrases: ["we'd love to welcome you back"],
    bannedPhrases: ["we apologize for any inconvenience"],
    signOff: "The Lia Bistro Team",
  },
};

interface StubResponse {
  status?: number;
  body: unknown;
}

/** A `fetch` that answers from a queue and records what it was given. */
function stubFetch(responses: StubResponse | StubResponse[]) {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const calls: Array<{ url: string; init: RequestInit }> = [];

  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), init: init ?? {} });
    const next = queue.length > 1 ? queue.shift()! : queue[0]!;

    return new Response(JSON.stringify(next.body), {
      status: next.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  });

  return { impl: impl as unknown as typeof fetch, calls };
}

function providerWith(responses: StubResponse | StubResponse[]) {
  const { impl, calls } = stubFetch(responses);
  return {
    provider: createAnthropicProvider({
      apiKey: TEST_KEY,
      fetchImpl: impl,
      draftingMaxTokens: 2000,
      // Zero so a test asserting on a failure gets it immediately rather than
      // spending the suite's time in the SDK's backoff.
      maxRetries: 0,
    }),
    calls,
  };
}

/** A well-formed structured-output response for the drafting call. */
function draftBody(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_draft_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    stop_reason: "end_turn",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          draftText:
            "Thank you for sharing your experience with us. We are glad the food stood out, and we are working on tightening our pacing during busier services. We would love the chance to host you again soon.",
        }),
      },
    ],
    usage: { input_tokens: 900, output_tokens: 140 },
    ...overrides,
  };
}

async function draft(provider: ReturnType<typeof providerWith>["provider"]) {
  return provider.draftResponse(CONTEXT);
}

/* -------------------------------------------------------------------------- */
/* The happy path                                                              */
/* -------------------------------------------------------------------------- */

describe("a successful draft", () => {
  it("returns the parsed draft with provenance and telemetry", async () => {
    const { provider } = providerWith({ body: draftBody() });

    const result = await draft(provider);

    expect(result.draftText).toContain("Thank you for sharing your experience");
    expect(result.modelProvider).toBe("anthropic");
    expect(result.modelName).toBe("claude-opus-5");
    expect(result.maxOutputTokens).toBe(2000);
    expect(result.temperature).toBeNull();
    expect(result.providerRequestId).toBe("msg_draft_test");
    expect(result.inputTokens).toBe(900);
    expect(result.outputTokens).toBe(140);
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("sends the drafting context in the request but never the key in the URL", async () => {
    const { provider, calls } = providerWith({ body: draftBody() });

    await draft(provider);

    expect(calls[0]?.url).not.toContain(TEST_KEY);
  });

  it("sends system and user text exactly as the renderer produced them, never re-assembled", async () => {
    const { provider, calls } = providerWith({ body: draftBody() });

    await draft(provider);

    const body = JSON.parse(String(calls[0]?.init.body));
    const rendered = renderDraftingPrompt(CONTEXT);

    expect(body.system).toBe(rendered.system);
    expect(body.messages).toEqual([{ role: "user", content: rendered.user }]);
  });

  it("constrains the response to the schema", async () => {
    const { provider, calls } = providerWith({ body: draftBody() });

    await draft(provider);

    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.output_config?.format).toBeTruthy();
  });

  it("uses the configured model and honors the configured max_tokens", async () => {
    const { provider, calls } = providerWith({ body: draftBody() });

    await draft(provider);

    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.model).toBe("claude-opus-5");
    expect(body.max_tokens).toBe(2000);
  });

  it("leaves temperature at the provider default", async () => {
    const { provider, calls } = providerWith({ body: draftBody() });

    await draft(provider);

    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.temperature).toBeUndefined();
  });
});

/* -------------------------------------------------------------------------- */
/* Failures                                                                    */
/* -------------------------------------------------------------------------- */

describe("failures", () => {
  it("classifies a refusal before reading the content", async () => {
    const { provider } = providerWith({
      body: draftBody({ stop_reason: "refusal", content: [] }),
    });

    const error = await draft(provider).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("refused");
  });

  it("classifies a truncated response", async () => {
    const { provider } = providerWith({
      body: draftBody({ stop_reason: "max_tokens" }),
    });

    const error = await draft(provider).catch((caught: unknown) => caught);
    expect((error as AiError).code).toBe("output_truncated");
  });

  it("classifies a rejected key as not authorized", async () => {
    const { provider } = providerWith({
      status: 401,
      body: { type: "error", error: { type: "authentication_error", message: "bad key" } },
    });

    const error = await draft(provider).catch((caught: unknown) => caught);
    expect((error as AiError).code).toBe("not_authorized");
    expect((error as AiError).retryable).toBe(false);
  });

  it("classifies a rate limit as retryable", async () => {
    const { provider } = providerWith({
      status: 429,
      body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
    });

    const error = await draft(provider).catch((caught: unknown) => caught);
    expect((error as AiError).code).toBe("rate_limited");
    expect((error as AiError).retryable).toBe(true);
  });

  it("never lets a provider message reach the caller", async () => {
    // A model error can echo the prompt, and the drafting prompt contains the
    // review text and the reviewer's name. Provider text is a disclosure risk
    // here exactly as it is for analysis.
    const { provider } = providerWith({
      status: 400,
      body: {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: `prompt contained: ${CONTEXT.review.text}`,
        },
      },
    });

    const error = await draft(provider).catch((caught: unknown) => caught);

    expect((error as AiError).message).not.toContain("slow but the food");
    expect((error as AiError).message).not.toContain("prompt contained");
  });
});

/* -------------------------------------------------------------------------- */
/* The mock                                                                    */
/* -------------------------------------------------------------------------- */

describe("the mock provider", () => {
  it("returns a deterministic draft that passes the Global Constraints gate", async () => {
    const provider = createMockAiProvider();

    const first = await provider.draftResponse(CONTEXT);
    const second = await provider.draftResponse(CONTEXT);

    expect(first).toEqual(second);
    expect(validateDraftText(first.draftText)).toEqual({
      ok: true,
      text: first.draftText,
    });
  });

  it("falls back to generic wording, not the literal string 'undefined', when analysis has no topics", async () => {
    const provider = createMockAiProvider();
    const context: DraftingContext = {
      ...CONTEXT,
      analysis: { sentiment: "neutral", riskLevel: "low", topics: [] },
    };

    const result = await provider.draftResponse(context);

    expect(result.draftText).not.toContain("undefined");
    expect(validateDraftText(result.draftText)).toEqual({
      ok: true,
      text: result.draftText,
    });
  });

  it("counts calls to draftResponse", async () => {
    const provider = createMockAiProvider();

    expect(provider.draftCallCount).toBe(0);
    await provider.draftResponse(CONTEXT);
    await provider.draftResponse(CONTEXT);

    expect(provider.draftCallCount).toBe(2);
  });

  it("claims no token counts or request id for a call that never happened", async () => {
    const provider = createMockAiProvider();
    const result = await provider.draftResponse(CONTEXT);

    expect(result.providerRequestId).toBeNull();
    expect(result.inputTokens).toBeNull();
    expect(result.outputTokens).toBeNull();
    expect(result.temperature).toBeNull();
    expect(result.modelProvider).toBe("mock");
  });

  it("fails when configured to, the same as analyzeMention", async () => {
    const provider = createMockAiProvider({ failWith: "provider_unavailable" });

    const error = await provider.draftResponse(CONTEXT).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("provider_unavailable");
  });
});
