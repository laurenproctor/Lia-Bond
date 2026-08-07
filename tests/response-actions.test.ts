import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  decideResponseDraftAction,
  saveResponseDraftAction,
} from "@/app/actions/responses";
import { canDecideOnDraft, canEditDraft } from "@/domain";
import { can } from "@/lib/auth/permissions";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import { freshDataSource, ushg } from "./helpers/scope";

/**
 * `response.edit` permission and the actions that use it.
 *
 * `saveResponseDraftAction` persists a human's edit to a draft's final text
 * outside of a decision; `decideResponseDraftAction` optionally carries a
 * final-text edit atomically with an approve/reject. Both must record a
 * lengths-only `response.edited` audit event (D111) — never the prose.
 *
 * `@/lib/actions/guard`'s `authorize` is mocked the same way
 * `monitoring-actions.test.ts` mocks it, so this runs with no `next/headers`
 * session machinery while the mocked context still carries a real demo
 * `dataSource`.
 */

const authorizeMock = vi.fn();

vi.mock("@/lib/actions/guard", () => ({
  authorize: (permission: string) => authorizeMock(permission),
}));

// `revalidatePath` requires a live Next.js request scope that does not exist
// under Vitest; every action under test calls it on the success path, so it
// is stubbed to a no-op the same way a route or component test would get it
// for free from the Next test runtime.
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

let dataSource: LiaDataSource;

function contextFor(scope: OrganizationScope) {
  return {
    // Only `scope`, `userId`, `role`, and `dataSource` are read by the code
    // under test; the rest of `MutationContext` is unused here.
    organization: { id: scope.organizationId },
    role: scope.role,
    userId: scope.userId,
    scope,
    available: [],
    dataSource,
  };
}

beforeEach(() => {
  dataSource = freshDataSource();
  authorizeMock.mockReset();
});

describe("response.edit permission", () => {
  it("grants owner, admin, communications lead, and approver — nobody else", () => {
    expect(can("owner", "response.edit")).toBe(true);
    expect(can("admin", "response.edit")).toBe(true);
    expect(can("communications_lead", "response.edit")).toBe(true);
    expect(can("approver", "response.edit")).toBe(true);
    expect(can("analyst", "response.edit")).toBe(false);
    expect(can("viewer", "response.edit")).toBe(false);
    expect(can("location_manager", "response.edit")).toBe(false);
  });
});

describe("saveResponseDraftAction", () => {
  it("authorizes response.edit, saves, and records a lengths-only audit event", async () => {
    const scope = ushg.admin();
    authorizeMock.mockResolvedValue(contextFor(scope));

    const drafts = await dataSource.responseDrafts.list(scope);
    const editable = drafts.find((draft) => canEditDraft(draft.status));
    if (!editable) throw new Error("Fixture expected an editable draft.");

    const previousLength = editable.finalText?.length ?? null;

    const result = await saveResponseDraftAction({
      responseDraftId: editable.id,
      finalText: "Edited.",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.finalText).toBe("Edited.");

    expect(authorizeMock).toHaveBeenCalledWith("response.edit");

    const events = await dataSource.auditEvents.list(scope, {
      entityType: "response_draft",
      entityId: editable.id,
    });
    const editEvents = events.filter((event) => event.eventType === "response.edited");
    expect(editEvents).toHaveLength(1);

    const event = editEvents[0];
    if (!event) throw new Error("Expected an edit audit event.");
    expect(event.newState).toEqual({ finalTextLength: "Edited.".length });
    expect(event.previousState).toEqual({ finalTextLength: previousLength });

    const eventText = JSON.stringify([event.previousState, event.newState]);
    expect(eventText).not.toContain("Edited.");
    expect(eventText).not.toContain(editable.draftText);
  });

  it("surfaces the conflict when the draft is already decided", async () => {
    const scope = ushg.admin();
    authorizeMock.mockResolvedValue(contextFor(scope));

    const drafts = await dataSource.responseDrafts.list(scope);
    const decided = drafts.find((draft) => !canEditDraft(draft.status));
    if (!decided) throw new Error("Fixture expected an already-decided draft.");

    const result = await saveResponseDraftAction({
      responseDraftId: decided.id,
      finalText: "Edited.",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/can no longer be edited/);
  });
});

describe("decideResponseDraftAction with finalText", () => {
  it("applies the text and records both events", async () => {
    const scope = ushg.admin();
    authorizeMock.mockResolvedValue(contextFor(scope));

    const drafts = await dataSource.responseDrafts.list(scope);
    const editable = drafts.find((draft) => canDecideOnDraft(draft.status));
    if (!editable) throw new Error("Fixture expected a decidable draft.");

    const newText = "This is the approver's amended reply.";
    expect(newText).not.toBe(editable.finalText);

    const result = await decideResponseDraftAction({
      responseDraftId: editable.id,
      decision: "approved",
      finalText: newText,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("approved");
    expect(result.data.finalText).toBe(newText);

    const events = await dataSource.auditEvents.list(scope, {
      entityType: "response_draft",
      entityId: editable.id,
    });
    const eventTypes = events.map((event) => event.eventType);
    expect(eventTypes).toContain("response.approved");
    expect(eventTypes).toContain("response.edited");

    const editEvent = events.find((event) => event.eventType === "response.edited");
    expect(editEvent?.newState).toEqual({ finalTextLength: newText.length });
  });

  it("records no edit event when the text did not change", async () => {
    const scope = ushg.admin();
    authorizeMock.mockResolvedValue(contextFor(scope));

    const drafts = await dataSource.responseDrafts.list(scope);
    const editable = drafts.find((draft) => canDecideOnDraft(draft.status));
    if (!editable) throw new Error("Fixture expected a decidable draft.");

    const result = await decideResponseDraftAction({
      responseDraftId: editable.id,
      decision: "approved",
    });

    expect(result.ok).toBe(true);

    const events = await dataSource.auditEvents.list(scope, {
      entityType: "response_draft",
      entityId: editable.id,
    });
    const eventTypes = events.map((event) => event.eventType);
    expect(eventTypes).toContain("response.approved");
    expect(eventTypes).not.toContain("response.edited");
  });
});
