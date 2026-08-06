import { describe, expect, it } from "vitest";
import { escalationTimelineEntries } from "@/lib/view-models/escalation";
import type { AuditEvent } from "@/domain";

const baseEvent = {
  id: "e1",
  organizationId: "org1",
  actorUserId: "u1",
  actorType: "user",
  eventType: "escalation.status_changed",
  entityType: "escalation",
  entityId: "esc1",
  previousState: { status: "open" },
  newState: { status: "resolved" },
  metadata: {},
  occurredAt: "2026-08-03T15:00:00.000Z",
} as AuditEvent;

describe("escalationTimelineEntries", () => {
  const names = new Map([["u1", "Riley Otero"]]);

  it("maps an event to a titled, timestamped entry with the actor's name", () => {
    const [entry] = escalationTimelineEntries([baseEvent], names);
    expect(entry?.id).toBe("e1");
    expect(entry?.title).toBe("Escalation status changed");
    expect(entry?.meta).toBe("Riley Otero");
    expect(entry?.timestamp.length).toBeGreaterThan(0);
  });

  it("falls back to the humanized actor type when there is no person", () => {
    const [entry] = escalationTimelineEntries(
      [{ ...baseEvent, actorUserId: null, actorType: "system" }],
      names,
    );
    expect(entry?.meta).toBe("System");
  });

  it("tones assignment purple and other events neutral", () => {
    const [assigned] = escalationTimelineEntries(
      [{ ...baseEvent, eventType: "escalation.assigned" }],
      names,
    );
    const [changed] = escalationTimelineEntries([baseEvent], names);
    expect(assigned?.tone).toBe("purple");
    expect(changed?.tone).toBe("neutral");
  });
});
