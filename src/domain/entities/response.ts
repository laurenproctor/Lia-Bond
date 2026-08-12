import { z } from "zod";
import {
  approvalStatusSchema,
  generatedBySchema,
  responseDraftStatusSchema,
  responseTypeSchema,
} from "@/domain/enums";
import {
  organizationOwnedSchema,
  timestampSchema,
  timestampsSchema,
  uuidSchema,
} from "@/domain/primitives";

/**
 * A response to a mention, from first draft to published.
 *
 * `draftText` is what the model produced and `finalText` is what a human
 * settled on. Keeping both is what makes the human-edit rate measurable and
 * gives the responses library something honest to show.
 */
export const responseDraftSchema = z
  .object({
    mentionId: uuidSchema,
    responseType: responseTypeSchema,
    draftText: z.string(),
    finalText: z.string().nullable(),
    status: responseDraftStatusSchema,
    generatedBy: generatedBySchema,
    generationProvider: z.string().max(80).nullable(),
    generationModel: z.string().max(120).nullable(),
    promptVersion: z.string().max(40).nullable(),
    /** Which brand voice configuration produced this text. */
    brandVoiceVersion: z.string().max(40).nullable(),
    /** Which response policy the quality checks ran against. */
    policyVersion: z.string().max(40).nullable(),
    assignedUserId: uuidSchema.nullable(),
    approvedByUserId: uuidSchema.nullable(),
    approvedAt: timestampSchema.nullable(),
    publishedAt: timestampSchema.nullable(),
    externalResponseId: z.string().max(300).nullable(),
    publicationError: z.string().max(1000).nullable(),
  })
  .extend(organizationOwnedSchema.shape)
  .extend(timestampsSchema.shape);

export type ResponseDraft = z.infer<typeof responseDraftSchema>;

export const responseDraftFilterSchema = z.object({
  mentionId: uuidSchema.optional(),
  statuses: z.array(responseDraftStatusSchema).optional(),
  responseTypes: z.array(responseTypeSchema).optional(),
  assignedUserId: uuidSchema.optional(),
  generatedBy: generatedBySchema.optional(),
  search: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
});

export type ResponseDraftFilter = z.infer<typeof responseDraftFilterSchema>;

export const assignResponseDraftInputSchema = z.object({
  responseDraftId: uuidSchema,
  assignedUserId: uuidSchema.nullable(),
});

export type AssignResponseDraftInput = z.infer<
  typeof assignResponseDraftInputSchema
>;

export const decideResponseDraftInputSchema = z.object({
  responseDraftId: uuidSchema,
  // changes_requested replaces the old terminal decision value: choosing it
  // returns the draft to editable `draft` status rather than ending its
  // lifecycle (Task 1 of the response-generation plan).
  decision: z.enum(["approved", "changes_requested"]),
  decisionNote: z.string().max(1000).optional(),
  finalText: z.string().min(1).max(5000).optional(),
});

export type DecideResponseDraftInput = z.infer<
  typeof decideResponseDraftInputSchema
>;

/**
 * Statuses a draft may be approved or rejected from.
 *
 * Enforced centrally so an already-published response cannot be re-approved,
 * whichever adapter is running.
 */
export const APPROVABLE_DRAFT_STATUSES = [
  "draft",
  "awaiting_approval",
] as const;

export function canDecideOnDraft(status: ResponseDraft["status"]): boolean {
  return (APPROVABLE_DRAFT_STATUSES as readonly string[]).includes(status);
}

/**
 * Statuses whose text may still change.
 *
 * Deliberately the same set as deciding (D108): an approval keeps meaning
 * what was signed off, so the moment a draft leaves the decidable states its
 * text is frozen too. One vocabulary, no second lifecycle.
 */
export const EDITABLE_DRAFT_STATUSES = APPROVABLE_DRAFT_STATUSES;

export function canEditDraft(status: ResponseDraft["status"]): boolean {
  return (EDITABLE_DRAFT_STATUSES as readonly string[]).includes(status);
}

export const saveResponseDraftInputSchema = z.object({
  responseDraftId: uuidSchema,
  finalText: z.string().min(1).max(5000),
});

export type SaveResponseDraftInput = z.infer<typeof saveResponseDraftInputSchema>;

/* -------------------------------------------------------------------------- */
/* Approval                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The approval request itself, kept separate from the draft.
 *
 * The draft records the outcome; this records who was asked, by whom, and what
 * they said. That distinction is what makes the trail defensible later.
 */
export const approvalSchema = z
  .object({
    responseDraftId: uuidSchema,
    requestedByUserId: uuidSchema.nullable(),
    assignedToUserId: uuidSchema.nullable(),
    status: approvalStatusSchema,
    decisionNote: z.string().max(1000).nullable(),
    decidedAt: timestampSchema.nullable(),
  })
  .extend(organizationOwnedSchema.shape)
  .extend(timestampsSchema.shape);

export type Approval = z.infer<typeof approvalSchema>;
