import { describe, expect, it } from "vitest";
import { generationAttemptSchema } from "@/domain";

/**
 * Generation-attempt schema: the claim/lease row a generation worker writes
 * while producing a response draft (Task 1 of the response-generation plan).
 */

const ORG_ID = "1a2b3c4d-1111-4a22-8b33-1a2b3c4d5e6f";
const ID = "2a2b3c4d-2222-4a22-8b33-1a2b3c4d5e6f";
const MENTION_ID = "3a2b3c4d-3333-4a22-8b33-1a2b3c4d5e6f";
const USER_ID = "4a2b3c4d-4444-4a22-8b33-1a2b3c4d5e6f";

function validAttempt() {
  return {
    id: ID,
    organizationId: ORG_ID,
    mentionId: MENTION_ID,
    status: "pending",
    failureCategory: null,
    claimedByUserId: USER_ID,
    claimedAt: "2026-08-12T10:00:00.000Z",
    expiresAt: "2026-08-12T10:05:00.000Z",
    finishedAt: null,
    responseDraftId: null,
    promptVersion: "v1",
    brandVoiceSource: "configured",
    brandVoiceVersion: "v3",
    analysisIncluded: true,
    dedupHits: 0,
    modelProvider: null,
    modelName: null,
    inputTokens: null,
    outputTokens: null,
    latencyMs: null,
    createdAt: "2026-08-12T10:00:00.000Z",
    updatedAt: "2026-08-12T10:00:00.000Z",
  };
}

describe("generationAttemptSchema", () => {
  it("parses a valid attempt", () => {
    const parsed = generationAttemptSchema.parse(validAttempt());
    expect(parsed.status).toBe("pending");
    expect(parsed.dedupHits).toBe(0);
  });

  it("rejects an unknown status", () => {
    expect(() =>
      generationAttemptSchema.parse({ ...validAttempt(), status: "in_progress" }),
    ).toThrow();
  });

  it("rejects a negative dedupHits", () => {
    expect(() =>
      generationAttemptSchema.parse({ ...validAttempt(), dedupHits: -1 }),
    ).toThrow();
  });
});
