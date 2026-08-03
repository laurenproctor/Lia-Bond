import { describe, expect, it } from "vitest";
import { MEMBERSHIP_ROLES, type MembershipRole } from "@/domain";
import { can, PERMISSIONS, permissionsFor } from "@/lib/auth/permissions";

/**
 * Who may do what to an integration.
 *
 * Written as a table rather than as scattered assertions, because the property
 * that matters is the whole shape of the matrix: which roles can reach a
 * consequential write, and — more importantly — which cannot. A test that only
 * checked the allowed cases would pass just as happily if every role were
 * allowed.
 */

type IntegrationPermission =
  | "integration.connect"
  | "integration.reauthorize"
  | "integration.manage_profiles"
  | "integration.test_connection"
  | "integration.disconnect";

const EXPECTED: Record<IntegrationPermission, MembershipRole[]> = {
  // An OAuth grant hands Lia standing authority over a customer's Google
  // listings. That decision stays with the people accountable for the account.
  "integration.connect": ["owner", "admin"],
  "integration.reauthorize": ["owner", "admin"],
  // Consequential but reversible, and the day-to-day work of running the
  // integration — which is the communications lead's job.
  "integration.manage_profiles": ["owner", "admin", "communications_lead"],
  // Read-only against Google; changes no Lia state beyond a health record.
  "integration.test_connection": ["owner", "admin", "communications_lead"],
  // Silently stops every downstream feature.
  "integration.disconnect": ["owner", "admin"],
};

const CONSEQUENTIAL: IntegrationPermission[] = [
  "integration.connect",
  "integration.reauthorize",
  "integration.manage_profiles",
  "integration.disconnect",
];

describe("integration permission matrix", () => {
  it.each(Object.entries(EXPECTED))(
    "%s is granted to exactly the expected roles",
    (permission, allowed) => {
      const actual = MEMBERSHIP_ROLES.filter((role) =>
        can(role, permission as IntegrationPermission),
      );

      expect([...actual].sort()).toEqual([...allowed].sort());
    },
  );

  it("registers every integration permission in the central list", () => {
    // A permission checked in an action but missing here would be a silent
    // type error waiting to happen.
    for (const permission of Object.keys(EXPECTED)) {
      expect(PERMISSIONS).toContain(permission);
    }
  });
});

describe("read-only roles", () => {
  it.each(["viewer", "analyst", "approver"] as const)(
    "%s performs no consequential integration write",
    (role) => {
      // Reading an integration is governed by holding an active membership, not
      // by this table — hence no view assertion. What matters here is that none
      // of these roles can reach a write.
      for (const permission of CONSEQUENTIAL) {
        expect(can(role, permission)).toBe(false);
      }
      expect(can(role, "integration.test_connection")).toBe(false);
    },
  );
});

describe("location manager", () => {
  it("cannot change the connection or its mappings", () => {
    // A profile mapping is an organization-wide decision about which Google
    // listing represents which restaurant. There is no location to scope a
    // location manager to, so granting it would widen their authority beyond
    // their own sites.
    for (const permission of CONSEQUENTIAL) {
      expect(can("location_manager", permission)).toBe(false);
    }
    expect(can("location_manager", "integration.test_connection")).toBe(false);
  });
});

describe("communications lead", () => {
  it("manages mappings and tests the connection, but does not hold the grant", () => {
    expect(can("communications_lead", "integration.manage_profiles")).toBe(true);
    expect(can("communications_lead", "integration.test_connection")).toBe(true);

    expect(can("communications_lead", "integration.connect")).toBe(false);
    expect(can("communications_lead", "integration.reauthorize")).toBe(false);
    expect(can("communications_lead", "integration.disconnect")).toBe(false);
  });
});

describe("owners and admins", () => {
  it.each(["owner", "admin"] as const)("%s holds every integration permission", (role) => {
    const held = permissionsFor(role);

    for (const permission of Object.keys(EXPECTED)) {
      expect(held).toContain(permission);
    }
  });
});

describe("the matrix as a whole", () => {
  it("grants no consequential integration write outside owner and admin, except mappings", () => {
    // The one deliberate exception, stated once so widening it is a visible
    // edit here rather than a quiet line in the matrix.
    for (const permission of CONSEQUENTIAL) {
      const allowed = MEMBERSHIP_ROLES.filter((role) => can(role, permission));
      const unexpected = allowed.filter(
        (role) => role !== "owner" && role !== "admin",
      );

      if (permission === "integration.manage_profiles") {
        expect(unexpected).toEqual(["communications_lead"]);
      } else {
        expect(unexpected).toEqual([]);
      }
    }
  });
});
