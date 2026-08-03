import { z } from "zod";
import {
  actorTypeSchema,
  auditEntityTypeSchema,
  auditEventTypeSchema,
} from "@/domain/enums";
import {
  jsonObjectSchema,
  organizationOwnedSchema,
  timestampSchema,
  uuidSchema,
} from "@/domain/primitives";

/**
 * An append-only record of a meaningful state change.
 *
 * There is no `updatedAt` and no update path: the application layer may insert
 * audit events and read them back, nothing more. A migration revokes UPDATE and
 * DELETE from the authenticated role so this holds at the database too.
 */
export const auditEventSchema = z
  .object({
    /** Null when the actor is not a person — a rule, a sync job, a model. */
    actorUserId: uuidSchema.nullable(),
    actorType: actorTypeSchema,
    eventType: auditEventTypeSchema,
    entityType: auditEntityTypeSchema,
    entityId: uuidSchema,
    /** The changed fields before the write. Null on creation events. */
    previousState: jsonObjectSchema.nullable(),
    /** The changed fields after the write. Null on deletion events. */
    newState: jsonObjectSchema.nullable(),
    metadata: jsonObjectSchema,
    occurredAt: timestampSchema,
  })
  .extend(organizationOwnedSchema.shape);

export type AuditEvent = z.infer<typeof auditEventSchema>;

/** What a caller supplies. Ids and timestamps are filled in by the service. */
export const recordAuditEventInputSchema = auditEventSchema
  .omit({ id: true, organizationId: true, occurredAt: true })
  .extend({
    metadata: jsonObjectSchema.default({}),
    occurredAt: timestampSchema.optional(),
  });

export type RecordAuditEventInput = z.input<typeof recordAuditEventInputSchema>;

export const auditEventFilterSchema = z.object({
  entityType: auditEntityTypeSchema.optional(),
  entityId: uuidSchema.optional(),
  eventTypes: z.array(auditEventTypeSchema).optional(),
  actorUserId: uuidSchema.optional(),
  occurredAfter: timestampSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

export type AuditEventFilter = z.infer<typeof auditEventFilterSchema>;
