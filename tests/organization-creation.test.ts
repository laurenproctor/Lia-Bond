import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { freshDataSource, ORG_HARBOR, ORG_USHG } from "./helpers/scope";
import type { LiaDataSource } from "@/lib/data/types";
import { USER_DANIEL, USER_JORDAN, USER_SOFIA } from "@/lib/seed/dataset";

/**
 * Creating an organization from inside the product.
 *
 * `USER_DANIEL` drives most of this deliberately: he owns Union Square
 * Hospitality and is a *viewer* in Harbor & Vine, so he is the seed's one
 * genuinely multi-organization account. Every assertion about selection and
 * listing is worth more against him than against a single-membership user,
 * where `getOrganizationContext`'s "fall back to the first membership" would
 * produce the right answer by accident and hide the bug.
 *
 * `requireSession` and the cookie jar are mocked; the data source is a real
 * demo adapter, so the provisioning path underneath — including its replay arm
 * and its audit event — is the genuine one rather than a stand-in.
 */

const { requireSession } = vi.hoisted(() => ({ requireSession: vi.fn() }));
const { cookieSet } = vi.hoisted(() => ({ cookieSet: vi.fn() }));

vi.mock("@/lib/auth/session", () => ({
  requireSession: () => requireSession(),
  getSession: () => requireSession(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({ set: cookieSet, get: () => undefined }),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let dataSource: LiaDataSource;

vi.mock("@/lib/data", () => ({
  getDataSource: async () => dataSource,
}));

beforeEach(() => {
  dataSource = freshDataSource();
  requireSession.mockReset();
  cookieSet.mockReset();
  requireSession.mockResolvedValue({ id: USER_DANIEL, email: "daniel@example.com" });
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** A fresh key per call, unless a test is deliberately replaying one. */
function key(): string {
  return crypto.randomUUID();
}

describe("a user who already belongs to organizations can create another", () => {
  it("adds a third, and leaves the two they had", async () => {
    const { createOrganizationAction } = await import("@/app/actions/organization");

    const before = await dataSource.organizations.listForUser(USER_DANIEL);
    expect(before.map((entry) => entry.role).sort()).toEqual(["owner", "viewer"]);

    const result = await createOrganizationAction({
      name: "Bond Hospitality",
      requestKey: key(),
    });

    expect(result.ok).toBe(true);

    const after = await dataSource.organizations.listForUser(USER_DANIEL);
    expect(after).toHaveLength(3);
    // Owner of the one he had, viewer of the one he was invited to, owner of
    // the one he just made. The role he holds elsewhere is irrelevant to this.
    expect(after.map((entry) => entry.role).sort()).toEqual(["owner", "owner", "viewer"]);
  });

  it("changes nothing about the organizations they already belonged to", async () => {
    const { createOrganizationAction } = await import("@/app/actions/organization");

    const snapshot = async () => ({
      ushg: await dataSource.organizations.getById(ORG_USHG, USER_DANIEL),
      harbor: await dataSource.organizations.getById(ORG_HARBOR, USER_DANIEL),
      ushgOnboarding: await dataSource.onboarding.get({
        organizationId: ORG_USHG,
        userId: USER_DANIEL,
        role: "owner",
      }),
      harborOnboarding: await dataSource.onboarding.get({
        organizationId: ORG_HARBOR,
        userId: USER_SOFIA,
        role: "owner",
      }),
    });

    const before = await snapshot();
    await createOrganizationAction({ name: "Bond Hospitality", requestKey: key() });
    const after = await snapshot();

    expect(after).toEqual(before);
  });

  it("starts the new organization at step one, with nothing completed", async () => {
    const { createOrganizationAction } = await import("@/app/actions/organization");

    const result = await createOrganizationAction({
      name: "Bond Hospitality",
      requestKey: key(),
    });
    if (!result.ok) throw new Error(result.error);

    const scope = {
      organizationId: result.data.organizationId,
      userId: USER_DANIEL,
      role: "owner" as const,
    };
    const onboarding = await dataSource.onboarding.get(scope);

    expect(onboarding).toMatchObject({
      status: "in_progress",
      currentStep: "organization",
      organizationCompletedAt: null,
      sourceCompletedAt: null,
      locationsCompletedAt: null,
      brandVoiceCompletedAt: null,
      teamCompletedAt: null,
      completedAt: null,
    });

    // And it is genuinely empty rather than inheriting anything.
    expect(await dataSource.locations.list(scope)).toEqual([]);
  });

  it("selects it and sends the owner to step one", async () => {
    const { createOrganizationAction } = await import("@/app/actions/organization");

    const result = await createOrganizationAction({
      name: "Bond Hospitality",
      requestKey: key(),
    });
    if (!result.ok) throw new Error(result.error);

    expect(result.data.nextPath).toEqual("/onboarding/organization");
    // A dashboard of zeroes would teach somebody the product is empty rather
    // than that it is unconfigured, which is why this is not `/overview`.
    expect(cookieSet).toHaveBeenCalledWith(
      "lia_active_organization",
      result.data.organizationId,
      expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/" }),
    );
  });
});

describe("the request key makes a double submission harmless", () => {
  it("returns the first organization and creates no second one", async () => {
    const { createOrganizationAction } = await import("@/app/actions/organization");

    const shared = key();
    const first = await createOrganizationAction({ name: "Bond", requestKey: shared });
    const second = await createOrganizationAction({ name: "Bond", requestKey: shared });

    if (!first.ok || !second.ok) throw new Error("both calls should succeed");
    expect(second.data.organizationId).toEqual(first.data.organizationId);

    const all = await dataSource.organizations.listForUser(USER_DANIEL);
    expect(all).toHaveLength(3);
  });

  it("writes exactly one organization.created event across both calls", async () => {
    const { createOrganizationAction } = await import("@/app/actions/organization");

    const shared = key();
    const first = await createOrganizationAction({ name: "Bond", requestKey: shared });
    await createOrganizationAction({ name: "Bond", requestKey: shared });
    if (!first.ok) throw new Error(first.error);

    const events = await dataSource.auditEvents.list({
      organizationId: first.data.organizationId,
      userId: USER_DANIEL,
      role: "owner",
    });

    const created = events.filter((event) => event.eventType === "organization.created");
    expect(created).toHaveLength(1);
    // Written by the repository, in the same place the RPC writes it, carrying
    // the entry point and the acting user.
    expect(created[0]).toMatchObject({
      organizationId: first.data.organizationId,
      actorUserId: USER_DANIEL,
      actorType: "user",
      entityType: "organization",
      metadata: { source: "in_app" },
    });
  });

  it("creates two organizations for two different keys", async () => {
    const { createOrganizationAction } = await import("@/app/actions/organization");

    await createOrganizationAction({ name: "Bond", requestKey: key() });
    await createOrganizationAction({ name: "Bond", requestKey: key() });

    const all = await dataSource.organizations.listForUser(USER_DANIEL);
    expect(all).toHaveLength(4);
  });

  it("refuses a key that belongs to somebody else, without naming what it found", async () => {
    const { createOrganizationAction } = await import("@/app/actions/organization");

    const shared = key();
    const mine = await createOrganizationAction({ name: "Bond", requestKey: shared });
    if (!mine.ok) throw new Error(mine.error);

    // A different account replaying the same key. The demo adapter mirrors the
    // RPC's actor-scoped lookup: the organization is not theirs, so it is
    // refused rather than handed over.
    requireSession.mockResolvedValue({ id: USER_JORDAN, email: "jordan@example.com" });
    const theirs = await createOrganizationAction({ name: "Bond", requestKey: shared });

    expect(theirs.ok).toBe(false);
    if (theirs.ok) return;
    expect(theirs.error).not.toContain(mine.data.organizationId);
  });
});

describe("who may create one", () => {
  it("lets somebody with no permissions anywhere create and own an organization", async () => {
    const { createOrganizationAction } = await import("@/app/actions/organization");

    // Jordan is an analyst in USHG — `permissionsFor("analyst")` is empty, so
    // he can do nothing at all in the workspace he is already in. Creating an
    // organization is a property of holding an account, not of standing in
    // somebody else's organization.
    requireSession.mockResolvedValue({ id: USER_JORDAN, email: "jordan@example.com" });

    const result = await createOrganizationAction({ name: "Jordan's Group", requestKey: key() });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const memberships = await dataSource.organizations.listForUser(USER_JORDAN);
    const created = memberships.find(
      (entry) => entry.organization.id === result.data.organizationId,
    );
    expect(created?.role).toEqual("owner");
  });
});

describe("names and slugs", () => {
  it("gives two organizations of the same name distinct slugs", async () => {
    const { createOrganizationAction } = await import("@/app/actions/organization");

    const first = await createOrganizationAction({ name: "Bond", requestKey: key() });
    const second = await createOrganizationAction({ name: "Bond", requestKey: key() });
    if (!first.ok || !second.ok) throw new Error("both should succeed");

    const all = await dataSource.organizations.listForUser(USER_DANIEL);
    const slugs = all
      .filter((entry) =>
        [first.data.organizationId, second.data.organizationId].includes(
          entry.organization.id,
        ),
      )
      .map((entry) => entry.organization.slug);

    expect(new Set(slugs).size).toEqual(2);
  });

  it("refuses a blank name and writes nothing", async () => {
    const { createOrganizationAction } = await import("@/app/actions/organization");

    const before = await dataSource.organizations.listForUser(USER_DANIEL);
    const result = await createOrganizationAction({ name: "   ", requestKey: key() });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors?.name).toBeDefined();
    expect(await dataSource.organizations.listForUser(USER_DANIEL)).toHaveLength(
      before.length,
    );
  });
});
