"use server";

import { revalidatePath } from "next/cache";
import {
  assignResponseDraftInputSchema,
  confirmResponsePublicationInputSchema,
  decideResponseDraftInputSchema,
  generateResponseDraftInputSchema,
  saveResponseDraftInputSchema,
  unconfirmResponsePublicationInputSchema,
  type GenerationFailureCategory,
  type ResponseDraft,
} from "@/domain";
import { getAiProvider } from "@/ai/registry";
import { assertPermissionForLocation, authorize, mutationContext } from "@/lib/actions/guard";
import { failure, runAction, type ActionResult } from "@/lib/actions/result";
import { diff, recordAuditEvent } from "@/lib/audit/record";
import { notFound } from "@/lib/data/errors";
import { generateResponseDraft } from "@/lib/responses/generate";

/**
 * Assign a response draft to a person.
 *
 * Location-scoped, following `updateMentionStatusAction`'s pattern: a
 * location manager may assign drafts for their own restaurants only. The
 * draft's own record carries no location, so its mention is loaded
 * explicitly and checked — never optional-chained, so a missing mention
 * fails closed instead of silently granting access.
 */
export async function assignResponseDraftAction(
  input: unknown,
): Promise<ActionResult<ResponseDraft>> {
  return runAction("response.assign", async () => {
    const { responseDraftId, assignedUserId } =
      assignResponseDraftInputSchema.parse(input);

    const context = await mutationContext();

    const existing = await context.dataSource.responseDrafts.get(
      context.scope,
      responseDraftId,
    );
    if (!existing) throw notFound("Response draft");

    const mention = await context.dataSource.mentions.get(context.scope, existing.mentionId);
    if (!mention) throw notFound("Mention");

    await assertPermissionForLocation(context, "response.assign", mention.locationId);

    const updated = await context.dataSource.responseDrafts.assign(
      context.scope,
      responseDraftId,
      assignedUserId,
    );

    const changes = diff(existing, updated, ["assignedUserId"]);
    await recordAuditEvent(context, {
      eventType: "response.assigned",
      entityType: "response_draft",
      entityId: responseDraftId,
      previousState: changes.previousState,
      newState: changes.newState,
    });

    revalidatePath("/responses");
    return updated;
  });
}

/** Persist a human's edit to a draft's final text. */
export async function saveResponseDraftAction(
  input: unknown,
): Promise<ActionResult<ResponseDraft>> {
  return runAction("response.save", async () => {
    const { responseDraftId, finalText } =
      saveResponseDraftInputSchema.parse(input);

    const context = await authorize("response.edit");

    const existing = await context.dataSource.responseDrafts.get(
      context.scope,
      responseDraftId,
    );
    if (!existing) throw notFound("Response draft");

    const updated = await context.dataSource.responseDrafts.saveFinalText(
      context.scope,
      responseDraftId,
      finalText,
    );

    // Lengths only, never the text (D111): the trail records that an edit
    // happened, not the prose.
    await recordAuditEvent(context, {
      eventType: "response.edited",
      entityType: "response_draft",
      entityId: responseDraftId,
      previousState: { finalTextLength: existing.finalText?.length ?? null },
      newState: { finalTextLength: updated.finalText?.length ?? null },
    });

    revalidatePath("/responses");
    revalidatePath("/mentions");
    revalidatePath("/reviews/google/[id]", "page");
    revalidatePath("/reddit/[id]", "page");
    return updated;
  });
}

/**
 * Approve a response draft, or send it back with requested changes.
 *
 * Restricted to owners, admins, and approvers. Writing a draft and signing it
 * off are separate jobs, so a communications lead cannot approve their own
 * work — see the permission matrix. `changes_requested` is not terminal: it
 * returns the draft to editable `draft` status rather than ending its
 * lifecycle.
 */
export async function decideResponseDraftAction(
  input: unknown,
): Promise<ActionResult<ResponseDraft>> {
  return runAction("response.decide", async () => {
    const { responseDraftId, decision, decisionNote, finalText } =
      decideResponseDraftInputSchema.parse(input);

    const context = await authorize("response.decide");

    const existing = await context.dataSource.responseDrafts.get(
      context.scope,
      responseDraftId,
    );
    if (!existing) throw notFound("Response draft");

    // The repository enforces the legal transitions and refuses to decide twice.
    const { draft } = await context.dataSource.responseDrafts.decide(
      context.scope,
      responseDraftId,
      decision,
      context.userId,
      decisionNote,
      finalText,
    );

    const changes = diff(existing, draft, ["status", "approvedByUserId", "approvedAt"]);
    await recordAuditEvent(context, {
      eventType: decision === "approved" ? "response.approved" : "response.changes_requested",
      entityType: "response_draft",
      entityId: responseDraftId,
      previousState: changes.previousState,
      newState: changes.newState,
      metadata: decisionNote ? { decisionNote } : {},
    });

    // Lengths only, never the text (D111). Recorded only when the composer's
    // text actually changed as part of this decision (D107) — deciding
    // without touching the text stays a single event.
    if (finalText !== undefined && finalText !== existing.finalText) {
      await recordAuditEvent(context, {
        eventType: "response.edited",
        entityType: "response_draft",
        entityId: responseDraftId,
        previousState: { finalTextLength: existing.finalText?.length ?? null },
        newState: { finalTextLength: finalText.length },
      });
    }

    revalidatePath("/responses");
    revalidatePath("/mentions");
    revalidatePath("/reviews/google/[id]", "page");
    revalidatePath("/reddit/[id]", "page");
    return draft;
  });
}

/**
 * Outcomes of a generation request that are not failures.
 *
 * `in_progress` and `draft_exists` are deliberately successes: the request did
 * exactly what it should have — it declined to spend a second model call on
 * work that is already done or already running — and the composer has
 * something to show for each. Only a genuine failure carries error copy.
 */
export type GenerateResponseDraftOutcome =
  | { kind: "generated"; responseDraftId: string }
  | { kind: "in_progress" }
  | { kind: "draft_exists"; responseDraftId: string };

/**
 * What a person reads when generation fails.
 *
 * Lia's own words, one sentence, sentence case, in every case: a provider
 * message could echo the drafting prompt, and that prompt carries the review
 * and the reviewer's name (`src/ai/provider.ts`). The service classifies;
 * this is the only place the classification becomes English.
 */
const GENERATION_FAILURE_COPY: Record<GenerationFailureCategory, string> = {
  provider_error: "Lia couldn't reach the writing model just now. Try again in a moment.",
  invalid_output:
    "The reply Lia wrote didn't pass its checks, so nothing was saved. Try again.",
  lease_expired:
    "Someone else started a reply for this review. Reload the page to see where it got to.",
};

/**
 * Draft a public reply for one mention, on request.
 *
 * Organization-wide rather than location-scoped, following `response.edit`'s
 * reasoning: drafting has no location dimension. The repository restates the
 * same permission internally, so this check is the outer of two.
 */
export async function generateResponseDraftAction(
  input: unknown,
): Promise<ActionResult<GenerateResponseDraftOutcome>> {
  const result = await runAction("response.generate", async () => {
    const { mentionId } = generateResponseDraftInputSchema.parse(input);

    const context = await authorize("response.generate");

    const outcome = await generateResponseDraft(context, mentionId, getAiProvider());

    if (outcome.kind === "generated") {
      revalidatePath("/responses");
      revalidatePath("/mentions");
      revalidatePath("/reviews/google/[id]", "page");
    }

    return outcome;
  });

  if (!result.ok) return result;
  if (result.data.kind === "failed") {
    return failure(GENERATION_FAILURE_COPY[result.data.category]);
  }

  return { ok: true, data: result.data };
}

/* -------------------------------------------------------------------------- */
/* Assisted publication                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Record that a person posted an approved response themselves.
 *
 * The confirmation half of assisted posting, and the only thing in this file
 * that moves a draft to `published`. Everything it does *not* do is the point:
 * Lia sends nothing, contacts no provider, and receives no acknowledgement. It
 * records somebody's statement that they carried the approved words to a
 * platform Lia cannot reach.
 *
 * Consequences enforced below this action rather than here, so they hold for
 * every future caller:
 *
 * - the method is written literally as `manual_external` by the repository,
 *   never taken from the request;
 * - `externalResponseId` stays null, which the database enforces
 *   (`response_drafts_external_id_requires_provider`) — so a user-confirmed
 *   publication can never be read as provider-verified;
 * - the update is guarded on `status = 'approved'` in its own WHERE clause, so
 *   a second click is idempotent rather than writing a second confirmation.
 *
 * Organization-wide rather than location-scoped, following `response.edit` and
 * `response.generate`: a draft carries no location to scope a location manager
 * to.
 */
export async function confirmResponsePublicationAction(
  input: unknown,
): Promise<ActionResult<{ draft: ResponseDraft; alreadyConfirmed: boolean }>> {
  return runAction("response.confirm_publication", async () => {
    const { responseDraftId } = confirmResponsePublicationInputSchema.parse(input);

    const context = await authorize("response.confirm_publication");

    const existing = await context.dataSource.responseDrafts.get(
      context.scope,
      responseDraftId,
    );
    if (!existing) throw notFound("Response draft");

    const confirmedAt = new Date().toISOString();
    const { draft, outcome } =
      await context.dataSource.responseDrafts.confirmPublication(
        context.scope,
        responseDraftId,
        context.userId,
        confirmedAt,
      );

    // Only a genuine first confirmation is recorded. A repeat writing a second
    // event would make one act look like two in the trail.
    if (outcome === "confirmed") {
      await recordAuditEvent(context, {
        eventType: "response.publication_confirmed",
        entityType: "response_draft",
        entityId: responseDraftId,
        previousState: { status: existing.status },
        newState: { status: draft.status },
        // Names the method explicitly so a reader of the trail cannot mistake
        // this for an API publication. No draft text, matching every other
        // event on a response.
        metadata: {
          publicationMethod: "manual_external",
          mentionId: existing.mentionId,
        },
      });
    }

    revalidatePath("/responses");
    revalidatePath("/mentions");

    return { draft, alreadyConfirmed: outcome === "already_confirmed" };
  });
}

/**
 * Withdraw a confirmation somebody made by mistake.
 *
 * The correction path, and deliberately not called a retraction: a retraction
 * means a published reply was taken down from the platform, which is a public
 * act with its own evidence. This means the reply was never posted and Lia's
 * record was wrong.
 *
 * Held to the same permission as confirming, rather than a narrower one. The
 * person best placed to notice the mistake is whoever made it, and requiring
 * them to find somebody more senior before a false "posted" record can be
 * corrected would leave the wrong thing on the screen for longer.
 */
export async function unconfirmResponsePublicationAction(
  input: unknown,
): Promise<ActionResult<ResponseDraft>> {
  return runAction("response.unconfirm_publication", async () => {
    const { responseDraftId, reason } =
      unconfirmResponsePublicationInputSchema.parse(input);

    const context = await authorize("response.confirm_publication");

    const existing = await context.dataSource.responseDrafts.get(
      context.scope,
      responseDraftId,
    );
    if (!existing) throw notFound("Response draft");

    const draft = await context.dataSource.responseDrafts.unconfirmPublication(
      context.scope,
      responseDraftId,
    );

    await recordAuditEvent(context, {
      eventType: "response.publication_unconfirmed",
      entityType: "response_draft",
      entityId: responseDraftId,
      previousState: {
        status: existing.status,
        publicationMethod: existing.publicationMethod,
      },
      newState: { status: draft.status, publicationMethod: null },
      // The reason is the whole value of the correction — a bare reversal in an
      // audit trail reads as indecision, and the person reading it later is
      // trying to establish what actually happened. Capped by the schema.
      metadata: { reason, mentionId: existing.mentionId },
    });

    revalidatePath("/responses");
    revalidatePath("/mentions");

    return draft;
  });
}
