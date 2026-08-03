import { beforeEach, describe, expect, it } from "vitest";
import { freshDataSource, ushg } from "./helpers/scope";
import { diff, recordAuditEvent } from "@/lib/audit/record";
import type { LiaDataSource } from "@/lib/data/types";
import { LOC_SOHO, USER_KATE, USER_MARCUS } from "@/lib/seed/dataset";

/**
 * Audit recording.
 *
 * The trail is what makes automation defensible after the fact, so these check
 * that events are attributed, scoped, minimal, and append-only.
 */

let data: LiaDataSource;

beforeEach(() => {
  data = freshDataSource();
});

describe("diff", () => {
  it("records only the fields that changed", () => {
    const before = { status: "new", assignedUserId: null, updatedAt: "a" };
    const after = { status: "analyzed", assignedUserId: null, updatedAt: "b" };

    const result = diff(before, after, ["status", "assignedUserId"]);

    expect(result.previousState).toEqual({ status: "new" });
    expect(result.newState).toEqual({ status: "analyzed" });
    // updatedAt was not requested, so a timestamp bump never reads as a change
    // someone made.
    expect(result.previousState).not.toHaveProperty("updatedAt");
  });

  it("returns empty states when nothing moved", () => {
    const row = { status: "new" };
    const result = diff(row, { ...row }, ["status"]);
    expect(result.previousState).toEqual({});
    expect(result.newState).toEqual({});
  });

  it("serialises nulls rather than dropping them", () => {
    const result = diff(
      { managerUserId: "user-a" },
      { managerUserId: null },
      ["managerUserId"],
    );
    expect(result.previousState).toEqual({ managerUserId: "user-a" });
    expect(result.newState).toEqual({ managerUserId: null });
  });
});

describe("recordAuditEvent", () => {
  it("attributes the event to the acting user and organization", async () => {
    const scope = ushg.admin();

    await recordAuditEvent(
      { dataSource: data, scope },
      {
        eventType: "mention.status_changed",
        entityType: "mention",
        entityId: LOC_SOHO,
        previousState: { status: "new" },
        newState: { status: "analyzed" },
      },
    );

    const [latest] = await data.auditEvents.list(scope, { limit: 1 });
    expect(latest?.actorUserId).toBe(USER_KATE);
    expect(latest?.actorType).toBe("user");
    expect(latest?.organizationId).toBe(scope.organizationId);
  });

  it("attributes non-human actors with no user id", async () => {
    const scope = ushg.admin();

    await recordAuditEvent(
      { dataSource: data, scope },
      {
        eventType: "automation_rule.enabled",
        entityType: "automation_rule",
        entityId: LOC_SOHO,
        previousState: null,
        newState: { status: "active" },
        actorType: "system",
      },
    );

    const [latest] = await data.auditEvents.list(scope, { limit: 1 });
    expect(latest?.actorType).toBe("system");
    expect(latest?.actorUserId).toBeNull();
  });

  it("appends rather than replacing", async () => {
    const scope = ushg.admin();
    const before = await data.auditEvents.list(scope, { limit: 200 });

    for (let index = 0; index < 3; index += 1) {
      await recordAuditEvent(
        { dataSource: data, scope },
        {
          eventType: "response.assigned",
          entityType: "response_draft",
          entityId: LOC_SOHO,
          previousState: { assignedUserId: null },
          newState: { assignedUserId: USER_MARCUS },
        },
      );
    }

    const after = await data.auditEvents.list(scope, { limit: 200 });
    expect(after.length).toBe(before.length + 3);
  });

  it("filters by entity and event type", async () => {
    const scope = ushg.admin();

    await recordAuditEvent(
      { dataSource: data, scope },
      {
        eventType: "escalation.assigned",
        entityType: "escalation",
        entityId: LOC_SOHO,
        previousState: null,
        newState: { assignedUserId: USER_MARCUS },
      },
    );

    const filtered = await data.auditEvents.list(scope, {
      entityType: "escalation",
      entityId: LOC_SOHO,
    });

    expect(filtered.length).toBeGreaterThan(0);
    expect(filtered.every((event) => event.entityType === "escalation")).toBe(true);
    expect(filtered.every((event) => event.entityId === LOC_SOHO)).toBe(true);
  });

  it("returns events newest first", async () => {
    const events = await data.auditEvents.list(ushg.admin(), { limit: 50 });
    const timestamps = events.map((event) => Date.parse(event.occurredAt));
    expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps);
  });

  it("rejects an event that fails validation", async () => {
    await expect(
      data.auditEvents.record(ushg.admin(), {
        actorUserId: null,
        actorType: "user",
        // Not in the closed list of event names.
        eventType: "mention.exploded" as never,
        entityType: "mention",
        entityId: LOC_SOHO,
        previousState: null,
        newState: null,
        metadata: {},
      }),
    ).rejects.toThrow(/could not be recorded/i);
  });

  it("never returns another organization's events", async () => {
    const mine = await data.auditEvents.list(ushg.admin(), { limit: 200 });
    expect(mine.every((event) => event.organizationId === ushg.admin().organizationId)).toBe(
      true,
    );
  });
});
