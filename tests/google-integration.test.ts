import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import { loadCredentials } from "@/lib/integrations/credentials";
import { saveGoogleLocationMappings } from "@/lib/integrations/google-mapping";
import {
  buildCandidates,
  checkGoogleConnectionHealth,
  disconnectGoogle,
  getGoogleConnection,
  listGoogleBusinessLocations,
} from "@/lib/integrations/google-service";
import { LOC_BROOKLYN, LOC_HUDSON } from "@/lib/seed/dataset";
import {
  clearTestVault,
  connectGoogle,
  fakeGoogleConnector,
  installTestVault,
  setFakeConnector,
  TEST_ACCOUNT,
  TEST_SECOND_ACCOUNT,
  testCredentials,
  testProfile,
} from "./helpers/google";
import { freshDataSource, harbor, ushg } from "./helpers/scope";

/**
 * Hand the service layer a fake connector.
 *
 * The factory reads the holder off `globalThis` rather than importing the test
 * helper. `vi.mock` is hoisted above every import, and importing the helper
 * from here would pull in `google-service`, which imports this very module —
 * the resolution deadlocks rather than failing, which is a bad afternoon.
 */
vi.mock("@/integrations/registry", () => {
  const read = () =>
    (globalThis as Record<symbol, unknown>)[
      Symbol.for("lia.tests.google-connector")
    ] as never;

  return {
    getConnector: read,
    getGoogleConnector: read,
    isGoogleConnectorAvailable: () => true,
  };
});

/**
 * The Google integration, end to end through the service layer.
 *
 * Only the connector is faked. Repositories, encryption, permissions, and audit
 * are the production code, because what these tests are for is how those fit
 * together — a mapping that persists but skips its audit event, or credentials
 * that survive a disconnect, are exactly the bugs a unit test of any one piece
 * would miss.
 */

let dataSource: LiaDataSource;
let scope: OrganizationScope;

/**
 * The seeded USHG organization already has a Google connection with four mapped
 * profiles, and these tests deliberately run against that rather than a blank
 * tenant — reconnecting an organization that already has mappings is the normal
 * case, not an edge one.
 *
 * So the fixtures use ids and target locations the seed does not: `locations/7*`
 * for the Google side, and the two seeded restaurants with no Google profile
 * (Brooklyn Heights and Hudson Yards) for the Lia side. Assertions filter to
 * these ids rather than counting rows, so a seeded profile cannot make a test
 * pass or fail for the wrong reason.
 */
const NEW_BROOKLYN = "locations/7001";
const NEW_CATERING = "locations/7002";
const OTHER_ACCOUNT_LOCATION = "locations/7003";

const TEST_EXTERNAL_IDS = new Set([
  NEW_BROOKLYN,
  NEW_CATERING,
  OTHER_ACCOUNT_LOCATION,
]);

const PROFILES = {
  [TEST_ACCOUNT.externalAccountId]: [
    testProfile(NEW_BROOKLYN, {
      displayName: "Maison Laurent Brooklyn Heights",
      address: {
        addressLine1: "76 Montague St",
        city: "Brooklyn",
        region: "NY",
        postalCode: "11201",
        countryCode: "US",
      },
    }),
    testProfile(NEW_CATERING, {
      displayName: "Maison Laurent catering",
      verificationState: "UNVERIFIED",
    }),
  ],
  [TEST_SECOND_ACCOUNT.externalAccountId]: [
    testProfile(OTHER_ACCOUNT_LOCATION, {
      externalAccountId: TEST_SECOND_ACCOUNT.externalAccountId,
      displayName: "Maison Laurent events",
    }),
  ],
};

beforeEach(() => {
  installTestVault();
  dataSource = freshDataSource();
  scope = ushg.admin();
  setFakeConnector(
    fakeGoogleConnector({
      accounts: [TEST_ACCOUNT, TEST_SECOND_ACCOUNT],
      profiles: PROFILES,
    }),
  );
});

afterEach(() => {
  clearTestVault();
});

function context() {
  return { dataSource, scope };
}

async function connect(overrides = {}) {
  return connectGoogle(dataSource, scope, overrides);
}

/** Only the profiles these tests created, never the four the seed ships. */
async function newProfiles(connectionId: string) {
  const all = await dataSource.platformProfiles.listForConnection(
    scope,
    connectionId,
  );
  return all.filter((profile) => TEST_EXTERNAL_IDS.has(profile.externalProfileId));
}

/* -------------------------------------------------------------------------- */
/* Connection                                                                  */
/* -------------------------------------------------------------------------- */

describe("completing an authorization", () => {
  it("records the account, scopes, and attribution", async () => {
    const { connection } = await connect();

    expect(connection.status).toBe("connected");
    expect(connection.externalAccountId).toBe(TEST_ACCOUNT.externalAccountId);
    expect(connection.externalAccountName).toBe(TEST_ACCOUNT.name);
    expect(connection.grantedScopes).toHaveLength(1);
    expect(connection.connectedByUserId).toBe(scope.userId);
    expect(connection.connectedAt).not.toBeNull();
  });

  it("declares reading but never publishing, however successful the handshake was", async () => {
    // Workflow 03 moved this line rather than erasing it. Reviews are genuinely
    // imported now, so claiming otherwise would be the dishonest direction. But
    // Lia still posts nothing, and still learns about a new review only when a
    // sync runs — so publishing and webhooks stay false, and a capability set
    // that drifted would drive the UI to offer a publish button that does not
    // work.
    const { connection } = await connect();

    expect(connection.capabilities.canReadMentions).toBe(true);
    expect(connection.capabilities.canReadFullText).toBe(true);
    expect(connection.capabilities.canPublishResponses).toBe(false);
    expect(connection.capabilities.canEditResponses).toBe(false);
    expect(connection.capabilities.canDeleteResponses).toBe(false);
    expect(connection.capabilities.supportsWebhooks).toBe(false);
    expect(connection.capabilities.requiresApproval).toBe(true);
  });

  it("stores credentials encrypted, never in the connection row", async () => {
    const { connection } = await connect();

    const record = await dataSource.platformCredentials.load(scope, connection.id);
    expect(record?.accessTokenSealed).toMatch(/^v1\.test\./);
    expect(record?.accessTokenSealed).not.toContain("test-access-token");
    expect(record?.refreshTokenSealed).not.toContain("test-refresh-token");

    // The connection DTO is what reaches a client component.
    expect(JSON.stringify(connection)).not.toContain("test-access-token");
    expect(JSON.stringify(connection)).not.toContain("test-refresh-token");
  });

  it("round-trips the credentials through the vault", async () => {
    const { connection } = await connect();
    const loaded = await loadCredentials(dataSource, scope, connection.id);

    expect(loaded?.credentials.accessToken).toBe("test-access-token");
    expect(loaded?.credentials.refreshToken).toBe("test-refresh-token");
  });

  it("updates the existing connection rather than creating a second", async () => {
    const first = await connect();
    const second = await connect({ reauthorization: true });

    expect(second.connection.id).toBe(first.connection.id);
    const all = await dataSource.platformConnections.list(scope);
    expect(
      all.filter((row) => row.platform === "google_business_profile"),
    ).toHaveLength(1);
  });

  it("preserves the stored refresh token when Google does not send one", async () => {
    // Google withholds it on silent re-consent. Writing the response verbatim
    // would replace a working token with null, and the connection would die
    // quietly hours later.
    const { connection } = await connect();

    const result = await connect({
      reauthorization: true,
      credentials: testCredentials({
        accessToken: "second-access-token",
        refreshToken: null,
      }),
    });

    expect(result.preservedRefreshToken).toBe(true);

    const loaded = await loadCredentials(dataSource, scope, connection.id);
    expect(loaded?.credentials.refreshToken).toBe("test-refresh-token");
    expect(loaded?.credentials.accessToken).toBe("second-access-token");
  });

  it("adopts a new refresh token when Google does send one", async () => {
    const { connection } = await connect();

    const result = await connect({
      reauthorization: true,
      credentials: testCredentials({ refreshToken: "rotated-refresh-token" }),
    });

    expect(result.preservedRefreshToken).toBe(false);
    const loaded = await loadCredentials(dataSource, scope, connection.id);
    expect(loaded?.credentials.refreshToken).toBe("rotated-refresh-token");
  });

  it("writes audit events with no credential material", async () => {
    const { connection } = await connect();

    const events = await dataSource.auditEvents.list(scope, {
      entityType: "platform_connection",
      entityId: connection.id,
    });
    const types = events.map((event) => event.eventType);

    expect(types).toContain("integration.oauth_completed");
    expect(types).toContain("integration.connected");

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("test-access-token");
    expect(serialized).not.toContain("test-refresh-token");
  });

  it("records reauthorization distinctly from a first connection", async () => {
    await connect();
    const { connection } = await connect({ reauthorization: true });

    const types = (
      await dataSource.auditEvents.list(scope, {
        entityType: "platform_connection",
        entityId: connection.id,
      })
    ).map((event) => event.eventType);

    expect(types).toContain("integration.reauthorized");
  });

  it("keeps each organization's connection separate", async () => {
    await connect();
    const other = harbor.owner();
    const otherDataSourceConnection = await getGoogleConnection({
      dataSource,
      scope: other,
    });

    // Harbor has its own seeded Google connection; it must not be USHG's.
    expect(otherDataSourceConnection?.organizationId).toBe(other.organizationId);
    expect(otherDataSourceConnection?.connectedByUserId).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Candidates                                                                  */
/* -------------------------------------------------------------------------- */

describe("location candidates", () => {
  it("marks unmapped, mapped, and already-connected profiles", async () => {
    const { connection } = await connect();
    const profiles = await listGoogleBusinessLocations(
      context(),
      connection.id,
      TEST_ACCOUNT.externalAccountId,
    );

    await saveGoogleLocationMappings(context(), {
      connectionId: connection.id,
      externalAccountId: TEST_ACCOUNT.externalAccountId,
      decisions: [
        {
          action: "map_existing",
          externalProfileId: NEW_BROOKLYN,
          locationId: LOC_BROOKLYN,
        },
      ],
    });

    const [existing, locations] = await Promise.all([
      dataSource.platformProfiles.listForConnection(scope, connection.id),
      dataSource.locations.list(scope),
    ]);
    const candidates = buildCandidates(profiles, existing, locations);

    const mapped = candidates.find(
      (candidate) => candidate.profile.externalProfileId === NEW_BROOKLYN,
    );
    const unmapped = candidates.find(
      (candidate) => candidate.profile.externalProfileId === NEW_CATERING,
    );

    expect(mapped?.state).toBe("already_connected");
    expect(mapped?.mappedLocationId).toBe(LOC_BROOKLYN);
    expect(unmapped?.state).toBe("unmapped");
  });

  it("suggests a likely match but never applies it", async () => {
    const { connection } = await connect();
    const profiles = await listGoogleBusinessLocations(
      context(),
      connection.id,
      TEST_ACCOUNT.externalAccountId,
    );
    const locations = await dataSource.locations.list(scope);

    const candidates = buildCandidates(profiles, [], locations);
    const soho = candidates.find(
      (candidate) => candidate.profile.externalProfileId === NEW_BROOKLYN,
    );

    // A proposal with its evidence, and nothing written.
    expect(soho?.suggestion?.locationId).toBe(LOC_BROOKLYN);
    expect(soho?.suggestion?.reasons.length).toBeGreaterThan(0);

    expect(await newProfiles(connection.id)).toHaveLength(0);
  });

  it("offers no suggestion when nothing matches", async () => {
    const { connection } = await connect();
    const profiles = await listGoogleBusinessLocations(
      context(),
      connection.id,
      TEST_ACCOUNT.externalAccountId,
    );
    const locations = await dataSource.locations.list(scope);

    const catering = buildCandidates(profiles, [], locations).find(
      (candidate) => candidate.profile.externalProfileId === NEW_CATERING,
    );

    expect(catering?.suggestion).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Mapping                                                                     */
/* -------------------------------------------------------------------------- */

describe("saving mappings", () => {
  it("maps an existing Lia location", async () => {
    const { connection } = await connect();

    const result = await saveGoogleLocationMappings(context(), {
      connectionId: connection.id,
      externalAccountId: TEST_ACCOUNT.externalAccountId,
      decisions: [
        {
          action: "map_existing",
          externalProfileId: NEW_BROOKLYN,
          locationId: LOC_BROOKLYN,
        },
      ],
    });

    expect(result.failures).toEqual([]);
    expect(result.mappedProfiles).toHaveLength(1);
    expect(result.mappedProfiles[0]?.locationId).toBe(LOC_BROOKLYN);
    expect(result.mappedProfiles[0]?.externalAccountId).toBe(
      TEST_ACCOUNT.externalAccountId,
    );
    expect(result.mappedProfiles[0]?.lastConfirmedAt).not.toBeNull();
  });

  it("creates a new Lia location, as onboarding rather than active", async () => {
    const { connection } = await connect();

    const result = await saveGoogleLocationMappings(context(), {
      connectionId: connection.id,
      externalAccountId: TEST_ACCOUNT.externalAccountId,
      decisions: [
        {
          action: "create_location",
          externalProfileId: NEW_CATERING,
          name: "Maison Laurent catering",
          timezone: "America/New_York",
        },
      ],
    });

    expect(result.createdLocations).toHaveLength(1);
    const created = result.createdLocations[0]!;
    // Marking it active would flatter every roll-up that counts active sites.
    expect(created.status).toBe("setup");
    expect(created.organizationId).toBe(scope.organizationId);
    expect(created.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
  });

  it("fills gaps in a Google address visibly rather than silently", async () => {
    const { connection } = await connect();

    const result = await saveGoogleLocationMappings(context(), {
      connectionId: connection.id,
      externalAccountId: TEST_ACCOUNT.externalAccountId,
      decisions: [
        {
          action: "create_location",
          externalProfileId: NEW_CATERING,
          name: "Catering",
          timezone: "America/New_York",
        },
      ],
    });

    // Obviously wrong to a human reading the locations screen, which an empty
    // string would not be.
    expect(result.createdLocations[0]?.city).toBe("Not provided by Google");
  });

  it("records the mapping, the profile, and the created location in the audit trail", async () => {
    const { connection } = await connect();

    await saveGoogleLocationMappings(context(), {
      connectionId: connection.id,
      externalAccountId: TEST_ACCOUNT.externalAccountId,
      decisions: [
        {
          action: "map_existing",
          externalProfileId: NEW_BROOKLYN,
          locationId: LOC_BROOKLYN,
        },
        {
          action: "create_location",
          externalProfileId: NEW_CATERING,
          name: "Catering",
          timezone: "America/New_York",
        },
      ],
    });

    const types = (await dataSource.auditEvents.list(scope, { limit: 100 })).map(
      (event) => event.eventType,
    );

    expect(types).toContain("integration.profile_connected");
    expect(types).toContain("integration.profile_mapped");
    expect(types).toContain("location.created_from_integration");

    // Counts, not just presence.
    //
    // The create branch no longer writes these out here — it calls
    // `locations.createAndMapFromIntegration`, which writes all three inside
    // the same transaction as the location and the binding, so that a location
    // can never exist without its provenance. The failure that swap invites is
    // the opposite of a missing event: leaving the old `recordAuditEvent` calls
    // in place alongside the new ones, which doubles every row and is invisible
    // to a `toContain` assertion.
    //
    // Two decisions here: one `map_existing` (which still audits from the
    // service) and one `create_location` (which audits from the repository).
    // So exactly one location creation, and exactly two of each profile event.
    const count = (type: string) => types.filter((entry) => entry === type).length;

    expect(count("location.created_from_integration")).toBe(1);
    expect(count("integration.profile_connected")).toBe(2);
    expect(count("integration.profile_mapped")).toBe(2);
  });

  it("skips what the user chose to skip, and records nothing for it", async () => {
    const { connection } = await connect();

    const result = await saveGoogleLocationMappings(context(), {
      connectionId: connection.id,
      externalAccountId: TEST_ACCOUNT.externalAccountId,
      decisions: [
        { action: "skip", externalProfileId: NEW_BROOKLYN },
        { action: "skip", externalProfileId: NEW_CATERING },
      ],
    });

    expect(result.skipped).toHaveLength(2);
    expect(result.mappedProfiles).toEqual([]);
    expect(await newProfiles(connection.id)).toHaveLength(0);
  });

  it("refuses a Google location the connected account does not offer", async () => {
    // The form field is a claim; the live listing is the evidence. This is what
    // stops an arbitrary Google location id being mapped into an organization.
    const { connection } = await connect();

    const result = await saveGoogleLocationMappings(context(), {
      connectionId: connection.id,
      externalAccountId: TEST_ACCOUNT.externalAccountId,
      decisions: [
        {
          action: "map_existing",
          externalProfileId: "locations/9999",
          locationId: LOC_BROOKLYN,
        },
      ],
    });

    expect(result.mappedProfiles).toEqual([]);
    expect(result.failures[0]?.externalProfileId).toBe("locations/9999");
  });

  it("refuses a location that belongs to a different Google account", async () => {
    const { connection } = await connect();

    const result = await saveGoogleLocationMappings(context(), {
      connectionId: connection.id,
      externalAccountId: TEST_ACCOUNT.externalAccountId,
      // Real, but under the other account.
      decisions: [
        {
          action: "map_existing",
          externalProfileId: OTHER_ACCOUNT_LOCATION,
          locationId: LOC_BROOKLYN,
        },
      ],
    });

    expect(result.failures).toHaveLength(1);
  });

  it("refuses a Lia location from another organization", async () => {
    const { connection } = await connect();
    const harborLocations = await dataSource.locations.list(harbor.owner());
    const foreignLocationId = harborLocations[0]!.id;

    const result = await saveGoogleLocationMappings(context(), {
      connectionId: connection.id,
      externalAccountId: TEST_ACCOUNT.externalAccountId,
      decisions: [
        {
          action: "map_existing",
          externalProfileId: NEW_BROOKLYN,
          locationId: foreignLocationId,
        },
      ],
    });

    expect(result.mappedProfiles).toEqual([]);
    expect(result.failures).toHaveLength(1);
  });

  it("refuses a connection belonging to another organization", async () => {
    await connect();
    const harborConnection = await getGoogleConnection({
      dataSource,
      scope: harbor.owner(),
    });

    await expect(
      saveGoogleLocationMappings(context(), {
        connectionId: harborConnection!.id,
        externalAccountId: TEST_ACCOUNT.externalAccountId,
        decisions: [],
      }),
    ).rejects.toThrow();
  });

  it("refuses to map one Lia location to two Google locations", async () => {
    // Two profiles pointing at one restaurant would double-count its mentions.
    const { connection } = await connect();

    const result = await saveGoogleLocationMappings(context(), {
      connectionId: connection.id,
      externalAccountId: TEST_ACCOUNT.externalAccountId,
      decisions: [
        {
          action: "map_existing",
          externalProfileId: NEW_BROOKLYN,
          locationId: LOC_BROOKLYN,
        },
        {
          action: "map_existing",
          externalProfileId: NEW_CATERING,
          locationId: LOC_BROOKLYN,
        },
      ],
    });

    expect(result.mappedProfiles).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.externalProfileId).toBe(NEW_CATERING);
  });

  it("refuses the same Google location twice in one submission", async () => {
    const { connection } = await connect();

    const result = await saveGoogleLocationMappings(context(), {
      connectionId: connection.id,
      externalAccountId: TEST_ACCOUNT.externalAccountId,
      decisions: [
        {
          action: "map_existing",
          externalProfileId: NEW_BROOKLYN,
          locationId: LOC_BROOKLYN,
        },
        {
          action: "map_existing",
          externalProfileId: NEW_BROOKLYN,
          locationId: LOC_HUDSON,
        },
      ],
    });

    expect(result.mappedProfiles).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
  });

  it("keeps the rows that succeeded when one fails", async () => {
    // No transaction: each decision is independent and idempotent instead. A
    // user who mapped one location correctly should keep it.
    const { connection } = await connect();

    const result = await saveGoogleLocationMappings(context(), {
      connectionId: connection.id,
      externalAccountId: TEST_ACCOUNT.externalAccountId,
      decisions: [
        {
          action: "map_existing",
          externalProfileId: NEW_BROOKLYN,
          locationId: LOC_BROOKLYN,
        },
        {
          action: "map_existing",
          externalProfileId: "locations/9999",
          locationId: LOC_HUDSON,
        },
      ],
    });

    expect(result.mappedProfiles).toHaveLength(1);
    expect(result.failures).toHaveLength(1);
    expect(await newProfiles(connection.id)).toHaveLength(1);
  });

  it("converges rather than duplicating when re-run", async () => {
    const { connection } = await connect();
    const decisions = [
      {
        action: "map_existing" as const,
        externalProfileId: NEW_BROOKLYN,
        locationId: LOC_BROOKLYN,
      },
    ];

    await saveGoogleLocationMappings(context(), {
      connectionId: connection.id,
      externalAccountId: TEST_ACCOUNT.externalAccountId,
      decisions,
    });
    await saveGoogleLocationMappings(context(), {
      connectionId: connection.id,
      externalAccountId: TEST_ACCOUNT.externalAccountId,
      decisions,
    });

    expect(await newProfiles(connection.id)).toHaveLength(1);
  });

  it("moves a mapping to a different location when asked", async () => {
    const { connection } = await connect();

    await saveGoogleLocationMappings(context(), {
      connectionId: connection.id,
      externalAccountId: TEST_ACCOUNT.externalAccountId,
      decisions: [
        {
          action: "map_existing",
          externalProfileId: NEW_BROOKLYN,
          locationId: LOC_BROOKLYN,
        },
      ],
    });

    const moved = await saveGoogleLocationMappings(context(), {
      connectionId: connection.id,
      externalAccountId: TEST_ACCOUNT.externalAccountId,
      decisions: [
        {
          action: "map_existing",
          externalProfileId: NEW_BROOKLYN,
          locationId: LOC_HUDSON,
        },
      ],
    });

    expect(moved.failures).toEqual([]);
    expect(moved.mappedProfiles[0]?.locationId).toBe(LOC_HUDSON);
  });

  it("refuses to map onto a disconnected connection", async () => {
    const { connection } = await connect();
    await disconnectGoogle(context());

    await expect(
      saveGoogleLocationMappings(context(), {
        connectionId: connection.id,
        externalAccountId: TEST_ACCOUNT.externalAccountId,
        decisions: [],
      }),
    ).rejects.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Health                                                                      */
/* -------------------------------------------------------------------------- */

describe("health checks", () => {
  it("records a healthy result", async () => {
    const { connection } = await connect();
    const { connection: updated, health } = await checkGoogleConnectionHealth(
      context(),
      connection.id,
    );

    expect(health.status).toBe("healthy");
    expect(updated.lastHealthStatus).toBe("healthy");
    expect(updated.lastHealthCheckAt).not.toBeNull();
    expect(updated.status).toBe("connected");
  });

  it("moves the connection to action required when reauthorization is needed", async () => {
    const { connection } = await connect();

    const failing = fakeGoogleConnector();
    failing.testConnection = async () => ({
      status: "authorization_required",
      checkedAt: new Date().toISOString(),
      errorCode: "authorization_revoked",
      message: "Google access was revoked. Reauthorize to reconnect this account.",
    });
    setFakeConnector(failing);

    const { connection: updated } = await checkGoogleConnectionHealth(
      context(),
      connection.id,
    );

    expect(updated.status).toBe("action_required");
    expect(updated.lastErrorCode).toBe("authorization_revoked");
  });

  it("leaves a rate-limited connection marked connected", async () => {
    // A quota limit is Google's problem and it passes. Telling an operator
    // their integration is broken would send them to re-consent for nothing.
    const { connection } = await connect();

    const limited = fakeGoogleConnector();
    limited.testConnection = async () => ({
      status: "quota_limited",
      checkedAt: new Date().toISOString(),
      errorCode: "quota_exceeded",
      message: "Google is rate-limiting requests from Lia right now.",
    });
    setFakeConnector(limited);

    const { connection: updated } = await checkGoogleConnectionHealth(
      context(),
      connection.id,
    );

    expect(updated.lastHealthStatus).toBe("quota_limited");
    expect(updated.status).toBe("connected");
  });

  it("records a degradation once, not on every poll", async () => {
    const { connection } = await connect();

    const failing = fakeGoogleConnector();
    failing.testConnection = async () => ({
      status: "authorization_required",
      checkedAt: new Date().toISOString(),
      errorCode: "authorization_revoked",
      message: "Reauthorize.",
    });
    setFakeConnector(failing);

    await checkGoogleConnectionHealth(context(), connection.id);
    await checkGoogleConnectionHealth(context(), connection.id);

    const degraded = (
      await dataSource.auditEvents.list(scope, { limit: 100 })
    ).filter((event) => event.eventType === "integration.health_degraded");

    // Emitting one per poll would bury the moment it actually broke.
    expect(degraded).toHaveLength(1);
  });

  it("records every check, degraded or not", async () => {
    const { connection } = await connect();
    await checkGoogleConnectionHealth(context(), connection.id);

    const checks = (await dataSource.auditEvents.list(scope, { limit: 100 })).filter(
      (event) => event.eventType === "integration.health_checked",
    );

    expect(checks).toHaveLength(1);
  });
});

/* -------------------------------------------------------------------------- */
/* Disconnect                                                                  */
/* -------------------------------------------------------------------------- */

describe("disconnect", () => {
  async function connectAndMap() {
    const { connection } = await connect();
    await saveGoogleLocationMappings(context(), {
      connectionId: connection.id,
      externalAccountId: TEST_ACCOUNT.externalAccountId,
      decisions: [
        {
          action: "map_existing",
          externalProfileId: NEW_BROOKLYN,
          locationId: LOC_BROOKLYN,
        },
      ],
    });
    return connection;
  }

  it("clears the stored credentials", async () => {
    const connection = await connectAndMap();
    await disconnectGoogle(context());

    expect(
      await dataSource.platformCredentials.load(scope, connection.id),
    ).toBeNull();
  });

  it("marks the connection disconnected without deleting it", async () => {
    const connection = await connectAndMap();
    const result = await disconnectGoogle(context());

    expect(result.connection.status).toBe("disconnected");
    expect(result.connection.disconnectedAt).not.toBeNull();
    expect(result.connection.grantedScopes).toEqual([]);
    expect(
      await dataSource.platformConnections.get(scope, connection.id),
    ).not.toBeNull();
  });

  it("preserves profile mappings in a disconnected state", async () => {
    // Kept so reconnecting is two clicks rather than a re-mapping exercise.
    const connection = await connectAndMap();
    await disconnectGoogle(context());

    const profiles = await newProfiles(connection.id);

    expect(profiles).toHaveLength(1);
    expect(profiles[0]?.status).toBe("disconnected");
    expect(profiles[0]?.locationId).toBe(LOC_BROOKLYN);
  });

  it("preserves the Lia locations", async () => {
    const before = await dataSource.locations.list(scope);
    await connectAndMap();
    await disconnectGoogle(context());

    expect(await dataSource.locations.list(scope)).toHaveLength(before.length);
  });

  it("preserves the audit history and adds to it", async () => {
    await connectAndMap();
    await disconnectGoogle(context());

    const types = (await dataSource.auditEvents.list(scope, { limit: 100 })).map(
      (event) => event.eventType,
    );

    expect(types).toContain("integration.connected");
    expect(types).toContain("integration.disconnected");
    expect(types).toContain("integration.credentials_revoked");
  });

  it("reports revocation as unconfirmed when Google does not confirm it", async () => {
    // Claiming success would leave a live credential behind a UI saying
    // otherwise, and nobody would go and revoke it in Google.
    await connectAndMap();
    setFakeConnector(fakeGoogleConnector({ revokeFails: true }));

    const result = await disconnectGoogle(context());

    expect(result.remoteRevocationConfirmed).toBe(false);

    const types = (await dataSource.auditEvents.list(scope, { limit: 100 })).map(
      (event) => event.eventType,
    );
    expect(types).toContain("integration.credentials_revocation_failed");
    expect(types).not.toContain("integration.credentials_revoked");
  });

  it("still clears local credentials when remote revocation fails", async () => {
    const connection = await connectAndMap();
    setFakeConnector(fakeGoogleConnector({ revokeFails: true }));

    await disconnectGoogle(context());

    expect(
      await dataSource.platformCredentials.load(scope, connection.id),
    ).toBeNull();
  });

  it("is safe to repeat", async () => {
    await connectAndMap();
    await disconnectGoogle(context());

    const second = await disconnectGoogle(context());
    expect(second.connection.status).toBe("disconnected");
  });

  it("does not ask Google to revoke twice", async () => {
    await connectAndMap();
    const connector = fakeGoogleConnector();
    setFakeConnector(connector);

    await disconnectGoogle(context());
    await disconnectGoogle(context());

    expect(connector.revokeCalls).toBe(1);
  });

  it("reactivates the preserved mappings on reconnection", async () => {
    const connection = await connectAndMap();
    await disconnectGoogle(context());

    await connect({ reauthorization: true });

    const profiles = await newProfiles(connection.id);
    expect(profiles[0]?.status).toBe("active");
    expect(profiles[0]?.locationId).toBe(LOC_BROOKLYN);
  });
});
