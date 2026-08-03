import "server-only";

import type {
  AuthorizationCallbackInput,
  AuthorizationRequest,
  ConnectionHealth,
  CredentialSession,
  ExternalAccount,
  ExternalProfile,
  ExternalReview,
  ExternalReviewBatch,
  PlatformConnector,
  PlatformCredentials,
} from "@/integrations/connector";
import { GOOGLE_CONNECTOR_CAPABILITIES } from "@/integrations/google-business-profile/connector";
import { GOOGLE_REQUIRED_SCOPES } from "@/integrations/google-business-profile/scopes";
import { appOrigin } from "@/lib/env";

/**
 * A Google connector that never touches the network.
 *
 * Exists so the OAuth flow, the mapping screen, and the disconnect path can be
 * exercised end to end without a Google Cloud project — including by anyone
 * picking this repository up for the first time.
 *
 * Three properties make it safe rather than merely convenient:
 *
 * - It is **isolated**. Nothing outside this file knows it exists except the
 *   factory in `index.ts`, and no UI code branches on real-versus-mock.
 * - It is **deterministic**. The same accounts, locations, and timings every
 *   run, so a test asserting on a location list is asserting on a contract.
 * - It is **refused in production**. `resolveGoogleIntegrationMode()` throws
 *   when `NODE_ENV=production`, so this module can never be the thing serving a
 *   customer.
 *
 * The fixture data is deliberately awkward: two accounts rather than one, a
 * location whose name nearly matches a seeded Lia location, an unverified
 * location, and one with no address. Tidy fixtures hide exactly the cases the
 * mapping screen exists to handle.
 */

const MOCK_ACCOUNTS: ExternalAccount[] = [
  {
    externalAccountId: "accounts/1122334455",
    name: "Union Square Hospitality Group",
    accountType: "LOCATION_GROUP",
    role: "PRIMARY_OWNER",
    verificationState: "VERIFIED",
    organizationInfo: { registeredDomain: "example-ushg.com" },
  },
  {
    externalAccountId: "accounts/6677889900",
    name: "USHG restaurant partners",
    accountType: "USER_GROUP",
    role: "MANAGER",
    verificationState: "VERIFIED",
  },
];

const MOCK_PROFILES: Record<string, ExternalProfile[]> = {
  "accounts/1122334455": [
    {
      externalProfileId: "locations/1001",
      externalAccountId: "accounts/1122334455",
      displayName: "Maison Laurent SoHo",
      title: "Maison Laurent SoHo",
      storeCode: "ML-SOHO",
      websiteUrl: "https://example.com/soho",
      phoneNumber: "+1 212-555-0118",
      address: {
        addressLine1: "118 Prince Street",
        city: "New York",
        region: "NY",
        postalCode: "10012",
        countryCode: "US",
      },
      verificationState: "VERIFIED",
      profileUrl: "https://maps.google.com/?cid=1001",
      metadata: { placeId: "ChIJmock1001", openStatus: "OPEN" },
    },
    {
      externalProfileId: "locations/1002",
      externalAccountId: "accounts/1122334455",
      displayName: "Maison Laurent West Village",
      title: "Maison Laurent West Village",
      storeCode: "ML-WV",
      phoneNumber: "+1 212-555-0042",
      address: {
        addressLine1: "42 Bedford Street",
        city: "New York",
        region: "NY",
        postalCode: "10014",
        countryCode: "US",
      },
      verificationState: "VERIFIED",
      profileUrl: "https://maps.google.com/?cid=1002",
      metadata: { placeId: "ChIJmock1002", openStatus: "OPEN" },
    },
    {
      // Close to a seeded Lia location but not identical — this is the case
      // that must never auto-match without someone confirming it.
      externalProfileId: "locations/1005",
      externalAccountId: "accounts/1122334455",
      displayName: "Maison Laurent — Brooklyn Hts.",
      title: "Maison Laurent — Brooklyn Hts.",
      address: {
        addressLine1: "76 Montague St",
        city: "Brooklyn",
        region: "NY",
        postalCode: "11201",
        countryCode: "US",
      },
      verificationState: "UNVERIFIED",
      metadata: { openStatus: "OPEN" },
    },
  ],
  "accounts/6677889900": [
    {
      // No address at all. The mapping screen must still let a person decide.
      externalProfileId: "locations/2001",
      externalAccountId: "accounts/6677889900",
      displayName: "Maison Laurent catering",
      title: "Maison Laurent catering",
      verificationState: "UNVERIFIED",
      metadata: { openStatus: "CLOSED_TEMPORARILY" },
    },
  ],
};

/**
 * Reviews for the mapped mock locations.
 *
 * Awkward on purpose, like the location fixtures above: a rating-only review
 * with no words, an anonymous reviewer, and one that already carries an owner
 * reply. Those are the three cases the inbox and a future drafting workflow
 * most need to handle, and a fixture of five tidy four-star reviews would hide
 * all of them.
 *
 * Fictional throughout. No real reviewer, no real photo URL.
 */
const MOCK_REVIEWS: Record<string, ExternalReview[]> = {
  "locations/1001": [
    {
      externalId: "mock-review-0001",
      externalResourceName:
        "accounts/1122334455/locations/1001/reviews/mock-review-0001",
      comment:
        "The tasting menu was the best meal we have had all year. Our server talked us through every course without ever hovering.",
      rating: 5,
      authorName: "Alex R.",
      authorExternalId: null,
      authorAvatarUrl: null,
      authorIsAnonymous: false,
      publishedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      sourceUpdatedAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
      ownerReply: null,
      sourceUrl: null,
      metadata: { googleLocationParent: "accounts/1122334455/locations/1001" },
    },
    {
      // Rating only. No comment is not an error and not an empty string.
      externalId: "mock-review-0002",
      externalResourceName:
        "accounts/1122334455/locations/1001/reviews/mock-review-0002",
      comment: null,
      rating: 3,
      authorName: "Sam T.",
      authorExternalId: null,
      authorAvatarUrl: null,
      authorIsAnonymous: false,
      publishedAt: new Date(Date.now() - 6 * 24 * 60 * 60 * 1000).toISOString(),
      sourceUpdatedAt: null,
      ownerReply: null,
      sourceUrl: null,
      metadata: { googleLocationParent: "accounts/1122334455/locations/1001" },
    },
    {
      // Anonymous, and already answered by the owner. A drafting workflow must
      // see both: nobody to address by name, and a reply that already exists.
      externalId: "mock-review-0003",
      externalResourceName:
        "accounts/1122334455/locations/1001/reviews/mock-review-0003",
      comment: "Waited forty minutes past our reservation time on a Tuesday.",
      rating: 2,
      authorName: null,
      authorExternalId: null,
      authorAvatarUrl: null,
      authorIsAnonymous: true,
      publishedAt: new Date(Date.now() - 9 * 24 * 60 * 60 * 1000).toISOString(),
      sourceUpdatedAt: new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString(),
      ownerReply: {
        comment:
          "We're sorry about the wait — we've added staff to Tuesday service since.",
        updatedAt: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString(),
      },
      sourceUrl: null,
      metadata: { googleLocationParent: "accounts/1122334455/locations/1001" },
    },
  ],
  "locations/1002": [
    {
      externalId: "mock-review-0004",
      externalResourceName:
        "accounts/1122334455/locations/1002/reviews/mock-review-0004",
      comment: "Lovely room, tiny portions for the price.",
      rating: 3,
      authorName: "Priya N.",
      authorExternalId: null,
      authorAvatarUrl: null,
      authorIsAnonymous: false,
      publishedAt: new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString(),
      sourceUpdatedAt: null,
      ownerReply: null,
      sourceUrl: null,
      metadata: { googleLocationParent: "accounts/1122334455/locations/1002" },
    },
  ],
};

const HOUR_MS = 60 * 60 * 1000;

function mockCredentials(withRefreshToken: boolean): PlatformCredentials {
  return {
    accessToken: "mock-access-token",
    refreshToken: withRefreshToken ? "mock-refresh-token" : null,
    expiresAt: new Date(Date.now() + HOUR_MS).toISOString(),
    scopes: [...GOOGLE_REQUIRED_SCOPES],
    tokenType: "Bearer",
  };
}

/**
 * The mock's stand-in for Google's consent screen.
 *
 * Points back at Lia's own callback with a fabricated code, so clicking
 * "Connect" in development walks the identical route handler, state validation,
 * and persistence path a real grant would. Only the network call is missing.
 */
export function createMockGoogleConnector(): PlatformConnector {
  return {
    platform: "google_business_profile",

    capabilities() {
      return GOOGLE_CONNECTOR_CAPABILITIES;
    },

    async getAuthorizationUrl(input: AuthorizationRequest): Promise<string> {
      const url = new URL(
        "/api/integrations/google-business-profile/callback",
        appOrigin(),
      );
      url.searchParams.set("code", "mock-authorization-code");
      url.searchParams.set("state", input.state);
      url.searchParams.set("mock", "1");
      return url.toString();
    },

    async exchangeAuthorizationCode(
      input: AuthorizationCallbackInput,
    ): Promise<PlatformCredentials> {
      // Mirrors Google's re-consent behaviour so the "preserve the existing
      // refresh token" path is reachable in development rather than only in a
      // unit test: a code marked as a reconnect comes back without one.
      return mockCredentials(!input.code.includes("reauth"));
    },

    async refreshCredentials(
      credentials: PlatformCredentials,
    ): Promise<PlatformCredentials> {
      return {
        ...mockCredentials(credentials.refreshToken !== null),
        accessToken: "mock-access-token-refreshed",
      };
    },

    async revokeCredentials(): Promise<void> {
      // Deterministic success. A mock that sometimes failed would make the
      // "revocation uncertain" state untestable rather than more realistic.
    },

    async testConnection(): Promise<ConnectionHealth> {
      return {
        status: "healthy",
        checkedAt: new Date().toISOString(),
        errorCode: null,
        message: null,
      };
    },

    async listExternalAccounts(): Promise<ExternalAccount[]> {
      return MOCK_ACCOUNTS.map((account) => ({ ...account }));
    },

    async listExternalProfiles(
      _session: CredentialSession,
      externalAccountId: string,
    ): Promise<ExternalProfile[]> {
      return (MOCK_PROFILES[externalAccountId] ?? []).map((profile) => ({
        ...profile,
      }));
    },

    async listExternalReviews(
      _session: CredentialSession,
      _externalAccountId: string,
      externalProfileId: string,
    ): Promise<ExternalReviewBatch> {
      const reviews = (MOCK_REVIEWS[externalProfileId] ?? []).map((review) => ({
        ...review,
      }));

      return {
        reviews,
        totalReviewCount: reviews.length,
        // One page. The mock is not the place to exercise pagination — that is
        // tested against a stubbed `fetch` where the page tokens are the thing
        // under test, rather than being simulated by a fixture that cannot get
        // Google's ordering wrong.
        pagesFetched: 1,
        malformedCount: 0,
      };
    },
  };
}

/** Exported for tests that assert against the fixture rather than duplicating it. */
export const MOCK_GOOGLE_FIXTURES = {
  accounts: MOCK_ACCOUNTS,
  profiles: MOCK_PROFILES,
  reviews: MOCK_REVIEWS,
} as const;
