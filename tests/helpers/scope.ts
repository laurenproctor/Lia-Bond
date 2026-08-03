import { createDemoDataSource } from "@/lib/data/demo";
import { resetDemoStore } from "@/lib/data/demo/store";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import {
  ORG_HARBOR,
  ORG_USHG,
  USER_DANIEL,
  USER_JORDAN,
  USER_KATE,
  USER_MARCUS,
  USER_NAOMI,
  USER_PRIYA,
  USER_SOFIA,
} from "@/lib/seed/dataset";
import type { MembershipRole } from "@/domain";

/**
 * Test scaffolding.
 *
 * Builds the same `OrganizationScope` the application builds, so repository
 * tests exercise the real tenant boundary rather than a test-only shortcut.
 */

export function freshDataSource(): LiaDataSource {
  resetDemoStore();
  return createDemoDataSource();
}

export function scopeFor(
  organizationId: string,
  userId: string,
  role: MembershipRole,
): OrganizationScope {
  return { organizationId, userId, role };
}

/** Union Square Hospitality Group — the primary tenant. */
export const ushg = {
  owner: () => scopeFor(ORG_USHG, USER_DANIEL, "owner"),
  admin: () => scopeFor(ORG_USHG, USER_KATE, "admin"),
  comms: () => scopeFor(ORG_USHG, USER_NAOMI, "communications_lead"),
  locationManager: () => scopeFor(ORG_USHG, USER_PRIYA, "location_manager"),
  approver: () => scopeFor(ORG_USHG, USER_MARCUS, "approver"),
  analyst: () => scopeFor(ORG_USHG, USER_JORDAN, "analyst"),
};

/** Harbor & Vine — the second tenant, used only to prove isolation. */
export const harbor = {
  owner: () => scopeFor(ORG_HARBOR, USER_SOFIA, "owner"),
};

export { ORG_HARBOR, ORG_USHG };
