"use server";

import { revalidatePath } from "next/cache";
import {
  assignEscalationInputSchema,
  updateEscalationStatusInputSchema,
  type Escalation,
} from "@/domain";
import { assertPermissionForLocation, authorize, mutationContext } from "@/lib/actions/guard";
import { runAction, type ActionResult } from "@/lib/actions/result";
import { diff, recordAuditEvent } from "@/lib/audit/record";
import { notFound } from "@/lib/data/errors";

/**
 * Move an escalation through its lifecycle.
 *
 * Resolving requires a note; the repository refuses without one, so a case
 * cannot be closed silently.
 *
 * Location-scoped, following `updateMentionStatusAction`'s pattern: a
 * location manager may move the status of escalations for their own
 * restaurants only. The escalation's own record carries no location, so its
 * mention is loaded explicitly and checked — never optional-chained, so a
 * missing mention fails closed instead of silently granting access.
 */
export async function updateEscalationStatusAction(
  input: unknown,
): Promise<ActionResult<Escalation>> {
  return runAction("escalation.update_status", async () => {
    const { escalationId, status, resolutionNote } =
      updateEscalationStatusInputSchema.parse(input);

    const context = await mutationContext();

    const existing = await context.dataSource.escalations.get(context.scope, escalationId);
    if (!existing) throw notFound("Escalation");

    const mention = await context.dataSource.mentions.get(context.scope, existing.mentionId);
    if (!mention) throw notFound("Mention");

    await assertPermissionForLocation(
      context,
      "escalation.update_status",
      mention.locationId,
    );

    const updated = await context.dataSource.escalations.updateStatus(
      context.scope,
      escalationId,
      status,
      resolutionNote,
    );

    const changes = diff(existing, updated, ["status", "resolvedAt"]);
    await recordAuditEvent(context, {
      eventType: "escalation.status_changed",
      entityType: "escalation",
      entityId: escalationId,
      previousState: changes.previousState,
      newState: changes.newState,
      metadata: resolutionNote ? { resolutionNote } : {},
    });

    revalidatePath("/escalations");
    revalidatePath("/overview");
    return updated;
  });
}

/** Give an escalation an owner. */
export async function assignEscalationAction(
  input: unknown,
): Promise<ActionResult<Escalation>> {
  return runAction("escalation.assign", async () => {
    const { escalationId, assignedUserId } = assignEscalationInputSchema.parse(input);

    const context = await authorize("escalation.assign");

    const existing = await context.dataSource.escalations.get(context.scope, escalationId);
    if (!existing) throw notFound("Escalation");

    const updated = await context.dataSource.escalations.assign(
      context.scope,
      escalationId,
      assignedUserId,
    );

    const changes = diff(existing, updated, ["assignedUserId"]);
    await recordAuditEvent(context, {
      eventType: "escalation.assigned",
      entityType: "escalation",
      entityId: escalationId,
      previousState: changes.previousState,
      newState: changes.newState,
    });

    revalidatePath("/escalations");
    return updated;
  });
}
