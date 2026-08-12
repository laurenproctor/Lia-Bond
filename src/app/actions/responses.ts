"use server";

import { revalidatePath } from "next/cache";
import {
  assignResponseDraftInputSchema,
  decideResponseDraftInputSchema,
  saveResponseDraftInputSchema,
  type ResponseDraft,
} from "@/domain";
import { assertPermissionForLocation, authorize, mutationContext } from "@/lib/actions/guard";
import { runAction, type ActionResult } from "@/lib/actions/result";
import { diff, recordAuditEvent } from "@/lib/audit/record";
import { notFound } from "@/lib/data/errors";

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
 * Approve or reject a response draft.
 *
 * Restricted to owners, admins, and approvers. Writing a draft and signing it
 * off are separate jobs, so a communications lead cannot approve their own
 * work — see the permission matrix.
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
      eventType: decision === "approved" ? "response.approved" : "response.rejected",
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
