import { describe, expect, it } from "vitest";
import {
  canDecideOnDraft,
  canEditDraft,
  decideResponseDraftInputSchema,
  EDITABLE_DRAFT_STATUSES,
  saveResponseDraftInputSchema,
} from "@/domain";
import { AUDIT_EVENT_TYPES, RESPONSE_DRAFT_STATUSES } from "@/domain/enums";

const DRAFT_ID = "5b3f8a52-7c1d-4e2a-9f6b-1a2b3c4d5e6f";

describe("canEditDraft", () => {
  it("mirrors canDecideOnDraft across every status", () => {
    for (const status of RESPONSE_DRAFT_STATUSES) {
      expect(canEditDraft(status)).toBe(canDecideOnDraft(status));
    }
  });

  it("exposes the same status set as deciding", () => {
    expect(EDITABLE_DRAFT_STATUSES).toEqual(["draft", "awaiting_approval"]);
  });
});

describe("saveResponseDraftInputSchema", () => {
  it("accepts an id and non-empty text", () => {
    const parsed = saveResponseDraftInputSchema.parse({
      responseDraftId: DRAFT_ID,
      finalText: "Thank you for letting us know.",
    });
    expect(parsed.finalText).toBe("Thank you for letting us know.");
  });

  it("refuses empty text", () => {
    expect(() =>
      saveResponseDraftInputSchema.parse({ responseDraftId: DRAFT_ID, finalText: "" }),
    ).toThrow();
  });

  it("refuses text over 5000 characters", () => {
    expect(() =>
      saveResponseDraftInputSchema.parse({
        responseDraftId: DRAFT_ID,
        finalText: "x".repeat(5001),
      }),
    ).toThrow();
  });
});

describe("decideResponseDraftInputSchema", () => {
  it("still parses without finalText", () => {
    const parsed = decideResponseDraftInputSchema.parse({
      responseDraftId: DRAFT_ID,
      decision: "approved",
    });
    expect(parsed.finalText).toBeUndefined();
  });

  it("carries finalText when provided", () => {
    const parsed = decideResponseDraftInputSchema.parse({
      responseDraftId: DRAFT_ID,
      decision: "approved",
      finalText: "Amended before approval.",
    });
    expect(parsed.finalText).toBe("Amended before approval.");
  });

  it("accepts changes_requested", () => {
    const parsed = decideResponseDraftInputSchema.parse({
      responseDraftId: DRAFT_ID,
      decision: "changes_requested",
    });
    expect(parsed.decision).toBe("changes_requested");
  });

  it("rejects the old rejected literal", () => {
    expect(() =>
      decideResponseDraftInputSchema.parse({
        responseDraftId: DRAFT_ID,
        decision: "rejected",
      }),
    ).toThrow();
  });
});

describe("audit vocabulary", () => {
  it("includes response.edited", () => {
    expect(AUDIT_EVENT_TYPES).toContain("response.edited");
  });
});
