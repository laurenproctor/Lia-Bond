import "server-only";

import { cookies } from "next/headers";
import { cache } from "react";
import type { Membership, Organization, OrganizationMembership } from "@/domain";
import { getSession } from "@/lib/auth/session";
import { getDataSource } from "@/lib/data";
import { DataError } from "@/lib/data/errors";
import type { OrganizationScope } from "@/lib/data/types";

/**
 * Active-organization resolution.
 *
 * The organization slug is not in the URL — `CLAUDE.md` fixes the route list,
 * and prefixing every route would contradict it. Instead the active
 * organization lives in an httpOnly cookie.
 *
 * That cookie is treated as an untrusted hint, never as authorisation. On every
 * request the membership row is re-read, and if the caller does not hold an
 * active membership in the requested organization the value is discarded and
 * the first organization they genuinely belong to is used instead. A forged
 * cookie therefore buys nothing.
 */

export const ACTIVE_ORGANIZATION_COOKIE = "lia_active_organization";

export interface OrganizationContext {
  organization: Organization;
  role: Membership["role"];
  userId: string;
  /** Verified capability token to pass into repositories. */
  scope: OrganizationScope;
  /** Every organization the caller belongs to, for the switcher. */
  available: OrganizationMembership[];
}

/**
 * Resolve the active organization for this request.
 *
 * Wrapped in React's `cache` so several server components on one page share a
 * single membership lookup instead of each paying for their own.
 */
export const getOrganizationContext = cache(
  async (): Promise<OrganizationContext> => {
    const session = await getSession();
    if (!session) {
      throw new DataError("not_authenticated", "Sign in to continue.");
    }

    const dataSource = await getDataSource();
    const available = await dataSource.organizations.listForUser(session.id);

    if (available.length === 0) {
      throw new DataError(
        "not_a_member",
        "Your account is not a member of any organization yet.",
      );
    }

    const store = await cookies();
    const requestedId = store.get(ACTIVE_ORGANIZATION_COOKIE)?.value;

    // The cookie only ever selects among organizations the caller already
    // belongs to. An unknown or foreign id silently falls back.
    const selected =
      available.find((entry) => entry.organization.id === requestedId) ?? available[0];

    if (!selected) {
      throw new DataError("not_a_member", "No organization is available for this account.");
    }

    return {
      organization: selected.organization,
      role: selected.role,
      userId: session.id,
      scope: {
        organizationId: selected.organization.id,
        userId: session.id,
        role: selected.role,
      },
      available,
    };
  },
);

/** Just the scope, for call sites that only need to query. */
export async function getOrganizationScope(): Promise<OrganizationScope> {
  const context = await getOrganizationContext();
  return context.scope;
}

/**
 * Verify a caller-supplied organization id before switching to it.
 *
 * Used by the organization switcher action. Returns the verified id, or throws
 * — the id is never written to the cookie on trust.
 */
export async function verifyOrganizationAccess(
  organizationId: string,
): Promise<string> {
  const session = await getSession();
  if (!session) throw new DataError("not_authenticated", "Sign in to continue.");

  const dataSource = await getDataSource();
  const membership = await dataSource.organizations.getById(organizationId, session.id);

  if (!membership) {
    throw new DataError("not_a_member", "You don't have access to that organization.");
  }

  return membership.organization.id;
}
