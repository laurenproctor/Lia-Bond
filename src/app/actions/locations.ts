"use server";

import { revalidatePath } from "next/cache";
import { updateLocationManagerInputSchema, type Location } from "@/domain";
import { authorize } from "@/lib/actions/guard";
import { runAction, type ActionResult } from "@/lib/actions/result";
import { diff, recordAuditEvent } from "@/lib/audit/record";
import { notFound } from "@/lib/data/errors";

/**
 * Change who manages a location.
 *
 * Owners and admins only: the manager assignment is what grants a
 * location-scoped role its authority, so letting managers reassign it would let
 * them widen their own access.
 */
export async function updateLocationManagerAction(
  input: unknown,
): Promise<ActionResult<Location>> {
  return runAction("location.update_manager", async () => {
    const { locationId, managerUserId } = updateLocationManagerInputSchema.parse(input);

    const context = await authorize("location.update_manager");

    const existing = await context.dataSource.locations.get(context.scope, locationId);
    if (!existing) throw notFound("Location");

    const updated = await context.dataSource.locations.updateManager(
      context.scope,
      locationId,
      managerUserId,
    );

    const changes = diff(existing, updated, ["managerUserId"]);
    await recordAuditEvent(context, {
      eventType: "location.manager_changed",
      entityType: "location",
      entityId: locationId,
      previousState: changes.previousState,
      newState: changes.newState,
      metadata: { locationName: existing.name },
    });

    revalidatePath("/locations");
    return updated;
  });
}
