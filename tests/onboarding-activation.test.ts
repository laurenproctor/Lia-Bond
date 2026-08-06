import { beforeEach, describe, expect, it } from "vitest";
import { freshDataSource, ushg } from "./helpers/scope";
import { resolveActivationState } from "@/lib/onboarding/activation";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import { NO_CAPABILITIES } from "@/domain";
import { USER_DANIEL } from "@/lib/seed/dataset";

/**
 * The overview's activation banner.
 *
 * The property under test is that it **disappears**. A permanent
 * getting-started panel is the failure mode: the overview is the product, and a
 * banner that outlives its own reason turns the main screen into a second
 * wizard. Every branch is a repository read, so it stops rendering the moment
 * the condition behind it stops being true.
 */

let data: LiaDataSource;

beforeEach(() => {
  data = freshDataSource();
});

async function emptyOrganization(): Promise<OrganizationScope> {
  const membership = await data.organizations.provision({
    userId: USER_DANIEL,
    name: "Bramble & Co",
  });
  return {
    organizationId: membership.organization.id,
    userId: USER_DANIEL,
    role: "owner",
  };
}

describe("a workspace with feedback in it", () => {
  it("shows nothing at all", async () => {
    // The seeded tenant has mentions. Whatever setup did or did not do, the
    // product is working and has nothing to apologise for.
    expect(await resolveActivationState(data, ushg.owner())).toBeNull();
  });
});

describe("an empty workspace", () => {
  it("asks for a source when none is connected", async () => {
    const scope = await emptyOrganization();
    expect(await resolveActivationState(data, scope)).toBe("no_source");
  });

  it("explains the emptiness once a source is connected but nothing imported", async () => {
    const scope = await emptyOrganization();

    const connection = await data.platformConnections.upsert(scope, {
      platform: "google_business_profile",
      externalAccountId: "accounts/1",
      externalAccountName: "Bramble",
      status: "connected",
      capabilities: { ...NO_CAPABILITIES, canReadMentions: true },
      tokenExpiresAt: null,
      grantedScopes: [],
      providerMetadata: {},
      connectedByUserId: scope.userId,
      connectedAt: new Date().toISOString(),
    });

    const location = await data.locations.create(scope, {
      name: "Bramble Downtown",
      addressLine1: "1 Main St",
      addressLine2: null,
      city: "Austin",
      region: "TX",
      postalCode: "78701",
      countryCode: "US",
      timezone: "America/Chicago",
      status: "setup",
      managerUserId: null,
    });

    await data.platformProfiles.upsert(scope, {
      platformConnectionId: connection.id,
      locationId: location.id,
      externalProfileId: "locations/1",
      externalProfileName: "Bramble Downtown",
      externalAccountId: "accounts/1",
      profileUrl: null,
      status: "active",
      verificationState: "VERIFIED",
      providerMetadata: {},
      lastConfirmedAt: new Date().toISOString(),
    });

    expect(await resolveActivationState(data, scope)).toBe("no_mentions");

    // …and says an import is running while one actually is.
    const run = await data.platformSyncRuns.start(scope, {
      platformConnectionId: connection.id,
      platformProfileId: (await data.platformProfiles.list(scope))[0]!.id,
      resource: "reviews",
      trigger: "manual",
      actorUserId: scope.userId,
      startedAt: new Date().toISOString(),
    });

    expect(await resolveActivationState(data, scope)).toBe("importing");
    expect(run.status).toBe("running");
  });
});
