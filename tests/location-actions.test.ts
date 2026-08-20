import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDataSource, harbor, ORG_HARBOR, ushg } from "./helpers/scope";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import { MEMBERSHIP_ROLES, type Location } from "@/domain";
import { USER_KATE, USER_MARCUS, USER_SOFIA } from "@/lib/seed/dataset";

/**
 * The manual location actions.
 *
 * `authorize` is mocked so this runs without `next/headers` session machinery —
 * the pattern `tests/monitoring-actions.test.ts` established — while the mocked
 * context still carries a **real** demo data source, so the scoped lookups, the
 * repository's own validation, and the audit writes underneath are the genuine
 * ones rather than stand-ins.
 */

const authorizeMock = vi.fn();

vi.mock("@/lib/actions/guard", () => ({
  authorize: (permission: string) => authorizeMock(permission),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let dataSource: LiaDataSource;

function contextFor(scope: OrganizationScope) {
  return {
    organization: { id: scope.organizationId },
    role: scope.role,
    userId: scope.userId,
    scope,
    available: [],
    dataSource,
  };
}

/** What the real `authorize` does: resolve the context, then check the role. */
function authorizeAs(scope: OrganizationScope) {
  authorizeMock.mockImplementation(async (permission: string) => {
    const { can, explainDenial } = await import("@/lib/auth/permissions");
    const { DataError } = await import("@/lib/data/errors");
    if (!can(scope.role, permission as never)) {
      throw new DataError("forbidden", explainDenial(permission as never, scope.role));
    }
    return contextFor(scope);
  });
}

const BASE_INPUT = {
  name: "Gramercy Tavern",
  addressLine1: "42 E 20th St",
  addressLine2: null,
  city: "New York",
  region: "NY",
  postalCode: "10003",
  countryCode: "US",
  timezone: "America/New_York",
  managerUserId: null,
};

/** Every audit event recorded for one entity, newest last. */
async function eventsFor(scope: OrganizationScope, entityId: string) {
  const all = await dataSource.auditEvents.list(scope, { limit: 200 });
  return all.filter((event) => event.entityId === entityId);
}

function editOf(location: Location, changes: Partial<Location> = {}) {
  return {
    locationId: location.id,
    name: location.name,
    slug: location.slug,
    addressLine1: location.addressLine1,
    addressLine2: location.addressLine2,
    city: location.city,
    region: location.region,
    postalCode: location.postalCode,
    countryCode: location.countryCode,
    timezone: location.timezone,
    status: location.status,
    managerUserId: location.managerUserId,
    ...changes,
  };
}

beforeEach(() => {
  dataSource = freshDataSource();
  authorizeMock.mockReset();
});

describe("who may create and edit a location", () => {
  it("lets owners and admins do both", async () => {
    const { createLocationAction, updateLocationAction } = await import(
      "@/app/actions/locations"
    );

    for (const scope of [ushg.owner(), ushg.admin()]) {
      authorizeAs(scope);

      const created = await createLocationAction({
        ...BASE_INPUT,
        name: `House ${scope.role}`,
      });
      expect(created.ok).toBe(true);
      if (!created.ok) continue;

      const location = await dataSource.locations.get(scope, created.data.locationId);
      const updated = await updateLocationAction(editOf(location!, { city: "Queens" }));
      expect(updated.ok).toBe(true);
    }
  });

  it("refuses every other role, and writes nothing", async () => {
    const { createLocationAction, updateLocationAction } = await import(
      "@/app/actions/locations"
    );

    const [existing] = await dataSource.locations.list(ushg.admin());
    const before = (await dataSource.locations.list(ushg.admin())).length;

    const refused = MEMBERSHIP_ROLES.filter(
      (role) => role !== "owner" && role !== "admin",
    );

    for (const role of refused) {
      authorizeAs({ organizationId: ushg.admin().organizationId, userId: USER_KATE, role });

      const created = await createLocationAction(BASE_INPUT);
      expect(created.ok, `${role} must not create`).toBe(false);

      const updated = await updateLocationAction(
        editOf(existing!, { name: "Renamed by an unauthorized role" }),
      );
      expect(updated.ok, `${role} must not update`).toBe(false);
    }

    expect((await dataSource.locations.list(ushg.admin())).length).toEqual(before);
    const unchanged = await dataSource.locations.get(ushg.admin(), existing!.id);
    expect(unchanged?.name).toEqual(existing!.name);
  });
});

describe("cross-tenant ids", () => {
  it("cannot edit another organization's location, and says nothing about it", async () => {
    const { updateLocationAction } = await import("@/app/actions/locations");

    const [theirs] = await dataSource.locations.list(harbor.owner());
    authorizeAs(ushg.admin());

    const result = await updateLocationAction(editOf(theirs!, { name: "Taken over" }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // Foreign and missing take the same branch. A distinct message would
    // confirm the record exists, which is what a foreign id must not learn.
    expect(result.error.toLowerCase()).toContain("not found");
    expect(result.error).not.toContain(ORG_HARBOR);

    const untouched = await dataSource.locations.get(harbor.owner(), theirs!.id);
    expect(untouched?.name).toEqual(theirs!.name);
  });

  it("cannot assign a manager from another organization", async () => {
    const { createLocationAction } = await import("@/app/actions/locations");
    authorizeAs(ushg.owner());

    const result = await createLocationAction({
      ...BASE_INPUT,
      managerUserId: USER_SOFIA, // Harbor's owner
    });

    expect(result.ok).toBe(false);
  });
});

describe("manual creation leaves onboarding alone", () => {
  it("does not complete a step or seed a monitoring query", async () => {
    const { createLocationAction } = await import("@/app/actions/locations");

    // Deliberately against an organization whose onboarding is *incomplete* —
    // that is the only state where an accidental `completeLocationsStep` would
    // do damage. Both seeded tenants are `completed`, so the assertion would
    // pass vacuously against either.
    //
    // A freshly provisioned organization is that state by construction:
    // `in_progress`, at step one, nothing settled. No fixture surgery needed.
    const provisioned = await dataSource.organizations.provision({
      userId: USER_KATE,
      name: "Onboarding Isolation Group",
    });
    const scope: OrganizationScope = {
      organizationId: provisioned.organization.id,
      userId: USER_KATE,
      role: "owner",
    };

    const before = await dataSource.onboarding.get(scope);
    expect(before?.status).toEqual("in_progress");
    expect(before?.locationsCompletedAt).toBeNull();

    const queriesBefore = (await dataSource.monitoringQueries.list(scope)).length;

    authorizeAs(scope);
    const result = await createLocationAction(BASE_INPUT);
    expect(result.ok).toBe(true);

    // Byte-identical, not merely "still in progress": advancing `currentStep`
    // or stamping any timestamp would be the same defect in a quieter form.
    expect(await dataSource.onboarding.get(scope)).toEqual(before);
    expect((await dataSource.monitoringQueries.list(scope)).length).toEqual(queriesBefore);
  });

  it("starts the location in setup", async () => {
    const { createLocationAction } = await import("@/app/actions/locations");
    const scope = ushg.owner();
    authorizeAs(scope);

    const result = await createLocationAction(BASE_INPUT);
    if (!result.ok) throw new Error(result.error);

    const location = await dataSource.locations.get(scope, result.data.locationId);
    expect(location?.status).toEqual("setup");
  });
});

describe("the audit partition", () => {
  /**
   * The whole point of three events rather than one.
   *
   * If `location.updated` also fired for status and manager changes, every
   * query for "who changed this restaurant's address" would return retirements
   * and reassignments too, and the specific events would answer nothing.
   */
  async function setup() {
    const { createLocationAction } = await import("@/app/actions/locations");
    const scope = ushg.owner();
    authorizeAs(scope);
    const created = await createLocationAction(BASE_INPUT);
    if (!created.ok) throw new Error(created.error);
    const location = await dataSource.locations.get(scope, created.data.locationId);
    return { scope, location: location! };
  }

  it("records creation as manual", async () => {
    const { scope, location } = await setup();
    const events = await eventsFor(scope, location.id);

    expect(events.map((event) => event.eventType)).toEqual(["location.created"]);
    // Three ways a location can come to exist; three answers for an auditor.
    expect(events[0]?.metadata).toMatchObject({ source: "manual" });
  });

  it("emits only location.updated for an identity change", async () => {
    const { updateLocationAction } = await import("@/app/actions/locations");
    const { scope, location } = await setup();

    await updateLocationAction(editOf(location, { name: "Renamed" }));

    const types = (await eventsFor(scope, location.id)).map((event) => event.eventType);
    expect(types).toContain("location.updated");
    expect(types).not.toContain("location.status_changed");
    expect(types).not.toContain("location.manager_changed");
  });

  it("emits only location.status_changed for a status change", async () => {
    const { updateLocationAction } = await import("@/app/actions/locations");
    const { scope, location } = await setup();

    await updateLocationAction(editOf(location, { status: "active" }));

    const types = (await eventsFor(scope, location.id)).map((event) => event.eventType);
    expect(types).toContain("location.status_changed");
    expect(types).not.toContain("location.updated");
  });

  it("emits only location.manager_changed for a manager change", async () => {
    const { updateLocationAction } = await import("@/app/actions/locations");
    const { scope, location } = await setup();

    await updateLocationAction(editOf(location, { managerUserId: USER_MARCUS }));

    const types = (await eventsFor(scope, location.id)).map((event) => event.eventType);
    expect(types).toContain("location.manager_changed");
    // The one that would quietly ruin the other two if it fired here.
    expect(types).not.toContain("location.updated");
    expect(types).not.toContain("location.status_changed");
  });

  it("emits two events for an edit that spans two partitions", async () => {
    const { updateLocationAction } = await import("@/app/actions/locations");
    const { scope, location } = await setup();

    await updateLocationAction(editOf(location, { name: "Renamed", status: "active" }));

    const types = (await eventsFor(scope, location.id))
      .map((event) => event.eventType)
      .filter((type) => type !== "location.created");
    expect(types.sort()).toEqual(["location.status_changed", "location.updated"]);
  });

  it("emits nothing for a no-op submission", async () => {
    const { updateLocationAction } = await import("@/app/actions/locations");
    const { scope, location } = await setup();

    const result = await updateLocationAction(editOf(location));
    expect(result.ok).toBe(true);

    const types = (await eventsFor(scope, location.id)).map((event) => event.eventType);
    // Saving a form without changing anything is not an event. Recording one
    // would make the trail unreadable for the changes that matter.
    expect(types).toEqual(["location.created"]);
  });
});

describe("slug conflicts", () => {
  it("surfaces as a field error the form can point at", async () => {
    const { createLocationAction, updateLocationAction } = await import(
      "@/app/actions/locations"
    );
    const scope = ushg.owner();
    authorizeAs(scope);

    const first = await createLocationAction({ ...BASE_INPUT, name: "Harbourside" });
    const second = await createLocationAction({ ...BASE_INPUT, name: "Tribeca Yard" });
    if (!first.ok || !second.ok) throw new Error("setup failed");

    const target = await dataSource.locations.get(scope, second.data.locationId);
    const taken = await dataSource.locations.get(scope, first.data.locationId);

    const result = await updateLocationAction(editOf(target!, { slug: taken!.slug }));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors?.slug).toBeDefined();
  });
});
