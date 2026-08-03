"use server";

import { revalidatePath } from "next/cache";
import { updateMentionStatusInputSchema, type Mention } from "@/domain";
import { assertPermissionForLocation, mutationContext } from "@/lib/actions/guard";
import { runAction, type ActionResult } from "@/lib/actions/result";
import { diff, recordAuditEvent } from "@/lib/audit/record";
import { notFound } from "@/lib/data/errors";

/**
 * Change a mention's workflow status.
 *
 * Location-scoped: a location manager may move mentions for their own
 * restaurants, and an organization-wide mention (a Reddit thread with no
 * location) is out of their reach.
 */
export async function updateMentionStatusAction(
  input: unknown,
): Promise<ActionResult<Mention>> {
  return runAction("mention.update_status", async () => {
    const { mentionId, status, note } = updateMentionStatusInputSchema.parse(input);

    const context = await mutationContext();

    // Read first: the mention's location is what a location-scoped role gets
    // checked against. This read is already tenant-scoped.
    const existing = await context.dataSource.mentions.get(context.scope, mentionId);
    if (!existing) throw notFound("Mention");

    await assertPermissionForLocation(
      context,
      "mention.update_status",
      existing.locationId,
    );

    const updated = await context.dataSource.mentions.updateStatus(
      context.scope,
      mentionId,
      status,
    );

    const changes = diff(existing, updated, ["status"]);
    await recordAuditEvent(context, {
      eventType: "mention.status_changed",
      entityType: "mention",
      entityId: mentionId,
      previousState: changes.previousState,
      newState: changes.newState,
      metadata: note ? { note } : {},
    });

    revalidatePath("/mentions");
    revalidatePath("/overview");
    return updated;
  });
}
