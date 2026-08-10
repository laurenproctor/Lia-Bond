import { beforeEach, describe, expect, it } from "vitest";
import { freshDataSource, harbor, ORG_HARBOR, ORG_USHG, ushg } from "./helpers/scope";
import type { LiaDataSource } from "@/lib/data/types";
import { USER_DANIEL, USER_SOFIA } from "@/lib/seed/dataset";

/**
 * Cross-tenant isolation.
 *
 * The completion criterion for this workflow is that no organization can reach
 * another's data through normal application paths. Every repository that
 * returns rows is checked here, and every one is asked for a specific row it
 * must not be allowed to see.
 */

let data: LiaDataSource;

beforeEach(() => {
  data = freshDataSource();
});

describe("list operations never cross the tenant boundary", () => {
  it("returns only this organization's mentions", async () => {
    const mine = await data.mentions.list(ushg.admin());
    const theirs = await data.mentions.list(harbor.owner());

    expect(mine.length).toBeGreaterThan(0);
    expect(theirs.length).toBeGreaterThan(0);
    expect(mine.every((row) => row.organizationId === ORG_USHG)).toBe(true);
    expect(theirs.every((row) => row.organizationId === ORG_HARBOR)).toBe(true);

    const overlap = mine.filter((row) => theirs.some((other) => other.id === row.id));
    expect(overlap).toEqual([]);
  });

  it("scopes every other repository the same way", async () => {
    const scope = ushg.admin();

    const [locations, connections, profiles, drafts, escalations, rules, events] =
      await Promise.all([
        data.locations.list(scope),
        data.platformConnections.list(scope),
        data.platformProfiles.list(scope),
        data.responseDrafts.list(scope),
        data.escalations.list(scope),
        data.automationRules.list(scope),
        data.auditEvents.list(scope),
      ]);

    for (const rows of [
      locations,
      connections,
      profiles,
      drafts,
      escalations,
      rules,
      events,
    ]) {
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.organizationId === ORG_USHG)).toBe(true);
    }
  });
});

describe("direct lookups refuse foreign ids", () => {
  it("will not fetch another organization's mention by id", async () => {
    const [theirMention] = await data.mentions.list(harbor.owner());
    expect(theirMention).toBeDefined();

    const leaked = await data.mentions.get(ushg.admin(), theirMention!.id);
    expect(leaked).toBeNull();
  });

  it("will not fetch another organization's mention detail", async () => {
    const [theirMention] = await data.mentions.list(harbor.owner());
    const leaked = await data.mentions.getDetail(ushg.admin(), theirMention!.id);
    expect(leaked).toBeNull();
  });

  it("will not fetch another organization's escalation, draft, rule, or location", async () => {
    const scope = harbor.owner();
    const [escalation] = await data.escalations.list(scope);
    const [draft] = await data.responseDrafts.list(scope);
    const [rule] = await data.automationRules.list(scope);
    const [location] = await data.locations.list(scope);

    const mine = ushg.admin();
    expect(await data.escalations.get(mine, escalation!.id)).toBeNull();
    expect(await data.responseDrafts.get(mine, draft!.id)).toBeNull();
    expect(await data.automationRules.get(mine, rule!.id)).toBeNull();
    expect(await data.locations.get(mine, location!.id)).toBeNull();
  });
});

describe("mutations refuse foreign ids", () => {
  it("will not change the status of another organization's mention", async () => {
    const [theirMention] = await data.mentions.list(harbor.owner());

    await expect(
      data.mentions.updateStatus(ushg.admin(), theirMention!.id, "dismissed"),
    ).rejects.toThrow(/not found/i);

    // And the record is untouched.
    const unchanged = await data.mentions.get(harbor.owner(), theirMention!.id);
    expect(unchanged?.status).toBe(theirMention!.status);
  });

  it("will not assign another organization's escalation", async () => {
    const [theirEscalation] = await data.escalations.list(harbor.owner());

    await expect(
      data.escalations.assign(ushg.admin(), theirEscalation!.id, null),
    ).rejects.toThrow(/not found/i);
  });

  it("will not enable another organization's rule", async () => {
    const [theirRule] = await data.automationRules.list(harbor.owner());

    await expect(
      data.automationRules.setEnabled(ushg.admin(), theirRule!.id, false),
    ).rejects.toThrow(/not found/i);
  });

  it("will not update, archive, or record a simulation on another organization's rule", async () => {
    const [theirRule] = await data.automationRules.list(harbor.owner());

    await expect(
      data.automationRules.update(
        ushg.admin(),
        theirRule!.id,
        {
          name: "Hijacked",
          description: null,
          priority: 100,
          conditions: [],
          actions: [],
        },
        theirRule!.revision,
      ),
    ).rejects.toThrow(/not found/i);

    await expect(
      data.automationRules.archive(ushg.admin(), theirRule!.id),
    ).rejects.toThrow(/not found/i);

    await expect(
      data.automationRules.recordSimulation(ushg.admin(), theirRule!.id, theirRule!.revision),
    ).rejects.toThrow(/not found/i);
  });

  it("refuses an assignee who is not a member of the organization", async () => {
    const [escalation] = await data.escalations.list(ushg.admin());

    // Sofia belongs only to Harbor & Vine.
    await expect(
      data.escalations.assign(ushg.admin(), escalation!.id, USER_SOFIA),
    ).rejects.toThrow(/not an active member/i);
  });
});

describe("multi-organization membership", () => {
  it("lists both organizations for a user who belongs to both", async () => {
    const organizations = await data.organizations.listForUser(USER_DANIEL);
    const ids = organizations.map((entry) => entry.organization.id);

    expect(ids).toContain(ORG_USHG);
    expect(ids).toContain(ORG_HARBOR);
  });

  it("carries a different role in each organization", async () => {
    const organizations = await data.organizations.listForUser(USER_DANIEL);
    const roles = new Map(
      organizations.map((entry) => [entry.organization.id, entry.role]),
    );

    expect(roles.get(ORG_USHG)).toBe("owner");
    expect(roles.get(ORG_HARBOR)).toBe("viewer");
  });

  it("lists only the organizations a user actually belongs to", async () => {
    const organizations = await data.organizations.listForUser(USER_SOFIA);
    expect(organizations).toHaveLength(1);
    expect(organizations[0]?.organization.id).toBe(ORG_HARBOR);
  });

  it("returns no membership for an unknown organization", async () => {
    const membership = await data.memberships.getActiveMembership(
      ORG_HARBOR,
      // A Union Square user with no Harbor membership.
      ushg.comms().userId,
    );
    expect(membership).toBeNull();
  });
});
