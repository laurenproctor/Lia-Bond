import "server-only";

import {
  can,
  canForLocation,
  explainDenial,
  requiresPaidAccess,
  type Permission,
} from "@/lib/auth/permissions";
import { getEntitlement } from "@/lib/billing/context";
import { getDataSource } from "@/lib/data";
import { DataError } from "@/lib/data/errors";
import type { LiaDataSource } from "@/lib/data/types";
import {
  getOrganizationContext,
  type OrganizationContext,
} from "@/lib/tenancy/organization-context";

/**
 * The gate every mutation passes through.
 *
 * Split into two steps on purpose. Establishing the tenant (`mutationContext`)
 * has to happen before the record can be read, and the record is what tells you
 * which location the action touches — which is what a location-scoped role is
 * checked against. Doing it in one call would force every action to guess the
 * location before it could look it up.
 *
 * Role logic itself lives in `@/lib/auth/permissions`; this module only applies
 * it. No action body and no component performs its own role check.
 */

export interface MutationContext extends OrganizationContext {
  dataSource: LiaDataSource;
}

/**
 * Identity plus verified membership, with no permission check yet.
 *
 * Safe to call before authorising: the returned scope only ever reaches
 * organization-scoped repository methods, so the worst a caller can do with it
 * is read rows they are already entitled to read.
 */
export async function mutationContext(): Promise<MutationContext> {
  const context = await getOrganizationContext();
  return { ...context, dataSource: await getDataSource() };
}

/** Organization-wide permission check. Throws a typed error when refused. */
export function assertPermission(
  context: MutationContext,
  permission: Permission,
): void {
  if (!can(context.role, permission)) {
    throw new DataError("forbidden", explainDenial(permission, context.role));
  }
}

/**
 * Permission check that also honours location scoping.
 *
 * A location manager may act on records for the restaurants they manage and
 * nothing else — including nothing organization-wide, because there would be no
 * location to scope them to.
 */
export async function assertPermissionForLocation(
  context: MutationContext,
  permission: Permission,
  locationId: string | null,
): Promise<void> {
  const locations =
    locationId === null ? [] : await context.dataSource.locations.list(context.scope);

  const allowed = canForLocation(permission, {
    role: context.role,
    userId: context.userId,
    locationId,
    locations,
  });

  if (!allowed) {
    throw new DataError("forbidden", explainDenial(permission, context.role));
  }
}

/**
 * Billing check. Throws when an organization has lost paid access.
 *
 * Deliberately separate from `assertPermission` rather than folded into it,
 * because they answer different questions and a refusal has to say which. "Your
 * role cannot do that" and "your subscription has lapsed" send a person to two
 * different places, and collapsing them would send half of them to the wrong
 * one.
 *
 * Which permissions this applies to is `REQUIRES_PAID_ACCESS` in
 * `@/lib/auth/permissions` — one table, exhaustively typed, so a new permission
 * does not compile until somebody decides. Whether it bites at all is the
 * enforcement mode, which is `off` until the rollout says otherwise.
 */
export async function assertEntitled(permission: Permission): Promise<void> {
  if (!requiresPaidAccess(permission)) return;

  const entitlement = await getEntitlement();
  if (entitlement.access !== "read_only") return;

  throw new DataError(
    "forbidden",
    "This organization's subscription is not active. Visit billing to restore access.",
  );
}

/**
 * Convenience for actions with no location dimension.
 *
 * Both gates, in the order a person experiences them: a viewer is told their
 * role cannot do this whatever the subscription says, and only somebody who
 * *could* have done it is told the subscription is the problem.
 */
export async function authorize(permission: Permission): Promise<MutationContext> {
  const context = await mutationContext();
  assertPermission(context, permission);
  await assertEntitled(permission);
  return context;
}
