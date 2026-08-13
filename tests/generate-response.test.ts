import { beforeEach, describe, expect, it } from "vitest";
import type { AiProvider, DraftResult } from "@/ai/provider";
import { aiError, type AiErrorCode } from "@/ai/errors";
import { DRAFTING_PROMPT_VERSION } from "@/ai/anthropic/drafting-prompt";
import type { DraftingContext } from "@/lib/responses/drafting-context";
import { generateResponseDraft } from "@/lib/responses/generate";
import { demoRuntimeStore, demoStore } from "@/lib/data/demo/store";
import { DataError } from "@/lib/data/errors";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import { MENTION_LABELS } from "@/lib/seed/dataset";
import { seedId } from "@/lib/seed/ids";
import { freshDataSource, ushg } from "./helpers/scope";

/**
 * Manual response generation, end to end through the service.
 *
 * Only the provider is faked. The claim/complete/fail lifecycle, the drafting
 * context builder, the output gate, and audit are all production code —
 * because what this covers is how they fit together: a second click that
 * spends another model call, or an invalid draft that reaches a customer
 * anyway, is exactly the bug a unit test of any one piece would miss.
 */

/** A google_review mention carrying no seeded draft. */
const FOOD_SAFETY_MENTION_ID = seedId(`mention:${MENTION_LABELS.foodSafety}`);
/** A google_review mention that already carries a seeded draft. */
const OVERPRICED_MENTION_ID = seedId(`mention:${MENTION_LABELS.overpriced}`);

let dataSource: LiaDataSource;
let scope: OrganizationScope;

/**
 * A provider that returns a fixed draft and counts its calls.
 *
 * The call count is the point of most cases below: "the dedupe worked" and
 * "the dedupe returned the right shape but still paid for a model call" look
 * identical from the outside without it.
 */
function fakeProvider(
  options: { draftText?: string; failWith?: AiErrorCode } = {},
): AiProvider & { contexts: DraftingContext[] } {
  const contexts: DraftingContext[] = [];

  return {
    contexts,
    provider: "fake",
    model: "fake-model",
    async analyzeMention() {
      throw new Error("analyzeMention is not part of generation.");
    },
    async draftResponse(context): Promise<DraftResult> {
      contexts.push(context);
      if (options.failWith) throw aiError(options.failWith);

      return {
        draftText:
          options.draftText ??
          "Thank you for taking the time to write. We are sorry the visit fell short, and we would like to make it right.",
        modelProvider: "fake",
        modelName: "fake-model",
        maxOutputTokens: 1024,
        temperature: null,
        providerRequestId: "req_fake_1",
        inputTokens: 900,
        outputTokens: 120,
        latencyMs: 42,
      };
    },
  };
}

/** A minimal valid context, for the claim a test takes out from under the service. */
function heldContext(): DraftingContext {
  return {
    review: {
      text: "held",
      rating: 1,
      authorName: null,
      publishedAt: "2026-08-10T12:00:00.000Z",
      locationName: null,
    },
    business: { organizationName: "USHG", defaultLanguage: "en-US" },
    analysis: null,
    voice: {
      warmth: 3,
      detail: 3,
      formality: 3,
      confidence: 3,
      hospitality: 3,
      toneNotes: null,
      preferredPhrases: [],
      bannedPhrases: [],
      signOff: null,
    },
  };
}

function attemptsFor(mentionId: string) {
  return demoRuntimeStore().generationAttempts.filter(
    (row) => row.mentionId === mentionId,
  );
}

function draftsFor(mentionId: string) {
  return demoStore().responseDrafts.filter((row) => row.mentionId === mentionId);
}

beforeEach(() => {
  dataSource = freshDataSource();
  scope = ushg.comms();
});

describe("generateResponseDraft", () => {
  it("claims, calls the provider once, and leaves a stamped draft behind", async () => {
    const provider = fakeProvider();

    const result = await generateResponseDraft(
      { dataSource, scope },
      FOOD_SAFETY_MENTION_ID,
      provider,
    );

    expect(result.kind).toBe("generated");
    if (result.kind !== "generated") return;
    expect(provider.contexts).toHaveLength(1);

    const drafts = draftsFor(FOOD_SAFETY_MENTION_ID);
    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.id).toBe(result.responseDraftId);
    expect(drafts[0]?.responseType).toBe("public_reply");
    expect(drafts[0]?.generatedBy).toBe("ai");
    expect(drafts[0]?.generationProvider).toBe("fake");
    expect(drafts[0]?.promptVersion).toBe(DRAFTING_PROMPT_VERSION);

    const attempts = attemptsFor(FOOD_SAFETY_MENTION_ID);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe("completed");
    expect(attempts[0]?.responseDraftId).toBe(result.responseDraftId);
  });

  it("builds the context from the mention it was asked about", async () => {
    const provider = fakeProvider();

    await generateResponseDraft({ dataSource, scope }, FOOD_SAFETY_MENTION_ID, provider);

    const mention = await dataSource.mentions.get(scope, FOOD_SAFETY_MENTION_ID);
    expect(provider.contexts[0]?.review.text).toBe(mention?.content);
  });

  it("records the configured voice, and its version, on the attempt", async () => {
    await generateResponseDraft({ dataSource, scope }, FOOD_SAFETY_MENTION_ID, fakeProvider());

    const profile = await dataSource.brandVoice.get(scope);
    const attempt = attemptsFor(FOOD_SAFETY_MENTION_ID)[0];
    expect(attempt?.brandVoiceSource).toBe("configured");
    expect(attempt?.brandVoiceVersion).toBe(String(profile?.version));
  });

  it("records brand voice source default when the organization has no voice row", async () => {
    demoStore().brandVoiceProfiles = demoStore().brandVoiceProfiles.filter(
      (row) => row.organizationId !== scope.organizationId,
    );

    const result = await generateResponseDraft(
      { dataSource, scope },
      FOOD_SAFETY_MENTION_ID,
      fakeProvider(),
    );

    expect(result.kind).toBe("generated");
    const attempt = attemptsFor(FOOD_SAFETY_MENTION_ID)[0];
    expect(attempt?.brandVoiceSource).toBe("default");
    expect(attempt?.brandVoiceVersion).toBeNull();
  });

  it("reports in_progress without spending a model call while an attempt is live", async () => {
    await dataSource.generationAttempts.claim(scope, {
      mentionId: FOOD_SAFETY_MENTION_ID,
      context: heldContext(),
      contextHash: "hash-held",
      promptVersion: DRAFTING_PROMPT_VERSION,
      brandVoiceSource: "default",
      brandVoiceVersion: null,
      analysisIncluded: false,
    });

    const provider = fakeProvider();
    const result = await generateResponseDraft(
      { dataSource, scope },
      FOOD_SAFETY_MENTION_ID,
      provider,
    );

    expect(result).toEqual({ kind: "in_progress" });
    expect(provider.contexts).toHaveLength(0);
    expect(draftsFor(FOOD_SAFETY_MENTION_ID)).toHaveLength(0);
  });

  it("reports the existing draft without spending a model call", async () => {
    const provider = fakeProvider();

    const result = await generateResponseDraft(
      { dataSource, scope },
      OVERPRICED_MENTION_ID,
      provider,
    );

    expect(result.kind).toBe("draft_exists");
    if (result.kind !== "draft_exists") return;
    expect(provider.contexts).toHaveLength(0);
    expect(draftsFor(OVERPRICED_MENTION_ID).map((row) => row.id)).toContain(
      result.responseDraftId,
    );
  });

  it("fails the attempt as invalid_output when the draft trips the gate, writing no draft", async () => {
    const provider = fakeProvider({
      draftText: "Thanks for the note — please visit https://example.com to tell us more.",
    });

    const result = await generateResponseDraft(
      { dataSource, scope },
      FOOD_SAFETY_MENTION_ID,
      provider,
    );

    expect(result).toEqual({ kind: "failed", category: "invalid_output" });
    expect(provider.contexts).toHaveLength(1);
    expect(draftsFor(FOOD_SAFETY_MENTION_ID)).toHaveLength(0);

    const attempt = attemptsFor(FOOD_SAFETY_MENTION_ID)[0];
    expect(attempt?.status).toBe("failed");
    expect(attempt?.failureCategory).toBe("invalid_output");
  });

  it("fails the attempt as provider_error when the provider throws, surfacing no provider text", async () => {
    const provider = fakeProvider({ failWith: "rate_limited" });

    const result = await generateResponseDraft(
      { dataSource, scope },
      FOOD_SAFETY_MENTION_ID,
      provider,
    );

    expect(result).toEqual({ kind: "failed", category: "provider_error" });
    expect(draftsFor(FOOD_SAFETY_MENTION_ID)).toHaveLength(0);

    const attempt = attemptsFor(FOOD_SAFETY_MENTION_ID)[0];
    expect(attempt?.status).toBe("failed");
    expect(attempt?.failureCategory).toBe("provider_error");
  });

  it("lets a retry after a failure claim again and succeed", async () => {
    const failed = await generateResponseDraft(
      { dataSource, scope },
      FOOD_SAFETY_MENTION_ID,
      fakeProvider({ failWith: "rate_limited" }),
    );
    expect(failed.kind).toBe("failed");

    const retried = await generateResponseDraft(
      { dataSource, scope },
      FOOD_SAFETY_MENTION_ID,
      fakeProvider(),
    );

    expect(retried.kind).toBe("generated");
    expect(draftsFor(FOOD_SAFETY_MENTION_ID)).toHaveLength(1);
    expect(attemptsFor(FOOD_SAFETY_MENTION_ID)).toHaveLength(2);
  });

  it("reports lease_expired when the completion finds the claim superseded", async () => {
    // The lease is taken over mid-call: the provider returns, but by then the
    // attempt this run claimed is no longer the pending one, so the CAS in
    // `complete` refuses. "Our lease was taken over" is the honest reading.
    const provider = fakeProvider();
    const original = provider.draftResponse.bind(provider);
    provider.draftResponse = async (context) => {
      const result = await original(context);
      const runtime = demoRuntimeStore();
      const index = runtime.generationAttempts.findIndex(
        (row) => row.mentionId === FOOD_SAFETY_MENTION_ID && row.status === "pending",
      );
      const attempt = runtime.generationAttempts[index];
      if (attempt) {
        runtime.generationAttempts[index] = { ...attempt, claimToken: crypto.randomUUID() };
      }
      return result;
    };

    const result = await generateResponseDraft(
      { dataSource, scope },
      FOOD_SAFETY_MENTION_ID,
      provider,
    );

    expect(result).toEqual({ kind: "failed", category: "lease_expired" });
    expect(draftsFor(FOOD_SAFETY_MENTION_ID)).toHaveLength(0);
  });

  it("refuses a role without response.generate, before any model call", async () => {
    const provider = fakeProvider();

    await expect(
      generateResponseDraft({ dataSource, scope: ushg.analyst() }, FOOD_SAFETY_MENTION_ID, provider),
    ).rejects.toBeInstanceOf(DataError);
    expect(provider.contexts).toHaveLength(0);
  });

  it("fails closed on a mention that does not exist", async () => {
    await expect(
      generateResponseDraft(
        { dataSource, scope },
        seedId("mention:does-not-exist"),
        fakeProvider(),
      ),
    ).rejects.toBeInstanceOf(DataError);
  });
});
