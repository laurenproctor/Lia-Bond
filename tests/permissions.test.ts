import { describe, expect, it } from "vitest";
import {
  can,
  canForLocation,
  isLocationScoped,
  permissionsFor,
  PERMISSIONS,
} from "@/lib/auth/permissions";
import { MEMBERSHIP_ROLES } from "@/domain";

/**
 * Authorization.
 *
 * These are the tests that matter most: a mistake here is a privilege
 * escalation, not a rendering bug.
 */

describe("role permissions", () => {
  it("gives owners and admins every permission", () => {
    for (const permission of PERMISSIONS) {
      expect(can("owner", permission)).toBe(true);
      expect(can("admin", permission)).toBe(true);
    }
  });

  it("makes analysts and viewers strictly read-only", () => {
    expect(permissionsFor("analyst")).toEqual([]);
    expect(permissionsFor("viewer")).toEqual([]);
  });

  it("lets approvers decide on responses but not manage automation", () => {
    expect(can("approver", "response.decide")).toBe(true);
    expect(can("approver", "automation_rule.toggle")).toBe(false);
    expect(can("approver", "location.update_manager")).toBe(false);
  });

  it("stops a communications lead approving a response", () => {
    // Writing a draft and signing it off are separate jobs.
    expect(can("communications_lead", "response.assign")).toBe(true);
    expect(can("communications_lead", "response.decide")).toBe(false);
  });

  it("stops a location manager reassigning location managers", () => {
    // Otherwise a manager could widen their own scope.
    expect(can("location_manager", "location.update_manager")).toBe(false);
  });

  it("keeps membership management with owners and admins", () => {
    for (const role of MEMBERSHIP_ROLES) {
      const expected = role === "owner" || role === "admin";
      expect(can(role, "organization.manage_members")).toBe(expected);
    }
  });

  it("keeps organization details with owners and admins", () => {
    for (const role of MEMBERSHIP_ROLES) {
      const expected = role === "owner" || role === "admin";
      expect(can(role, "organization.update")).toBe(expected);
    }
  });
});

describe("location scoping", () => {
  const locations = [
    { id: "loc-a", managerUserId: "user-priya" },
    { id: "loc-b", managerUserId: "user-marcus" },
  ];

  it("treats only location managers as scoped", () => {
    expect(isLocationScoped("location_manager")).toBe(true);
    expect(isLocationScoped("admin")).toBe(false);
  });

  it("lets a location manager act on their own location", () => {
    expect(
      canForLocation("mention.update_status", {
        role: "location_manager",
        userId: "user-priya",
        locationId: "loc-a",
        locations,
      }),
    ).toBe(true);
  });

  it("refuses a location manager acting on someone else's location", () => {
    expect(
      canForLocation("mention.update_status", {
        role: "location_manager",
        userId: "user-priya",
        locationId: "loc-b",
        locations,
      }),
    ).toBe(false);
  });

  it("refuses a location manager acting on an organization-wide record", () => {
    // There would be no location to scope them to, so allowing it would widen
    // their authority rather than apply it.
    expect(
      canForLocation("mention.update_status", {
        role: "location_manager",
        userId: "user-priya",
        locationId: null,
        locations,
      }),
    ).toBe(false);
  });

  it("does not scope an admin to a location", () => {
    expect(
      canForLocation("mention.update_status", {
        role: "admin",
        userId: "user-kate",
        locationId: null,
        locations,
      }),
    ).toBe(true);
  });

  it("still refuses a role that lacks the permission outright", () => {
    expect(
      canForLocation("mention.update_status", {
        role: "analyst",
        userId: "user-jordan",
        locationId: "loc-a",
        locations,
      }),
    ).toBe(false);
  });
});

describe("brand voice", () => {
  it("is held by owners, admins, and the communications lead", () => {
    expect(can("owner", "brand_voice.update")).toBe(true);
    expect(can("admin", "brand_voice.update")).toBe(true);
    expect(can("communications_lead", "brand_voice.update")).toBe(true);
  });

  it("is not held by approvers or location managers", () => {
    // Approving one response is a different job from setting the policy for
    // every response. A location manager's authority is scoped to their own
    // restaurants, and the voice is organization-wide.
    expect(can("approver", "brand_voice.update")).toBe(false);
    expect(can("location_manager", "brand_voice.update")).toBe(false);
  });

  it("is not held by analysts or viewers", () => {
    expect(can("analyst", "brand_voice.update")).toBe(false);
    expect(can("viewer", "brand_voice.update")).toBe(false);
  });
});

describe("automation_rule.manage", () => {
  it("automation_rule.manage matches the RLS write roles exactly", () => {
    expect(can("owner", "automation_rule.manage")).toBe(true);
    expect(can("admin", "automation_rule.manage")).toBe(true);
    expect(can("communications_lead", "automation_rule.manage")).toBe(true);
    for (const role of ["location_manager", "approver", "analyst", "viewer"] as const)
      expect(can(role, "automation_rule.manage")).toBe(false);
  });
  it("communications_lead can toggle rules", () =>
    expect(can("communications_lead", "automation_rule.toggle")).toBe(true));
});

describe("response.publish and response.retract", () => {
  it("are held by owners, admins, and the communications lead", () => {
    for (const permission of ["response.publish", "response.retract"] as const) {
      expect(can("owner", permission)).toBe(true);
      expect(can("admin", permission)).toBe(true);
      expect(can("communications_lead", permission)).toBe(true);
    }
  });

  it("are withheld from the approver, keeping signing off and sending apart", () => {
    // The separation of duties this table has kept between writing and
    // approving would be hollow if the person who approved the text were also
    // the one who could put it in front of the public.
    expect(can("approver", "response.publish")).toBe(false);
    expect(can("approver", "response.retract")).toBe(false);
    // They keep the decision itself, which is the job they hold.
    expect(can("approver", "response.decide")).toBe(true);
  });

  it("are withheld from analysts, viewers, and location managers", () => {
    for (const permission of ["response.publish", "response.retract"] as const) {
      for (const role of ["analyst", "viewer", "location_manager"] as const) {
        expect(can(role, permission)).toBe(false);
      }
    }
  });

  it("do not widen who may decide a draft", () => {
    // Adding a publish permission must not accidentally hand the
    // communications lead the approval it is meant to stay separate from.
    expect(can("communications_lead", "response.decide")).toBe(false);
  });
});
