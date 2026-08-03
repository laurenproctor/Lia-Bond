import "server-only";

import { can, canForLocation, explainDenial, type Permission } from "@/lib/auth/permissions";
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

/** Convenience for actions with no location dimension. */
export async function authorize(permission: Permission): Promise<MutationContext> {
  const context = await mutationContext();
  assertPermission(context, permission);
  return context;
}
