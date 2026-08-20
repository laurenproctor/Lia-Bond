import { describe, expect, it } from "vitest";
import type {
  PlatformConnection,
  PlatformConnectionStatus,
  PlatformProfile,
  PlatformProfileStatus,
} from "@/domain";
import { reviewsReadiness } from "@/lib/integrations/reviews-readiness";

const ORG = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-01-01T00:00:00.000Z";

function connection(
  status: PlatformConnectionStatus,
  overrides: Partial<PlatformConnection> = {},
): PlatformConnection {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    organizationId: ORG,
    platform: "google_business_profile",
    externalAccountId: "accounts/1",
    externalAccountName: "Harbor Group",
    status,
    capabilities: {
      canReadMentions: true,
      canReadFullText: true,
      supportsWebhooks: false,
      canPublishResponses: false,
      canEditResponses: false,
      canDeleteResponses: false,
      requiresApproval: false,
      requiresPartnerAccess: false,
      canMatchLocations: true,
      supportsAssistedPosting: false,
    },
    tokenExpiresAt: null,
    lastSyncedAt: null,
    grantedScopes: [],
    providerMetadata: {},
    lastHealthCheckAt: null,
    lastHealthStatus: null,
    lastErrorCode: null,
    lastErrorMessage: null,
    connectedByUserId: null,
    connectedAt: NOW,
    disconnectedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } satisfies PlatformConnection;
}

function profile(
  id: string,
  status: PlatformProfileStatus,
  locationId: string | null,
): PlatformProfile {
  return {
    id,
    organizationId: ORG,
    locationId,
    platformConnectionId: "22222222-2222-4222-8222-222222222222",
    externalProfileId: `locations/${id}`,
    externalProfileName: `Location ${id}`,
    externalAccountId: "accounts/1",
    profileUrl: null,
    status,
    verificationState: null,
    providerMetadata: {},
    lastConfirmedAt: null,
    syncCursor: null,
    lastSyncedAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  } satisfies PlatformProfile;
}

const MAPPED = profile(
  "33333333-3333-4333-8333-333333333333",
  "active",
  "44444444-4444-4444-8444-444444444444",
);

describe("reviewsReadiness", () => {
  it("asks for a connection when there is none", () => {
    const readiness = reviewsReadiness({
      connectorAvailable: true,
      connection: null,
      profiles: [],
    });

    expect(readiness.state).toBe("not_connected");
    expect(readiness.title.toLowerCase()).toContain("no google business profile");
  });

  it("treats a disconnected connection as no connection", () => {
    expect(
      reviewsReadiness({
        connectorAvailable: true,
        connection: connection("disconnected"),
        profiles: [MAPPED],
      }).state,
    ).toBe("not_connected");
  });

  it("blames the server, not the user, when the connector is unconfigured", () => {
    const readiness = reviewsReadiness({
      connectorAvailable: false,
      connection: null,
      profiles: [],
    });

    // The distinction matters: the connect button is hidden in this state, so
    // copy that told somebody to press it would be a dead end.
    expect(readiness.state).toBe("not_configured");
    expect(readiness.description.toLowerCase()).toContain("administrator");
  });

  it("asks for re-consent before it asks for a location mapping", () => {
    expect(
      reviewsReadiness({
        connectorAvailable: true,
        connection: connection("action_required"),
        profiles: [],
      }).state,
    ).toBe("action_required");
  });

  it("never tells somebody to reauthorize a connection that only errored", () => {
    const readiness = reviewsReadiness({
      connectorAvailable: true,
      connection: connection("error", { lastErrorMessage: "Google rate limit" }),
      profiles: [MAPPED],
    });

    expect(readiness.state).toBe("error");
    expect(readiness.description).toContain("Google rate limit");
    expect(readiness.description.toLowerCase()).not.toContain("reauthoriz");
  });

  it("asks for a mapping when a connected location is not bound to a Lia location", () => {
    const readiness = reviewsReadiness({
      connectorAvailable: true,
      connection: connection("connected"),
      profiles: [profile("55555555-5555-4555-8555-555555555555", "active", null)],
    });

    expect(readiness.state).toBe("no_locations");
    expect(readiness.description).toContain("1 location");
  });

  it("ignores disconnected profiles when counting mappings", () => {
    expect(
      reviewsReadiness({
        connectorAvailable: true,
        connection: connection("connected"),
        profiles: [
          profile(
            "66666666-6666-4666-8666-666666666666",
            "disconnected",
            "44444444-4444-4444-8444-444444444444",
          ),
        ],
      }).state,
    ).toBe("no_locations");
  });

  it("asks for a sync once a location is mapped and nothing has imported", () => {
    const readiness = reviewsReadiness({
      connectorAvailable: true,
      connection: connection("connected"),
      profiles: [MAPPED],
    });

    expect(readiness.state).toBe("no_reviews");
    expect(readiness.description.toLowerCase()).toContain("sync");
  });
});
