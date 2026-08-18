"use server";

import { revalidatePath } from "next/cache";
import {
  createManualLocationInputSchema,
  updateLocationInputSchema,
  updateLocationManagerInputSchema,
  type Location,
} from "@/domain";
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
    revalidatePath(`/locations/${locationId}`);
    return updated;
  });
}

/**
 * Add a location by hand.
 *
 * Deliberately **not** a reuse of `createOnboardingLocationAction`, which does
 * three more things: it completes onboarding step 3, seeds monitoring queries
 * for the new location, and returns the wizard's next path. Calling that one
 * from `/locations/new` would mark a three-month-old organization's setup
 * complete because somebody added their eleventh restaurant. The two share the
 * repository method and the field component and nothing else.
 *
 * `status` is written here rather than accepted: a location somebody types in
 * has not been set up in Lia yet, and `createManualLocationInputSchema` has no
 * status field for a form to get wrong.
 */
export async function createLocationAction(
  input: unknown,
): Promise<ActionResult<{ locationId: string; nextPath: string }>> {
  return runAction("location.create", async () => {
    const parsed = createManualLocationInputSchema.parse(input);
    const context = await authorize("location.create");

    const location = await context.dataSource.locations.create(context.scope, {
      ...parsed,
      status: "setup",
    });

    // `source: "manual"` is what distinguishes this from the wizard's
    // `"onboarding_manual"` and from `location.created_from_integration`. Three
    // ways a restaurant record can come into existence, three answers for an
    // auditor asking which one this was.
    await recordAuditEvent(context, {
      eventType: "location.created",
      entityType: "location",
      entityId: location.id,
      previousState: null,
      newState: { name: location.name, slug: location.slug, status: location.status },
      metadata: { source: "manual" },
    });

    revalidatePath("/locations");
    return { locationId: location.id, nextPath: `/locations/${location.id}` };
  });
}

/**
 * Fields that belong to `location.updated`.
 *
 * Declared once, here, because the partition is the point and three call sites
 * checking it independently is three chances to drift. `status` and
 * `managerUserId` are absent deliberately — they have their own events.
 */
const IDENTITY_FIELDS = [
  "name",
  "slug",
  "addressLine1",
  "addressLine2",
  "city",
  "region",
  "postalCode",
  "countryCode",
  "timezone",
] as const;

/**
 * Edit a location.
 *
 * Emits up to three audit events, partitioned by which fields actually changed,
 * and the partition is what makes them worth having:
 *
 *   location.updated          identity, address, slug, timezone
 *   location.status_changed   status
 *   location.manager_changed  manager
 *
 * A manager-only edit emits exactly one event and **not** `location.updated`.
 * If the generic event also fired for manager and status changes, every query
 * for "who changed this restaurant's address" would return reassignments and
 * retirements too, and the specific events would stop answering anything.
 *
 * `location.manager_changed` is reused rather than replaced, so a manager's
 * history stays queryable under one name whether it was changed from here or
 * from the settings panel's narrower action.
 */
export async function updateLocationAction(
  input: unknown,
): Promise<ActionResult<Location>> {
  return runAction("location.update", async () => {
    const parsed = updateLocationInputSchema.parse(input);
    const context = await authorize("location.update");

    // Scoped lookup before the write. A location id from another organization
    // is simply not found, which is the same answer a deleted one gives.
    const existing = await context.dataSource.locations.get(
      context.scope,
      parsed.locationId,
    );
    if (!existing) throw notFound("Location");

    const updated = await context.dataSource.locations.update(context.scope, parsed);

    const identity = diff(existing, updated, [...IDENTITY_FIELDS]);
    if (Object.keys(identity.newState ?? {}).length > 0) {
      await recordAuditEvent(context, {
        eventType: "location.updated",
        entityType: "location",
        entityId: updated.id,
        previousState: identity.previousState,
        newState: identity.newState,
        metadata: { locationName: updated.name },
      });
    }

    if (existing.status !== updated.status) {
      await recordAuditEvent(context, {
        eventType: "location.status_changed",
        entityType: "location",
        entityId: updated.id,
        previousState: { status: existing.status },
        newState: { status: updated.status },
        metadata: { locationName: updated.name },
      });
    }

    if (existing.managerUserId !== updated.managerUserId) {
      await recordAuditEvent(context, {
        eventType: "location.manager_changed",
        entityType: "location",
        entityId: updated.id,
        previousState: { managerUserId: existing.managerUserId },
        newState: { managerUserId: updated.managerUserId },
        metadata: { locationName: updated.name },
      });
    }

    revalidatePath("/locations");
    revalidatePath(`/locations/${updated.id}`);
    // The overview counts active locations, so a retirement changes it.
    if (existing.status !== updated.status) revalidatePath("/overview");

    return updated;
  });
}
