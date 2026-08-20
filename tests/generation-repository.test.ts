import { describe, expect, it } from "vitest";
import type { DraftingContext } from "@/lib/responses/drafting-context";
import { demoRuntimeStore, demoStore } from "@/lib/data/demo/store";
import type { ResponseDraft } from "@/domain";
import { DataError } from "@/lib/data/errors";
import { MENTION_LABELS } from "@/lib/seed/dataset";
import { seedId } from "@/lib/seed/ids";
import { freshDataSource, scopeFor, ushg, ORG_USHG } from "./helpers/scope";

/**
 * `GenerationAttemptRepository`: the demo twin of `claim_generation_attempt`
 * / `complete_generation_attempt` / `fail_generation_attempt`
 * (`supabase/migrations/20260813000200_generation_functions.sql`).
 *
 * The Supabase adapter is exercised only by type-checking (this repository
 * has never run against a live database — see the adapter's own file
 * header); every behavioural case here runs against the demo twin, which is
 * required to reproduce the SQL's outcomes exactly.
 */

// Two google_review mentions that carry no seeded response draft, so a claim
// against either starts from a clean slate.
const FOOD_SAFETY_MENTION_ID = seedId(`mention:${MENTION_LABELS.foodSafety}`);
const BRUNCH_MENTION_ID = seedId(`mention:${MENTION_LABELS.googleBrunch}`);
// A google_review mention that already carries a seeded draft.
const OVERPRICED_MENTION_ID = seedId(`mention:${MENTION_LABELS.overpriced}`);
const OVERPRICED_DRAFT_ID = seedId("draft:overpriced");

function fixtureContext(): DraftingContext {
  return {
    review: {
      text: "Service was slow but the food was great.",
      rating: 3,
      authorName: "Test Author",
      publishedAt: "2026-08-10T12:00:00.000Z",
      locationName: "SoHo",
    },
    business: {
      organizationName: "Maison Laurent",
      defaultLanguage: "en-US",
    },
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

function claimInput(overrides: Partial<{
  mentionId: string;
  brandVoiceVersion: string | null;
  leaseSeconds: number;
}> = {}) {
  return {
    mentionId: overrides.mentionId ?? FOOD_SAFETY_MENTION_ID,
    context: fixtureContext(),
    contextHash: "hash-1",
    promptVersion: "drafting@2026-08-07",
    brandVoiceSource: "configured" as const,
    brandVoiceVersion: overrides.brandVoiceVersion ?? "7",
    analysisIncluded: false,
    ...(overrides.leaseSeconds !== undefined ? { leaseSeconds: overrides.leaseSeconds } : {}),
  };
}

/** Backdate a demo attempt's lease so the next claim finds it expired. */
function backdateLease(attemptId: string): void {
  const rows = demoRuntimeStore().generationAttempts;
  const index = rows.findIndex((row) => row.id === attemptId);
  const attempt = rows[index];
  if (!attempt) throw new Error(`Attempt ${attemptId} not found`);
  rows[index] = {
    ...attempt,
    expiresAt: new Date(Date.now() - 60_000).toISOString(),
  };
}

describe("generationAttempts.claim", () => {
  it("claims a pending attempt and returns a token", async () => {
    const ds = freshDataSource();
    const scope = ushg.comms();

    const result = await ds.generationAttempts.claim(scope, claimInput());

    expect(result.outcome).toBe("claimed");
    if (result.outcome !== "claimed") throw new Error("expected claimed");
    expect(result.attemptId).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.claimToken).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.attemptId).not.toBe(result.claimToken);
  });

  it("returns in_progress with no token and increments dedupHits on a second live claim", async () => {
    const ds = freshDataSource();
    const first = await ds.generationAttempts.claim(ushg.comms(), claimInput());
    if (first.outcome !== "claimed") throw new Error("expected claimed");

    const second = await ds.generationAttempts.claim(ushg.owner(), claimInput());

    expect(second).toEqual({ outcome: "in_progress", attemptId: first.attemptId });
    expect(second).not.toHaveProperty("claimToken");

    const stored = demoRuntimeStore().generationAttempts.find(
      (row) => row.id === first.attemptId,
    );
    expect(stored?.dedupHits).toBe(1);
    expect(stored?.status).toBe("pending");
  });

  it("short-circuits to draft_exists when a draft already exists for the mention", async () => {
    const ds = freshDataSource();
    const result = await ds.generationAttempts.claim(
      ushg.comms(),
      claimInput({ mentionId: OVERPRICED_MENTION_ID }),
    );

    expect(result).toEqual({ outcome: "draft_exists", responseDraftId: OVERPRICED_DRAFT_ID });
    // No attempt row was created for a short-circuited claim.
    expect(
      demoRuntimeStore().generationAttempts.some(
        (row) => row.mentionId === OVERPRICED_MENTION_ID,
      ),
    ).toBe(false);
  });

  it("closes an expired lease as lease_expired and lets a new claim succeed", async () => {
    const ds = freshDataSource();
    const scope = ushg.comms();

    const first = await ds.generationAttempts.claim(scope, claimInput());
    if (first.outcome !== "claimed") throw new Error("expected claimed");
    backdateLease(first.attemptId);

    const second = await ds.generationAttempts.claim(scope, claimInput());

    expect(second.outcome).toBe("claimed");
    if (second.outcome !== "claimed") throw new Error("expected claimed");
    expect(second.attemptId).not.toBe(first.attemptId);

    const closed = demoRuntimeStore().generationAttempts.find(
      (row) => row.id === first.attemptId,
    );
    expect(closed?.status).toBe("failed");
    expect(closed?.failureCategory).toBe("lease_expired");
    expect(closed?.finishedAt).not.toBeNull();
  });

  it("closes an expired lease even when a draft already exists for the mention", async () => {
    // The sweep runs BEFORE the draft_exists check — an expired pending
    // attempt is reaped even on a mention that already carries a draft, so
    // it never gets stranded at status='pending' forever. See the migration
    // header on `claim_generation_attempt`.
    const ds = freshDataSource();
    const scope = ushg.comms();

    const first = await ds.generationAttempts.claim(
      scope,
      claimInput({ mentionId: BRUNCH_MENTION_ID }),
    );
    if (first.outcome !== "claimed") throw new Error("expected claimed");
    backdateLease(first.attemptId);

    // A human writes a manual draft out of band while the lease is stale —
    // pushed directly onto the store, since `ResponseDraftRepository` has no
    // create method of its own (drafts arrive only via `complete` or, here,
    // a fixture standing in for a manual entry).
    const manualTimestamp = new Date().toISOString();
    const manualDraft: ResponseDraft = {
      id: "9a2b3c4d-8888-4a22-8b33-1a2b3c4d5e6f",
      organizationId: ORG_USHG,
      mentionId: BRUNCH_MENTION_ID,
      responseType: "public_reply",
      draftText: "Manual draft written before generation ran.",
      finalText: null,
      status: "draft",
      generatedBy: "user",
      generationProvider: null,
      generationModel: null,
      promptVersion: null,
      brandVoiceVersion: null,
      policyVersion: null,
      assignedUserId: null,
      approvedByUserId: null,
      approvedAt: null,
      publishedAt: null,
      externalResponseId: null,
      publicationError: null,
      publicationMethod: null,
      publishedByUserId: null,
      createdAt: manualTimestamp,
      updatedAt: manualTimestamp,
    };
    demoStore().responseDrafts.push(manualDraft);

    const result = await ds.generationAttempts.claim(
      scope,
      claimInput({ mentionId: BRUNCH_MENTION_ID }),
    );

    // A draft now exists, so the short-circuit answers draft_exists — but
    // the expired lease must still be swept, not left stranded pending.
    expect(result).toEqual({ outcome: "draft_exists", responseDraftId: manualDraft.id });
    const closed = demoRuntimeStore().generationAttempts.find(
      (row) => row.id === first.attemptId,
    );
    expect(closed?.status).toBe("failed");
    expect(closed?.failureCategory).toBe("lease_expired");
  });

  it("throws forbidden for a viewer", async () => {
    const ds = freshDataSource();
    const viewer = scopeFor(ORG_USHG, "6a2b3c4d-9999-4a22-8b33-1a2b3c4d5e6f", "viewer");

    await expect(ds.generationAttempts.claim(viewer, claimInput())).rejects.toMatchObject({
      code: "forbidden",
    } satisfies Partial<DataError>);
  });

  it("throws forbidden for a location manager", async () => {
    const ds = freshDataSource();

    await expect(
      ds.generationAttempts.claim(ushg.locationManager(), claimInput()),
    ).rejects.toMatchObject({ code: "forbidden" } satisfies Partial<DataError>);
  });
});

describe("generationAttempts.complete", () => {
  it("returns superseded for the wrong token and leaves the attempt untouched", async () => {
    const ds = freshDataSource();
    const scope = ushg.comms();
    const claimed = await ds.generationAttempts.claim(scope, claimInput());
    if (claimed.outcome !== "claimed") throw new Error("expected claimed");

    const result = await ds.generationAttempts.complete(scope, {
      attemptId: claimed.attemptId,
      claimToken: "00000000-0000-0000-0000-000000000000",
      draftText: "Thank you for the feedback.",
      renderedSystemHash: "sys-hash",
      renderedUserHash: "user-hash",
      outputSchemaVersion: "draft-output@1",
      modelProvider: "anthropic",
      modelName: "claude-opus-5",
      maxOutputTokens: 800,
      temperature: null,
      providerRequestId: null,
      inputTokens: 120,
      outputTokens: 80,
      latencyMs: 900,
    });

    expect(result).toEqual({ outcome: "superseded" });
    const stored = demoRuntimeStore().generationAttempts.find(
      (row) => row.id === claimed.attemptId,
    );
    expect(stored?.status).toBe("pending");
  });

  it("creates a public_reply ai draft stamped with provenance and exactly one audit event, on the right token", async () => {
    const ds = freshDataSource();
    const scope = ushg.comms();
    const claimed = await ds.generationAttempts.claim(
      scope,
      claimInput({ brandVoiceVersion: "9" }),
    );
    if (claimed.outcome !== "claimed") throw new Error("expected claimed");

    const result = await ds.generationAttempts.complete(scope, {
      attemptId: claimed.attemptId,
      claimToken: claimed.claimToken,
      draftText: "Thank you for the feedback — we're sorry to hear this.",
      renderedSystemHash: "sys-hash",
      renderedUserHash: "user-hash",
      outputSchemaVersion: "draft-output@1",
      modelProvider: "anthropic",
      modelName: "claude-opus-5",
      maxOutputTokens: 800,
      temperature: 0.4,
      providerRequestId: "req-123",
      inputTokens: 120,
      outputTokens: 80,
      latencyMs: 900,
    });

    expect(result.outcome).toBe("completed");
    if (result.outcome !== "completed") throw new Error("expected completed");

    const draft = await ds.responseDrafts.get(scope, result.responseDraftId);
    expect(draft).not.toBeNull();
    expect(draft?.responseType).toBe("public_reply");
    expect(draft?.generatedBy).toBe("ai");
    expect(draft?.status).toBe("draft");
    expect(draft?.mentionId).toBe(FOOD_SAFETY_MENTION_ID);
    expect(draft?.promptVersion).toBe("drafting@2026-08-07");
    expect(draft?.brandVoiceVersion).toBe("9");
    expect(draft?.draftText).toBe("Thank you for the feedback — we're sorry to hear this.");

    const attempt = demoRuntimeStore().generationAttempts.find(
      (row) => row.id === claimed.attemptId,
    );
    expect(attempt?.status).toBe("completed");
    expect(attempt?.responseDraftId).toBe(result.responseDraftId);

    const events = await ds.auditEvents.list(scope, {
      entityId: result.responseDraftId,
      eventTypes: ["response.generated"],
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.actorType).toBe("ai");
    expect(events[0]?.entityType).toBe("response_draft");
  });

  it("returns superseded and leaves exactly one draft on a double complete", async () => {
    const ds = freshDataSource();
    const scope = ushg.comms();
    const claimed = await ds.generationAttempts.claim(scope, claimInput());
    if (claimed.outcome !== "claimed") throw new Error("expected claimed");

    const completeInput = {
      attemptId: claimed.attemptId,
      claimToken: claimed.claimToken,
      draftText: "Thank you for the feedback.",
      renderedSystemHash: "sys-hash",
      renderedUserHash: "user-hash",
      outputSchemaVersion: "draft-output@1",
      modelProvider: "anthropic",
      modelName: "claude-opus-5",
      maxOutputTokens: 800,
      temperature: null,
      providerRequestId: null,
      inputTokens: 120,
      outputTokens: 80,
      latencyMs: 900,
    };

    const first = await ds.generationAttempts.complete(scope, completeInput);
    const second = await ds.generationAttempts.complete(scope, completeInput);

    expect(first.outcome).toBe("completed");
    expect(second).toEqual({ outcome: "superseded" });

    const drafts = await ds.responseDrafts.list(scope, { mentionId: FOOD_SAFETY_MENTION_ID });
    expect(drafts).toHaveLength(1);
  });
});

describe("generationAttempts.fail", () => {
  it("marks the attempt failed on the right token, then supersedes a second call", async () => {
    const ds = freshDataSource();
    const scope = ushg.comms();
    const claimed = await ds.generationAttempts.claim(scope, claimInput());
    if (claimed.outcome !== "claimed") throw new Error("expected claimed");

    const failInput = {
      attemptId: claimed.attemptId,
      claimToken: claimed.claimToken,
      failureCategory: "invalid_output" as const,
      latencyMs: 400,
      providerRequestId: "req-456",
    };

    const first = await ds.generationAttempts.fail(scope, failInput);
    expect(first).toBe("failed");

    const stored = demoRuntimeStore().generationAttempts.find(
      (row) => row.id === claimed.attemptId,
    );
    expect(stored?.status).toBe("failed");
    expect(stored?.failureCategory).toBe("invalid_output");
    expect(stored?.finishedAt).not.toBeNull();

    const second = await ds.generationAttempts.fail(scope, failInput);
    expect(second).toBe("superseded");
  });

  it("returns superseded for an unknown attempt", async () => {
    const ds = freshDataSource();
    const scope = ushg.comms();

    const outcome = await ds.generationAttempts.fail(scope, {
      attemptId: "00000000-0000-0000-0000-000000000000",
      claimToken: "00000000-0000-0000-0000-000000000000",
      failureCategory: "provider_error",
      latencyMs: 100,
      providerRequestId: null,
    });

    expect(outcome).toBe("superseded");
  });
});

describe("generationAttempts.latestForMention", () => {
  it("returns null when no attempt has ever been made", async () => {
    const ds = freshDataSource();
    const result = await ds.generationAttempts.latestForMention(
      ushg.comms(),
      FOOD_SAFETY_MENTION_ID,
    );
    expect(result).toBeNull();
  });

  it("returns the newest attempt, whatever its status, and never carries a claim token", async () => {
    const ds = freshDataSource();
    const scope = ushg.comms();

    const first = await ds.generationAttempts.claim(scope, claimInput());
    if (first.outcome !== "claimed") throw new Error("expected claimed");
    await ds.generationAttempts.fail(scope, {
      attemptId: first.attemptId,
      claimToken: first.claimToken,
      failureCategory: "provider_error",
      latencyMs: 200,
      providerRequestId: null,
    });

    const second = await ds.generationAttempts.claim(scope, claimInput());
    if (second.outcome !== "claimed") throw new Error("expected claimed");

    const latest = await ds.generationAttempts.latestForMention(scope, FOOD_SAFETY_MENTION_ID);

    expect(latest?.id).toBe(second.attemptId);
    expect(latest?.status).toBe("pending");
    expect(latest).not.toHaveProperty("claimToken");
  });
});
