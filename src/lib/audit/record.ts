import type { AuditEntityType, AuditEventType, JsonObject } from "@/domain";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";

/**
 * Audit recording.
 *
 * One function, used by every mutation. Centralising it means an action cannot
 * quietly skip the trail, and the shape of what gets captured — actor,
 * organization, entity, before, after — is decided once rather than per action.
 *
 * `diff` is the important part: recording whole rows would bury the change in
 * noise, so only the fields that actually moved are stored.
 */

export interface AuditContext {
  dataSource: LiaDataSource;
  scope: OrganizationScope;
}

export interface AuditWrite {
  eventType: AuditEventType;
  entityType: AuditEntityType;
  entityId: string;
  previousState: JsonObject | null;
  newState: JsonObject | null;
  metadata?: JsonObject;
  /** Defaults to "user". Rules and sync jobs pass their own actor type. */
  actorType?: "user" | "system" | "ai" | "integration";
}

export async function recordAuditEvent(
  { dataSource, scope }: AuditContext,
  write: AuditWrite,
): Promise<void> {
  const actorType = write.actorType ?? "user";

  await dataSource.auditEvents.record(scope, {
    actorUserId: actorType === "user" ? scope.userId : null,
    actorType,
    eventType: write.eventType,
    entityType: write.entityType,
    entityId: write.entityId,
    previousState: write.previousState,
    newState: write.newState,
    metadata: write.metadata ?? {},
  });
}

/**
 * The fields that changed, before and after.
 *
 * Only tracks the keys named in `keys`, so an `updatedAt` bump never shows up
 * as a change a person made.
 */
export function diff<T extends Record<string, unknown>>(
  before: T,
  after: T,
  keys: (keyof T)[],
): { previousState: JsonObject; newState: JsonObject } {
  const previousState: JsonObject = {};
  const newState: JsonObject = {};

  for (const key of keys) {
    if (before[key] === after[key]) continue;
    previousState[String(key)] = toJson(before[key]);
    newState[String(key)] = toJson(after[key]);
  }

  return { previousState, newState };
}

function toJson(value: unknown): JsonObject[string] {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  return String(value);
}
