import { describe, expect, it } from "vitest";
import type { GenerationAttempt, Mention } from "@/domain";
import {
  resolveGenerateButtonState,
  resolveGenerateButtonView,
} from "@/lib/responses/generate-button-state";
import { SEED_DATASET } from "@/lib/seed/dataset";

/**
 * The generate control's state machine.
 *
 * Tested as a pure function rather than through a rendered tree (the
 * `execution-history.ts` precedent): each state is a claim about what a click
 * would do, and those are worth pinning directly.
 */

function mentionOfType(sourceType: Mention["sourceType"]): Mention {
  const found = SEED_DATASET.mentions.find((row) => row.sourceType === sourceType);
  if (!found) throw new Error(`Fixture expected a ${sourceType} mention.`);
  return found;
}

const GOOGLE_REVIEW = mentionOfType("google_review");

function attempt(overrides: Partial<GenerationAttempt> = {}): GenerationAttempt {
  return {
    id: "attempt-1",
    organizationId: GOOGLE_REVIEW.organizationId,
    mentionId: GOOGLE_REVIEW.id,
    status: "pending",
    failureCategory: null,
    claimedByUserId: "user-1",
    claimedAt: "2026-08-12T12:00:00.000Z",
    expiresAt: "2026-08-12T12:02:00.000Z",
    finishedAt: null,
    responseDraftId: null,
    promptVersion: "drafting@2026-08-12",
    brandVoiceSource: "configured",
    brandVoiceVersion: "1",
    analysisIncluded: true,
    dedupHits: 0,
    modelProvider: null,
    modelName: null,
    inputTokens: null,
    outputTokens: null,
    latencyMs: null,
    createdAt: "2026-08-12T12:00:00.000Z",
    updatedAt: "2026-08-12T12:00:00.000Z",
    ...overrides,
  };
}

describe("resolveGenerateButtonState", () => {
  it("offers generation on a Google review with no draft", () => {
    expect(resolveGenerateButtonState(GOOGLE_REVIEW, null, false)).toBe("ready");
  });

  it("hides itself on every source other than a Google review", () => {
    for (const sourceType of ["reddit_post", "news_article"] as const) {
      const mention = SEED_DATASET.mentions.find((row) => row.sourceType === sourceType);
      if (!mention) continue;
      expect(resolveGenerateButtonState(mention, null, false)).toBe("hidden");
    }
  });

  it("hides itself once any draft exists, whatever its status", () => {
    expect(resolveGenerateButtonState(GOOGLE_REVIEW, null, true)).toBe("hidden");
    expect(
      resolveGenerateButtonState(GOOGLE_REVIEW, attempt({ status: "completed" }), true),
    ).toBe("hidden");
  });

  it("shows pending while an attempt is live", () => {
    expect(resolveGenerateButtonState(GOOGLE_REVIEW, attempt(), false)).toBe("pending");
  });

  it("offers a retry when the newest attempt failed", () => {
    expect(
      resolveGenerateButtonState(
        GOOGLE_REVIEW,
        attempt({ status: "failed", failureCategory: "provider_error" }),
        false,
      ),
    ).toBe("failed_retry");
  });

  it("goes back to ready once a completed attempt is the newest", () => {
    // A completed attempt whose draft has since been deleted: nothing is
    // running and nothing failed, so a click is a fresh generation.
    expect(
      resolveGenerateButtonState(GOOGLE_REVIEW, attempt({ status: "completed" }), false),
    ).toBe("ready");
  });
});

describe("resolveGenerateButtonView", () => {
  it("names the failure category without quoting the model", () => {
    const provider = resolveGenerateButtonView(
      GOOGLE_REVIEW,
      attempt({ status: "failed", failureCategory: "provider_error" }),
      false,
    );
    const invalid = resolveGenerateButtonView(
      GOOGLE_REVIEW,
      attempt({ status: "failed", failureCategory: "invalid_output" }),
      false,
    );

    expect(provider.hint).toBe("Generation failed — try again");
    expect(invalid.hint).toBe("The response didn't pass validation — try again");
    expect(provider.label).toBe("Generate response");
  });

  it("labels the ready state in sentence case with no hint", () => {
    expect(resolveGenerateButtonView(GOOGLE_REVIEW, null, false)).toEqual({
      state: "ready",
      label: "Generate response",
      hint: null,
    });
  });

  it("explains the pending state", () => {
    const view = resolveGenerateButtonView(GOOGLE_REVIEW, attempt(), false);
    expect(view.state).toBe("pending");
    expect(view.label).toBe("Generating response");
    expect(view.hint).not.toBeNull();
  });

  it("renders nothing at all when hidden", () => {
    expect(resolveGenerateButtonView(GOOGLE_REVIEW, null, true)).toEqual({
      state: "hidden",
      label: null,
      hint: null,
    });
  });
});
