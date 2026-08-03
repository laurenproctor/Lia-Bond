import { z } from "zod";
import {
  escalationCategorySchema,
  escalationSeveritySchema,
  escalationStatusSchema,
} from "@/domain/enums";
import {
  organizationOwnedSchema,
  timestampSchema,
  timestampsSchema,
  uuidSchema,
} from "@/domain/primitives";

/**
 * A sensitive issue lifted out of the queue and given an owner.
 *
 * Escalations always originate from a mention, so the evidence trail stays
 * intact — there is no free-floating case with nothing behind it.
 */
export const escalationSchema = z
  .object({
    mentionId: uuidSchema,
    category: escalationCategorySchema,
    severity: escalationSeveritySchema,
    status: escalationStatusSchema,
    title: z.string().min(1).max(240),
    summary: z.string().nullable(),
    assignedUserId: uuidSchema.nullable(),
    dueAt: timestampSchema.nullable(),
    resolvedAt: timestampSchema.nullable(),
    resolutionNote: z.string().max(2000).nullable(),
  })
  .extend(organizationOwnedSchema.shape)
  .extend(timestampsSchema.shape);

export type Escalation = z.infer<typeof escalationSchema>;

export const escalationFilterSchema = z.object({
  mentionId: uuidSchema.optional(),
  statuses: z.array(escalationStatusSchema).optional(),
  categories: z.array(escalationCategorySchema).optional(),
  severities: z.array(escalationSeveritySchema).optional(),
  assignedUserId: uuidSchema.optional(),
  search: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
});

export type EscalationFilter = z.infer<typeof escalationFilterSchema>;

export const updateEscalationStatusInputSchema = z.object({
  escalationId: uuidSchema,
  status: escalationStatusSchema,
  resolutionNote: z.string().max(2000).optional(),
});

export type UpdateEscalationStatusInput = z.infer<
  typeof updateEscalationStatusInputSchema
>;

export const assignEscalationInputSchema = z.object({
  escalationId: uuidSchema,
  assignedUserId: uuidSchema.nullable(),
});

export type AssignEscalationInput = z.infer<typeof assignEscalationInputSchema>;

/** Statuses that mean the case is finished. */
export const CLOSED_ESCALATION_STATUSES = ["resolved", "dismissed"] as const;

export function isEscalationClosed(status: Escalation["status"]): boolean {
  return (CLOSED_ESCALATION_STATUSES as readonly string[]).includes(status);
}

/**
 * Closing an escalation requires a resolution note.
 *
 * A case that closes with no explanation is worse than one left open, because
 * it looks handled.
 */
export function requiresResolutionNote(status: Escalation["status"]): boolean {
  return status === "resolved";
}
