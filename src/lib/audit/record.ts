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
 *
 * Primitives compare with `===`; anything else (arrays, plain objects) is
 * compared by `JSON.stringify`. That is a real equality check here, not a
 * shortcut: both sides come from the same Zod-parsed shapes (a rule's
 * `conditions`/`actions` before and after a save), so key order is stable
 * and two deep-equal values always stringify identically.
 */
export function diff<T extends Record<string, unknown>>(
  before: T,
  after: T,
  keys: (keyof T)[],
): { previousState: JsonObject; newState: JsonObject } {
  const previousState: JsonObject = {};
  const newState: JsonObject = {};

  for (const key of keys) {
    const beforeValue = before[key];
    const afterValue = after[key];
    const unchanged = isPrimitive(beforeValue)
      ? beforeValue === afterValue
      : JSON.stringify(beforeValue) === JSON.stringify(afterValue);
    if (unchanged) continue;
    previousState[String(key)] = toJson(beforeValue);
    newState[String(key)] = toJson(afterValue);
  }

  return { previousState, newState };
}

function isPrimitive(
  value: unknown,
): value is string | number | boolean | null | undefined {
  return (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  );
}

/**
 * Recursively converts a value into something JSON-shaped for storage in
 * `previousState`/`newState`: primitives pass through, `null`/`undefined`
 * become `null`, arrays and plain objects (the shapes a Zod-parsed rule
 * config actually produces) map their entries recursively. Anything else —
 * a `Date`, a class instance — falls back to `String(value)`: those are not
 * shapes any audited field is expected to carry, but a crash while recording
 * an audit event would be worse than a lossy string, so this is a safety net
 * rather than the common case.
 */
function toJson(value: unknown): JsonObject[string] {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJson(item)) as JsonObject[string];
  }
  if (
    typeof value === "object" &&
    (value.constructor === Object || Object.getPrototypeOf(value) === null)
  ) {
    const result: JsonObject = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = toJson(entry);
    }
    return result;
  }
  return String(value);
}
