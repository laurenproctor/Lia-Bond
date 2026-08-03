"use server";

import { revalidatePath } from "next/cache";
import {
  assignResponseDraftInputSchema,
  decideResponseDraftInputSchema,
  type ResponseDraft,
} from "@/domain";
import { authorize } from "@/lib/actions/guard";
import { runAction, type ActionResult } from "@/lib/actions/result";
import { diff, recordAuditEvent } from "@/lib/audit/record";
import { notFound } from "@/lib/data/errors";

/** Assign a response draft to a person. */
export async function assignResponseDraftAction(
  input: unknown,
): Promise<ActionResult<ResponseDraft>> {
  return runAction("response.assign", async () => {
    const { responseDraftId, assignedUserId } =
      assignResponseDraftInputSchema.parse(input);

    const context = await authorize("response.assign");

    const existing = await context.dataSource.responseDrafts.get(
      context.scope,
      responseDraftId,
    );
    if (!existing) throw notFound("Response draft");

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
    const { responseDraftId, decision, decisionNote } =
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

    revalidatePath("/responses");
    revalidatePath("/mentions");
    return draft;
  });
}
