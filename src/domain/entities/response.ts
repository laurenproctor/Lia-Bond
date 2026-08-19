import { z } from "zod";
import {
  approvalStatusSchema,
  generatedBySchema,
  responseDraftStatusSchema,
  responsePublicationMethodSchema,
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

    /* ---------------------------------------------------------------------- */
    /* Publication provenance                                                  */
    /*                                                                        */
    /* `publishedAt` says a response went public; these say on whose word.     */
    /* Without them, a reply a person told Lia they had posted is stored       */
    /* identically to one a provider acknowledged — and the difference is      */
    /* exactly what matters when somebody disputes a reply months later.       */
    /* ---------------------------------------------------------------------- */

    /**
     * How it reached the public. Null until it did.
     *
     * `manual_external` is the only value anything writes today: no connector
     * can publish, so `provider_api` exists to be the honest name for the path
     * that does not exist yet rather than to leave the column meaning
     * "manual" implicitly.
     */
    publicationMethod: responsePublicationMethodSchema.nullable(),
    /**
     * Who confirmed it. Null until published.
     *
     * Not the same person as `approvedByUserId`, necessarily or usefully: the
     * approver signs the words off, and whoever carries them to Yelp confirms
     * having done so. Recording only the approver would attribute an act to
     * somebody who may not have performed it.
     */
    publishedByUserId: uuidSchema.nullable(),
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
/* Assisted publication                                                        */
/* -------------------------------------------------------------------------- */

/**
 * The one status a manual publication may be confirmed from.
 *
 * Narrow on purpose, and narrower than it might look: a draft still in `draft`
 * or `awaiting_approval` has not been signed off by anybody, and confirming
 * that unapproved words were posted publicly would record an approval that
 * never happened. A draft already `published` is handled by idempotency rather
 * than by widening this — see `canConfirmPublication`.
 */
export const CONFIRMABLE_DRAFT_STATUSES = ["approved"] as const;

export function canConfirmPublication(status: ResponseDraft["status"]): boolean {
  return (CONFIRMABLE_DRAFT_STATUSES as readonly string[]).includes(status);
}

/**
 * Confirming that an approved response was posted by hand.
 *
 * The input carries the draft and nothing else. The actor comes from the
 * session, the timestamp from the server clock, and the method is written
 * literally — none of the three is a field a caller can supply, for the same
 * reason `generateResponseDraftInputSchema` names a mention and nothing more: a
 * request that could name its own publication method could claim a provider had
 * verified it.
 */
export const confirmResponsePublicationInputSchema = z.object({
  responseDraftId: uuidSchema,
});

export type ConfirmResponsePublicationInput = z.infer<
  typeof confirmResponsePublicationInputSchema
>;

/**
 * Undoing a confirmation somebody made by mistake.
 *
 * Deliberately *not* called a retraction. A retraction means a published reply
 * was taken down from the platform, which is a public act with its own
 * evidence; this means the reply was never posted and Lia's record was wrong.
 * Naming them the same thing would put "we removed a bad reply" and "we
 * mis-clicked" in one bucket, and the first is the one somebody will need to
 * prove one day.
 *
 * A note is required rather than optional. The whole value of the correction is
 * the explanation attached to it — a bare reversal in an audit trail reads as
 * indecision, and the reader six months later is trying to establish what
 * actually happened.
 */
export const unconfirmResponsePublicationInputSchema = z.object({
  responseDraftId: uuidSchema,
  reason: z.string().min(1).max(1000),
});

export type UnconfirmResponsePublicationInput = z.infer<
  typeof unconfirmResponsePublicationInputSchema
>;

/**
 * What a confirmation attempt did.
 *
 * `already_confirmed` is idempotent success rather than an error: the draft is
 * recorded as published, which is what the caller wanted. It is distinguished
 * from `confirmed` only so the interface can say "already recorded" instead of
 * flashing a fresh success at somebody who double-clicked.
 */
export const PUBLICATION_CONFIRMATION_OUTCOMES = [
  "confirmed",
  "already_confirmed",
] as const;
export const publicationConfirmationOutcomeSchema = z.enum(
  PUBLICATION_CONFIRMATION_OUTCOMES,
);
export type PublicationConfirmationOutcome = z.infer<
  typeof publicationConfirmationOutcomeSchema
>;

/**
 * A request to draft a reply for one mention.
 *
 * The mention, and nothing else: a caller names what to write about, never
 * what to write with. Prompt version, brand voice, and model all come from the
 * server (`generateResponseDraft`), so a crafted request cannot swap the voice
 * a reply is written in or the text the model is shown.
 */
export const generateResponseDraftInputSchema = z.object({
  mentionId: uuidSchema,
});

export type GenerateResponseDraftInput = z.infer<
  typeof generateResponseDraftInputSchema
>;

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
