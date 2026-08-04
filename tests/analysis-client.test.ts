import { describe, expect, it, vi } from "vitest";
import { AiError } from "@/ai/errors";
import { createAnthropicProvider } from "@/ai/anthropic/client";
import { createMockAiProvider } from "@/ai/mock-provider";
import { SEED_DATASET } from "@/lib/seed/dataset";

/**
 * The Anthropic boundary.
 *
 * `fetch` is stubbed, so what is under test is the client's own policy: how it
 * classifies a failure, what it refuses to propagate, and whether it checks
 * `stop_reason` before reading content. None of that needs a real API key, and
 * all of it would be untestable without the seam.
 *
 * The key used throughout is a fixture string that authenticates nothing.
 */

const TEST_KEY = "test-key-not-a-real-credential";
const MENTION = SEED_DATASET.mentions[0]!;
const LOCATION = SEED_DATASET.locations[0]!;

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
      maxTokens: 2000,
      // Zero so a test asserting on a failure gets it immediately rather than
      // spending the suite's time in the SDK's backoff. Production keeps the
      // SDK default — waiting out a rate limit is right for a batch.
      maxRetries: 0,
    }),
    calls,
  };
}

/** A well-formed structured-output response. */
function analysisBody(overrides: Record<string, unknown> = {}) {
  return {
    id: "msg_test",
    type: "message",
    role: "assistant",
    model: "claude-opus-5",
    stop_reason: "end_turn",
    content: [
      {
        type: "text",
        text: JSON.stringify({
          relevanceScore: 0.9,
          relevanceExplanation: "Directly about the restaurant.",
          sentiment: "negative",
          sentimentScore: -0.6,
          riskLevel: "medium",
          riskCategories: [],
          riskExplanation: "Service failure, no safety concern.",
          topics: ["wait times"],
          factsNeedingVerification: [],
          recommendedAction: "respond_publicly",
          recommendationExplanation: "Worth a short public reply.",
        }),
      },
    ],
    usage: { input_tokens: 1200, output_tokens: 260 },
    ...overrides,
  };
}

async function analyze(provider: ReturnType<typeof providerWith>["provider"]) {
  return provider.analyzeMention({ mention: MENTION, location: LOCATION });
}

/* -------------------------------------------------------------------------- */
/* The happy path                                                              */
/* -------------------------------------------------------------------------- */

describe("a successful analysis", () => {
  it("returns the parsed analysis with provenance and token counts", async () => {
    const { provider } = providerWith({ body: analysisBody() });

    const result = await analyze(provider);

    expect(result.analysis.riskLevel).toBe("medium");
    expect(result.analysis.topics).toEqual(["wait times"]);
    expect(result.modelProvider).toBe("anthropic");
    expect(result.modelName).toBe("claude-opus-5");
    expect(result.inputTokens).toBe(1200);
    expect(result.outputTokens).toBe(260);
  });

  it("sends the review in the request but never the key in the URL", async () => {
    const { provider, calls } = providerWith({ body: analysisBody() });

    await analyze(provider);

    expect(calls[0]?.url).not.toContain(TEST_KEY);
  });

  it("marks the system prompt as cacheable", async () => {
    // Identical for every mention in a run, so caching it is what makes a
    // batch affordable. If this stops being sent, the cost of a 50-mention run
    // roughly quadruples with no other visible symptom.
    const { provider, calls } = providerWith({ body: analysisBody() });

    await analyze(provider);

    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.system[0].cache_control).toEqual({ type: "ephemeral" });
  });

  it("constrains the response to the schema", async () => {
    const { provider, calls } = providerWith({ body: analysisBody() });

    await analyze(provider);

    const body = JSON.parse(String(calls[0]?.init.body));
    expect(body.output_config?.format).toBeTruthy();
  });
});

/* -------------------------------------------------------------------------- */
/* Failures                                                                    */
/* -------------------------------------------------------------------------- */

describe("failures", () => {
  it("classifies a refusal before reading the content", async () => {
    // Real for this product: a review describing an injury or an assault can
    // trip a safety classifier, and content is empty or partial on a refusal —
    // so an unchecked read would surface as a missing field three layers up.
    const { provider } = providerWith({
      body: analysisBody({ stop_reason: "refusal", content: [] }),
    });

    const error = await analyze(provider).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(AiError);
    expect((error as AiError).code).toBe("refused");
  });

  it("classifies a truncated response", async () => {
    // Thinking shares max_tokens with the output on this model, so this is a
    // real case rather than a theoretical one.
    const { provider } = providerWith({
      body: analysisBody({ stop_reason: "max_tokens" }),
    });

    const error = await analyze(provider).catch((caught: unknown) => caught);
    expect((error as AiError).code).toBe("output_truncated");
  });

  it("classifies a rejected key as not authorized", async () => {
    const { provider } = providerWith({
      status: 401,
      body: { type: "error", error: { type: "authentication_error", message: "bad key" } },
    });

    const error = await analyze(provider).catch((caught: unknown) => caught);
    expect((error as AiError).code).toBe("not_authorized");
    expect((error as AiError).retryable).toBe(false);
  });

  it("classifies a rate limit as retryable", async () => {
    const { provider } = providerWith({
      status: 429,
      body: { type: "error", error: { type: "rate_limit_error", message: "slow down" } },
    });

    const error = await analyze(provider).catch((caught: unknown) => caught);
    expect((error as AiError).code).toBe("rate_limited");
    expect((error as AiError).retryable).toBe(true);
  });

  it("classifies an overloaded provider as unavailable", async () => {
    const { provider } = providerWith({
      status: 529,
      body: { type: "error", error: { type: "overloaded_error", message: "busy" } },
    });

    const error = await analyze(provider).catch((caught: unknown) => caught);
    expect((error as AiError).code).toBe("provider_unavailable");
  });

  it("never lets a provider message reach the caller", async () => {
    // A model error can echo the prompt, and the prompt contains the review
    // and the reviewer's name. So provider text is a disclosure risk, not
    // merely unhelpful.
    const { provider } = providerWith({
      status: 400,
      body: {
        type: "error",
        error: {
          type: "invalid_request_error",
          message: "prompt contained: We had a reservation for 7pm",
        },
      },
    });

    const error = await analyze(provider).catch((caught: unknown) => caught);

    expect((error as AiError).message).not.toContain("reservation");
    expect((error as AiError).message).not.toContain("prompt contained");
  });
});

/* -------------------------------------------------------------------------- */
/* The mock                                                                    */
/* -------------------------------------------------------------------------- */

describe("the mock provider", () => {
  it("satisfies the same interface without a network", async () => {
    const provider = createMockAiProvider();
    const result = await provider.analyzeMention({
      mention: MENTION,
      location: LOCATION,
    });

    expect(result.analysis.sentiment).toBeTruthy();
    expect(result.modelProvider).toBe("mock");
  });

  it("is deterministic for the same mention", async () => {
    const provider = createMockAiProvider();

    const first = await provider.analyzeMention({ mention: MENTION, location: null });
    const second = await provider.analyzeMention({ mention: MENTION, location: null });

    expect(first.analysis).toEqual(second.analysis);
  });

  it("reaches the high-risk path from text, so escalation is testable locally", async () => {
    const provider = createMockAiProvider();

    const result = await provider.analyzeMention({
      mention: {
        ...MENTION,
        content: "My daughter had an allergic reaction and we went to hospital.",
      },
      location: null,
    });

    expect(result.analysis.riskLevel).toBe("critical");
    expect(result.analysis.riskCategories).toContain("food_safety");
    expect(result.analysis.escalationTitle).toBeTruthy();
  });

  it("claims no token counts for a call that never happened", async () => {
    const provider = createMockAiProvider();
    const result = await provider.analyzeMention({ mention: MENTION, location: null });

    expect(result.inputTokens).toBeNull();
    expect(result.outputTokens).toBeNull();
  });
});
