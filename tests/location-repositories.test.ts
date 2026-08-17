import { beforeEach, describe, expect, it } from "vitest";
import { freshDataSource, harbor, ORG_HARBOR, ORG_USHG, ushg } from "./helpers/scope";
import { DataError } from "@/lib/data/errors";
import type { LiaDataSource } from "@/lib/data/types";
import { USER_MARCUS, USER_SOFIA } from "@/lib/seed/dataset";
import type { CreateManualLocationInput, Location } from "@/domain";

/**
 * The location repository: multiple locations, per-organization slugs, the
 * manager invariant, and what inactivation does and does not touch.
 *
 * Against the demo adapter, which is where these rules can be exercised without
 * a database. The Supabase adapter enforces the same ones a second time in SQL
 * — `locations_manager_same_org` and `locations_manager_is_active_member` for
 * the manager, `locations_unique_slug_per_org` for the slug — and
 * `supabase/tests/tenancy-verification.sql` is what proves those. A rule that
 * lives only in application code protects only the paths that remember to call
 * it, so both halves exist on purpose and neither is redundant.
 */

let data: LiaDataSource;

beforeEach(() => {
  data = freshDataSource();
});

const BASE: CreateManualLocationInput = {
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

/** The update input, built from a location so only the field under test moves. */
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

describe("many locations in one organization", () => {
  it("keeps every created location, all stamped with the caller's organization", async () => {
    const scope = ushg.owner();
    const before = (await data.locations.list(scope)).length;

    for (const name of ["Alpha House", "Beta House", "Gamma House"]) {
      await data.locations.create(scope, { ...BASE, name });
    }

    const after = await data.locations.list(scope);
    expect(after).toHaveLength(before + 3);
    expect(after.every((row) => row.organizationId === ORG_USHG)).toBe(true);

    // And none of them leaked sideways.
    const theirs = await data.locations.list(harbor.owner());
    expect(theirs.every((row) => row.organizationId === ORG_HARBOR)).toBe(true);
  });

  it("derives a distinct slug for a repeated name rather than refusing it", async () => {
    const scope = ushg.owner();
    const first = await data.locations.create(scope, BASE);
    const second = await data.locations.create(scope, BASE);

    expect(second.slug).not.toEqual(first.slug);
    // No slug was supplied, so de-duplicating is the repository's job — this
    // must not surface as a conflict the person has to resolve.
    expect(second.name).toEqual(first.name);
  });
});

describe("slugs are unique per organization, not globally", () => {
  it("accepts the same slug in two organizations", async () => {
    const mine = await data.locations.create(ushg.owner(), { ...BASE, slug: "harbourside" });
    const theirs = await data.locations.create(harbor.owner(), { ...BASE, slug: "harbourside" });

    expect(mine.slug).toEqual("harbourside");
    expect(theirs.slug).toEqual("harbourside");
    expect(mine.organizationId).not.toEqual(theirs.organizationId);
  });

  it("refuses the same slug twice in one organization", async () => {
    const scope = ushg.owner();
    await data.locations.create(scope, { ...BASE, slug: "harbourside" });

    await expect(
      data.locations.create(scope, { ...BASE, name: "Harbourside Again", slug: "harbourside" }),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses an edit that collides with another location's slug", async () => {
    const scope = ushg.owner();
    const first = await data.locations.create(scope, { ...BASE, slug: "harbourside" });
    const second = await data.locations.create(scope, { ...BASE, slug: "tribeca-yard" });

    const failure = await data.locations
      .update(scope, editOf(second, { slug: first.slug }))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DataError);
    expect((failure as DataError).code).toEqual("conflict");
    // A field error, so the form can point at the box rather than at the page.
    expect((failure as DataError).fieldErrors).toHaveProperty("slug");
  });

  it("lets a location keep its own slug through an unrelated edit", async () => {
    const scope = ushg.owner();
    const location = await data.locations.create(scope, { ...BASE, slug: "harbourside" });

    const updated = await data.locations.update(
      scope,
      editOf(location, { city: "Brooklyn" }),
    );

    expect(updated.slug).toEqual("harbourside");
    expect(updated.city).toEqual("Brooklyn");
  });
});

describe("the manager must be an active member of the same organization", () => {
  it("refuses a manager from another organization, on create and on update", async () => {
    const scope = ushg.owner();

    await expect(
      data.locations.create(scope, { ...BASE, managerUserId: USER_SOFIA }),
    ).rejects.toMatchObject({ code: "invalid_input" });

    const location = await data.locations.create(scope, BASE);
    await expect(
      data.locations.update(scope, editOf(location, { managerUserId: USER_SOFIA })),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("refuses a suspended member and accepts an active one", async () => {
    const scope = ushg.owner();
    const location = await data.locations.create(scope, BASE);

    const active = await data.locations.update(
      scope,
      editOf(location, { managerUserId: USER_MARCUS }),
    );
    expect(active.managerUserId).toEqual(USER_MARCUS);

    await data.memberships.updateStatus(scope, USER_MARCUS, "suspended");

    // A *new* assignment to somebody suspended is refused. This mirrors the
    // trigger, which fires on assignment and never on suspension.
    const other = await data.locations.create(scope, { ...BASE, name: "Second House" });
    await expect(
      data.locations.update(scope, editOf(other, { managerUserId: USER_MARCUS })),
    ).rejects.toMatchObject({ code: "invalid_input" });
  });

  it("keeps an existing assignment when the manager is suspended", async () => {
    const scope = ushg.owner();
    const location = await data.locations.create(scope, BASE);
    await data.locations.update(scope, editOf(location, { managerUserId: USER_MARCUS }));

    await data.memberships.updateStatus(scope, USER_MARCUS, "suspended");

    // Suspension is the reversible option for somebody on leave. Silently
    // unassigning their restaurants — and making an owner reconstruct the
    // mapping on their return — would be a worse surprise than a label saying
    // their access is suspended. RLS already stops them reaching anything.
    const after = await data.locations.get(scope, location.id);
    expect(after?.managerUserId).toEqual(USER_MARCUS);

    // And an unrelated edit does not re-validate them.
    const edited = await data.locations.update(scope, editOf(after!, { city: "Queens" }));
    expect(edited.managerUserId).toEqual(USER_MARCUS);
  });
});

describe("cross-tenant reads and writes", () => {
  it("cannot update another organization's location, and says nothing about it", async () => {
    const theirs = await data.locations.create(harbor.owner(), BASE);

    const failure = await data.locations
      .update(ushg.owner(), editOf(theirs, { name: "Renamed" }))
      .catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(DataError);
    expect((failure as DataError).code).toEqual("not_found");
    // Foreign and missing must be one answer. A distinct "you don't have
    // access to that" message confirms the record exists.
    expect((failure as DataError).message).not.toContain(ORG_HARBOR);

    const untouched = await data.locations.get(harbor.owner(), theirs.id);
    expect(untouched?.name).toEqual(BASE.name);
  });
});

describe("inactivation retains everything", () => {
  it("changes nothing but the status", async () => {
    const scope = ushg.admin();
    // Chosen by having mentions rather than by position: the assertion below is
    // that inactivation preserves history, which proves nothing against a
    // location that never had any.
    const mentions = await data.mentions.list(scope);
    const busiest = mentions.find((row) => row.locationId !== null)?.locationId;
    const location = (await data.locations.list(scope)).find((row) => row.id === busiest);
    expect(location).toBeDefined();

    const before = {
      mentions: (await data.mentions.list(scope)).filter(
        (row) => row.locationId === location!.id,
      ).length,
      profiles: (await data.platformProfiles.list(scope)).filter(
        (row) => row.locationId === location!.id,
      ).length,
      drafts: (await data.responseDrafts.list(scope)).length,
    };
    expect(before.mentions).toBeGreaterThan(0);

    await data.locations.update(scope, editOf(location!, { status: "inactive" }));

    const after = {
      mentions: (await data.mentions.list(scope)).filter(
        (row) => row.locationId === location!.id,
      ).length,
      profiles: (await data.platformProfiles.list(scope)).filter(
        (row) => row.locationId === location!.id,
      ).length,
      drafts: (await data.responseDrafts.list(scope)).length,
    };

    expect(after).toEqual(before);
    // Still listed, too. Retired is not hidden.
    const listed = await data.locations.list(scope);
    expect(listed.some((row) => row.id === location!.id)).toBe(true);
  });
});

describe("partial-update safety", () => {
  it("leaves every field a submission did not change", async () => {
    const scope = ushg.owner();
    const created = await data.locations.create(scope, {
      ...BASE,
      addressLine2: "Suite 4",
    });

    const updated = await data.locations.update(scope, editOf(created, { name: "Renamed" }));

    // The regression this guards: `updateLocationInputSchema` is declared field
    // by field rather than derived with `.partial()`, because Zod's `.partial()`
    // leaves `.default()` in place — an absent key parses to the default and
    // the adapter writes it. That shipped once in
    // `updateMonitoringQueryInputSchema` and blanked columns nobody edited.
    expect(updated.name).toEqual("Renamed");
    expect(updated.addressLine2).toEqual("Suite 4");
    expect(updated.postalCode).toEqual(created.postalCode);
    expect(updated.timezone).toEqual(created.timezone);
    expect(updated.status).toEqual(created.status);
  });

  it("round-trips every editable field", async () => {
    const scope = ushg.owner();
    const created = await data.locations.create(scope, BASE);

    const updated = await data.locations.update(
      scope,
      editOf(created, {
        name: "Union Square Cafe",
        slug: "union-square-cafe",
        addressLine1: "101 E 19th St",
        addressLine2: "Floor 2",
        city: "Manhattan",
        region: "New York",
        postalCode: "10003-1234",
        countryCode: "US",
        timezone: "America/Chicago",
        status: "review",
      }),
    );

    expect(updated).toMatchObject({
      name: "Union Square Cafe",
      slug: "union-square-cafe",
      addressLine1: "101 E 19th St",
      addressLine2: "Floor 2",
      city: "Manhattan",
      region: "New York",
      postalCode: "10003-1234",
      timezone: "America/Chicago",
      status: "review",
    });
  });
});
