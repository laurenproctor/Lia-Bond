"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { membershipRoleSchema, type Membership } from "@/domain";
import { authorize } from "@/lib/actions/guard";
import { runAction, type ActionResult } from "@/lib/actions/result";
import { recordAuditEvent } from "@/lib/audit/record";
import { DataError } from "@/lib/data/errors";

/**
 * Managing who is in an organization and what they may do.
 *
 * Three guardrails run before any of these writes, and they exist because each
 * protects against a mistake that cannot be undone from inside the product:
 *
 * 1. **You cannot change your own role or status.** An admin demoting
 *    themselves loses the permission needed to undo it. This is not paranoia
 *    about malice — it is the single most common way somebody locks themselves
 *    out of an admin panel.
 * 2. **The last active owner is untouchable.** An organization with no owner
 *    has nobody who can promote anyone, so it is unrecoverable through the
 *    interface. Enforced here for the message and by a database constraint
 *    trigger for the guarantee.
 * 3. **Only owners may create or unmake owners.** `organization.manage_members`
 *    is held by owners and admins alike; without this an admin could promote
 *    themselves to owner, which makes the distinction between the two roles
 *    decorative.
 */

const roleChangeSchema = z.object({
  userId: z.uuid(),
  role: membershipRoleSchema,
});

const statusChangeSchema = z.object({
  userId: z.uuid(),
  status: z.enum(["active", "suspended"]),
});

const removeSchema = z.object({ userId: z.uuid() });

/** Guardrail 1. Applied before the permission-specific checks. */
function refuseSelf(actingUserId: string, targetUserId: string, verb: string): void {
  if (actingUserId === targetUserId) {
    throw new DataError(
      "forbidden",
      `You cannot ${verb} your own membership. Ask another owner or admin.`,
    );
  }
}

/** Guardrail 3. Owner is the role that can hand out the role. */
function refuseOwnerChangeByNonOwner(
  actingRole: Membership["role"],
  currentRole: Membership["role"],
  nextRole: Membership["role"],
): void {
  const touchesOwnership = currentRole === "owner" || nextRole === "owner";
  if (touchesOwnership && actingRole !== "owner") {
    throw new DataError(
      "forbidden",
      "Only an owner can add or remove another owner.",
    );
  }
}

/** Change what somebody may do. */
export async function updateMemberRoleAction(
  input: unknown,
): Promise<ActionResult<Membership>> {
  return runAction("membership.update_role", async () => {
    const { userId, role } = roleChangeSchema.parse(input);
    const context = await authorize("organization.manage_members");

    refuseSelf(context.scope.userId, userId, "change");

    const members = await context.dataSource.memberships.listMembers(context.scope);
    const target = members.find((member) => member.userId === userId);
    if (!target) throw new DataError("not_found", "That person is not a member here.");

    refuseOwnerChangeByNonOwner(context.role, target.role, role);

    const updated = await context.dataSource.memberships.updateRole(
      context.scope,
      userId,
      role,
    );

    await recordAuditEvent(context, {
      eventType: "membership.role_changed",
      entityType: "membership",
      entityId: target.id,
      previousState: { role: target.role },
      newState: { role: updated.role },
      metadata: { memberEmail: target.user.email },
    });

    revalidatePath("/settings");
    return updated;
  });
}

/**
 * Suspend or restore access.
 *
 * Suspension rather than removal is the reversible option, and it is the right
 * one for somebody on leave or whose laptop went missing: RLS ignores any
 * membership that is not `active`, so the account keeps its history and loses
 * its access the moment this lands.
 */
export async function updateMemberStatusAction(
  input: unknown,
): Promise<ActionResult<Membership>> {
  return runAction("membership.update_status", async () => {
    const { userId, status } = statusChangeSchema.parse(input);
    const context = await authorize("organization.manage_members");

    refuseSelf(context.scope.userId, userId, "suspend");

    const members = await context.dataSource.memberships.listMembers(context.scope);
    const target = members.find((member) => member.userId === userId);
    if (!target) throw new DataError("not_found", "That person is not a member here.");

    if (target.role === "owner" && context.role !== "owner") {
      throw new DataError("forbidden", "Only an owner can suspend another owner.");
    }

    const updated = await context.dataSource.memberships.updateStatus(
      context.scope,
      userId,
      status,
    );

    await recordAuditEvent(context, {
      eventType: "membership.status_changed",
      entityType: "membership",
      entityId: target.id,
      previousState: { status: target.status },
      newState: { status: updated.status },
      metadata: { memberEmail: target.user.email },
    });

    revalidatePath("/settings");
    return updated;
  });
}

/**
 * Remove somebody from the organization.
 *
 * Deletes the membership, not the account. The person keeps their login and
 * any other organization they belong to; what they lose is this one. Their
 * name stays on the audit trail and on anything they were assigned, because
 * `audit_events.actor_user_id` references `users`, not `memberships`.
 */
export async function removeMemberAction(
  input: unknown,
): Promise<ActionResult<{ userId: string }>> {
  return runAction("membership.remove", async () => {
    const { userId } = removeSchema.parse(input);
    const context = await authorize("organization.manage_members");

    refuseSelf(context.scope.userId, userId, "remove");

    const members = await context.dataSource.memberships.listMembers(context.scope);
    const target = members.find((member) => member.userId === userId);
    if (!target) throw new DataError("not_found", "That person is not a member here.");

    if (target.role === "owner" && context.role !== "owner") {
      throw new DataError("forbidden", "Only an owner can remove another owner.");
    }

    await context.dataSource.memberships.remove(context.scope, userId);

    // Recorded after the delete, and this is the one case where that ordering
    // is forced: the membership row has to be gone for the event to be true.
    // The event survives it — audit rows reference the user, not the
    // membership, so removing somebody does not erase what they did.
    await recordAuditEvent(context, {
      eventType: "membership.removed",
      entityType: "membership",
      entityId: target.id,
      previousState: { role: target.role, status: target.status },
      newState: null,
      metadata: { memberEmail: target.user.email },
    });

    revalidatePath("/settings");
    return { userId };
  });
}
