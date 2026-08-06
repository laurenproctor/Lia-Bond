import { describe, expect, it } from "vitest";
import {
  approvalTimelineEntries,
  hasHumanEdit,
} from "@/lib/view-models/response";
import type { Approval, ResponseDraft } from "@/domain";

const baseDraft = {
  id: "d1",
  organizationId: "org1",
  mentionId: "m1",
  responseType: "public_reply",
  draftText: "Thank you for the kind words.",
  finalText: null,
  status: "draft",
  generatedBy: "ai",
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
  createdAt: "2026-08-01T10:00:00.000Z",
  updatedAt: "2026-08-01T10:00:00.000Z",
} as ResponseDraft;

const baseApproval = {
  id: "a1",
  organizationId: "org1",
  responseDraftId: "d1",
  requestedByUserId: "u1",
  assignedToUserId: "u2",
  status: "approved",
  decisionNote: "Reads well.",
  decidedAt: "2026-08-02T09:00:00.000Z",
  createdAt: "2026-08-01T12:00:00.000Z",
  updatedAt: "2026-08-02T09:00:00.000Z",
} as Approval;

describe("hasHumanEdit", () => {
  it("is false while finalText is unset", () => {
    expect(hasHumanEdit(baseDraft)).toBe(false);
  });

  it("is false when finalText matches the draft", () => {
    expect(
      hasHumanEdit({ ...baseDraft, finalText: baseDraft.draftText }),
    ).toBe(false);
  });

  it("is true when a person changed the text", () => {
    expect(hasHumanEdit({ ...baseDraft, finalText: "Edited." })).toBe(true);
  });
});

describe("approvalTimelineEntries", () => {
  const names = new Map([["u2", "Dana Kim"]]);

  it("maps an approval to a timeline entry with the decider's name", () => {
    const [entry] = approvalTimelineEntries([baseApproval], names);
    expect(entry?.id).toBe("a1");
    expect(entry?.tone).toBe("green");
    expect(entry?.meta).toContain("Dana Kim");
    expect(entry?.meta).toContain("Reads well.");
  });

  it("uses createdAt while the approval is undecided and tones it amber", () => {
    const [entry] = approvalTimelineEntries(
      [{ ...baseApproval, status: "pending", decidedAt: null, decisionNote: null }],
      names,
    );
    expect(entry?.tone).toBe("amber");
    expect(entry?.timestamp.length).toBeGreaterThan(0);
  });

  it("omits meta when there is no name and no note", () => {
    const [entry] = approvalTimelineEntries(
      [{ ...baseApproval, assignedToUserId: null, decisionNote: null }],
      names,
    );
    expect(entry?.meta).toBeUndefined();
  });
});
