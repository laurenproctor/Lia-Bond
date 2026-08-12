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
    /**
     * The analysis occurrence that authorized this escalation. Required
     * non-null for every escalation raised by `raise_escalation` from the
     * escalation contract migration onward; null only on historical rows
     * that predate it.
     */
    triggerAnalysisId: uuidSchema.nullable(),
  })
  .extend(organizationOwnedSchema.shape)
  .extend(timestampsSchema.shape);

export type Escalation = z.infer<typeof escalationSchema>;

/**
 * Raising an escalation.
 *
 * No `assignedUserId`: an escalation raised by an analysis has no owner yet,
 * and picking one is a human decision. An unassigned item in the escalations
 * centre is precisely the "somebody must look at this" signal — giving it a
 * default owner would make it look handled.
 *
 * No `status` either. A new escalation is `open`; there is no legitimate reason
 * to create one already resolved, and the create constraint on the table would
 * refuse it anyway.
 */
export const createEscalationInputSchema = z.object({
  mentionId: uuidSchema,
  category: escalationCategorySchema,
  severity: escalationSeveritySchema,
  title: z.string().min(1).max(240),
  summary: z.string().nullable(),
  dueAt: timestampSchema.nullable(),
});

export type CreateEscalationInput = z.infer<typeof createEscalationInputSchema>;

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
