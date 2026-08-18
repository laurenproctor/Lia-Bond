import { z } from "zod";
import { platformSchema } from "@/domain/enums";
import {
  organizationOwnedSchema,
  timestampSchema,
  timestampsSchema,
  uuidSchema,
} from "@/domain/primitives";

/**
 * Publishing an approved response to a public place.
 *
 * Provider-neutral, with Reddit as the first implementation, because nothing
 * in this lifecycle is Reddit-specific: Google review replies will need the
 * same shape the day they are built, and so will anything else Lia ever posts
 * on a customer's behalf.
 *
 * Its own lifecycle rather than a reuse of `generation_attempts`, which looks
 * similar and is not. A generation call that fails halfway leaves nothing
 * behind but a wasted token spend, so retrying is free and the worst outcome
 * is a duplicate draft nobody sees. A publish call that fails halfway may have
 * already put words under a customer's name in front of the public. The
 * asymmetry is the whole design: this lifecycle exists to make "we do not know
 * whether that worked" a first-class state rather than an exception handler's
 * guess.
 */

/* -------------------------------------------------------------------------- */
/* Vocabularies                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Where an attempt stands.
 *
 * `reconciliation_required` is the load-bearing one. A timeout, a dropped
 * connection, an expired worker, or a crash after the network call is **not**
 * an ordinary failure: the request may have succeeded before the process died,
 * so retrying could post the same reply twice. Such an attempt lands here, and
 * blocks any further publish claim on that draft, until a reconciler has read
 * the connected account's own recent history and established what actually
 * happened.
 *
 * `superseded` is what a stale claimant's completion becomes when its lease
 * expired and another worker took the draft over — the same compare-and-set
 * discipline `complete_generation_attempt` already uses.
 */
export const PUBLICATION_ATTEMPT_STATUSES = [
  "pending",
  "succeeded",
  "failed",
  "reconciliation_required",
  "superseded",
] as const;
export const publicationAttemptStatusSchema = z.enum(PUBLICATION_ATTEMPT_STATUSES);
export type PublicationAttemptStatus = z.infer<
  typeof publicationAttemptStatusSchema
>;

/**
 * Why an attempt failed, normalised.
 *
 * The distinction that matters is not which HTTP status arrived but whether
 * the provider definitely refused. A definite refusal is terminal and safe to
 * report; anything else is an unknown outcome and goes to reconciliation.
 */
export const PUBLICATION_FAILURE_CATEGORIES = [
  /** The provider rejected the content or the account. Terminal. */
  "rejected_by_platform",
  /** The community's rules, or Lia's record of them, refused it. Terminal. */
  "policy_blocked",
  /** Locked, archived, deleted, or otherwise no longer repliable. Terminal. */
  "target_unavailable",
  /** The grant does not cover posting. Terminal until reauthorized. */
  "insufficient_scope",
  /** The account is not connected, or its credentials no longer work. */
  "not_authorized",
  /** Provider throttling. Retryable once the budget recovers. */
  "rate_limited",
  /** 5xx or a transport failure *before* the request was sent. Retryable. */
  "provider_unavailable",
  /** Lia's own bug or a malformed provider response. Not retryable blindly. */
  "unexpected_output",
] as const;
export const publicationFailureCategorySchema = z.enum(
  PUBLICATION_FAILURE_CATEGORIES,
);
export type PublicationFailureCategory = z.infer<
  typeof publicationFailureCategorySchema
>;

/**
 * Failures that definitely left the provider unchanged.
 *
 * Everything *not* on this list, arriving after the request went out, is an
 * unknown outcome. The list is deliberately conservative: a category is only
 * here when the provider told Lia it refused, because guessing wrong in this
 * direction posts a duplicate reply under a customer's name.
 */
export const DEFINITE_PUBLICATION_FAILURES: readonly PublicationFailureCategory[] =
  [
    "rejected_by_platform",
    "policy_blocked",
    "target_unavailable",
    "insufficient_scope",
    "not_authorized",
  ];

export function isDefiniteFailure(
  category: PublicationFailureCategory,
): boolean {
  return DEFINITE_PUBLICATION_FAILURES.includes(category);
}

/**
 * What a reconciler concluded.
 *
 * `ambiguous` stays blocked for a human on purpose. More than one plausible
 * match means Lia cannot tell which comment is its own, and the two available
 * guesses are "claim one and maybe mark the wrong comment as ours" or "assume
 * none and maybe post a duplicate". Neither is a decision code should make.
 */
export const PUBLICATION_RECONCILIATION_STATES = [
  "not_required",
  "pending",
  "recovered",
  "no_match",
  "ambiguous",
] as const;
export const publicationReconciliationStateSchema = z.enum(
  PUBLICATION_RECONCILIATION_STATES,
);
export type PublicationReconciliationState = z.infer<
  typeof publicationReconciliationStateSchema
>;

/**
 * The answer to "may I publish this?".
 *
 * `claimed` carries the compare-and-set token; nothing else does. `in_progress`
 * is what a second click gets, and it costs no provider call. `already_published`
 * is idempotent success rather than an error — the draft is published, which is
 * what the caller wanted.
 */
export const PUBLICATION_CLAIM_OUTCOMES = [
  "claimed",
  "in_progress",
  "already_published",
  "refused",
] as const;
export const publicationClaimOutcomeSchema = z.enum(PUBLICATION_CLAIM_OUTCOMES);
export type PublicationClaimOutcome = z.infer<
  typeof publicationClaimOutcomeSchema
>;

/**
 * Why a claim was refused.
 *
 * Every one of these is a state a person can be told about and, mostly, act
 * on. None of them is "something went wrong".
 */
export const PUBLICATION_REFUSAL_REASONS = [
  "not_approved",
  "no_named_approver",
  "unsupported_source",
  "account_disconnected",
  "missing_scope",
  "rollout_not_write",
  "community_not_allowed",
  "community_posture_stale",
  "target_unavailable",
  "awaiting_reconciliation",
  "forbidden",
] as const;
export const publicationRefusalReasonSchema = z.enum(PUBLICATION_REFUSAL_REASONS);
export type PublicationRefusalReason = z.infer<
  typeof publicationRefusalReasonSchema
>;

/* -------------------------------------------------------------------------- */
/* The attempt                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * One attempt to publish one approved draft.
 *
 * Note what is absent: the draft text, any provider content, any token, and
 * any provider error string. An attempt row records that a publish was tried,
 * against what, by whose authority, and how it ended — never what was said.
 * The text lives on the draft, where a human approved it.
 */
export const responsePublicationAttemptSchema = z
  .object({
    responseDraftId: uuidSchema,
    mentionId: uuidSchema,
    platformConnectionId: uuidSchema,
    platform: platformSchema,
    /** The post or comment being replied to, in the provider's own id space. */
    targetExternalId: z.string().min(1).max(300),
    status: publicationAttemptStatusSchema,
    /** Who pressed publish. Nulled on offboarding, never cascaded away. */
    actorUserId: uuidSchema.nullable(),
    claimedAt: timestampSchema,
    /** Lease expiry. A claim outliving this may be taken over. */
    claimExpiresAt: timestampSchema,
    finishedAt: timestampSchema.nullable(),
    failureCategory: publicationFailureCategorySchema.nullable(),
    reconciliationState: publicationReconciliationStateSchema,
    /** The provider's id for what Lia published. Set only on success. */
    externalResponseId: z.string().max(300).nullable(),
    /**
     * The provider's own request id, when it supplies one that is safe to keep.
     *
     * An opaque correlation handle for a support conversation — never a
     * message, never a body, never anything that could quote the content.
     */
    providerRequestId: z.string().max(200).nullable(),
    /** How many claims this draft has been through, including this one. */
    attemptCount: z.number().int().min(1),
  })
  .extend(organizationOwnedSchema.shape)
  .extend(timestampsSchema.shape);

export type ResponsePublicationAttempt = z.infer<
  typeof responsePublicationAttemptSchema
>;

/**
 * Statuses that block a fresh claim on the same draft.
 *
 * `pending` blocks because a worker may be mid-call. `reconciliation_required`
 * blocks because Lia does not know whether a reply already exists, and the
 * whole point of the state is to stop a retry from finding out the expensive
 * way.
 */
export const LIVE_PUBLICATION_ATTEMPT_STATUSES: readonly PublicationAttemptStatus[] =
  ["pending", "reconciliation_required"];

export function blocksNewClaim(status: PublicationAttemptStatus): boolean {
  return LIVE_PUBLICATION_ATTEMPT_STATUSES.includes(status);
}

/**
 * The result of asking to publish.
 *
 * A discriminated union rather than a nullable token, so a caller cannot reach
 * for `claimToken` on an outcome that has none — the compiler refuses it,
 * which is the same discipline `SOURCE_OWNED_MENTION_FIELDS` applies to
 * ingest.
 */
export const publicationClaimResultSchema = z.discriminatedUnion("outcome", [
  z.object({
    outcome: z.literal("claimed"),
    attemptId: uuidSchema,
    /** Returned exactly once, never selectable afterwards. */
    claimToken: z.string().min(1),
    targetExternalId: z.string().min(1).max(300),
  }),
  z.object({ outcome: z.literal("in_progress"), attemptId: uuidSchema }),
  z.object({
    outcome: z.literal("already_published"),
    externalResponseId: z.string().max(300).nullable(),
  }),
  z.object({
    outcome: z.literal("refused"),
    reason: publicationRefusalReasonSchema,
  }),
]);

export type PublicationClaimResult = z.infer<typeof publicationClaimResultSchema>;

/**
 * Source types Lia is able to publish a reply to.
 *
 * Declared as data, and restated inside `claim_response_publication`, for the
 * reason `response.generate` learned the hard way: a button is not a security
 * boundary. A caller reaching the publish path with a news article must be
 * refused by the database, not merely never offered the control.
 */
export const PUBLISHABLE_SOURCE_TYPES = ["reddit_post", "reddit_comment"] as const;
