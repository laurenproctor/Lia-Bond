import type {
  ExternalAccount,
  ExternalProfile,
  ExternalReview,
  ExternalReviewBatch,
  PlatformConnector,
  PlatformCredentials,
} from "@/integrations/connector";
import { GOOGLE_CONNECTOR_CAPABILITIES } from "@/integrations/google-business-profile/connector";
import { integrationError, type IntegrationErrorCode } from "@/integrations/errors";
import { GOOGLE_BUSINESS_MANAGE_SCOPE } from "@/integrations/google-business-profile/scopes";
import { parseVaultKey, createVault } from "@/lib/crypto/token-vault";
import { __setVaultForTesting } from "@/lib/integrations/credentials";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import { completeGoogleAuthorization } from "@/lib/integrations/google-service";

/**
 * Test scaffolding for the Google integration.
 *
 * Two things are stubbed and nothing else: the connector (so no network) and
 * the credential vault key (so encryption runs for real against a throwaway
 * key). Everything else — repositories, permissions, audit — is the production
 * code path, because the bugs worth catching live in how those fit together.
 */

/**
 * A 32-byte key that exists only for the duration of a test run.
 *
 * Hex rather than base64 so the length is countable by eye: 64 characters is 32
 * bytes. It is not a secret and never encrypts anything real.
 */
export const TEST_VAULT_KEY =
  "00112233445566778899aabbccddeeff00112233445566778899aabbccddeeff";

export function installTestVault(): void {
  __setVaultForTesting(createVault(parseVaultKey(TEST_VAULT_KEY, "test")));
}

export function clearTestVault(): void {
  __setVaultForTesting(null);
}

export const TEST_ACCOUNT: ExternalAccount = {
  externalAccountId: "accounts/1122334455",
  name: "Union Square Hospitality Group",
  accountType: "LOCATION_GROUP",
  role: "PRIMARY_OWNER",
  verificationState: "VERIFIED",
};

export const TEST_SECOND_ACCOUNT: ExternalAccount = {
  externalAccountId: "accounts/6677889900",
  name: "USHG restaurant partners",
  accountType: "USER_GROUP",
};

export function testProfile(
  id: string,
  overrides: Partial<ExternalProfile> = {},
): ExternalProfile {
  return {
    externalProfileId: id,
    externalAccountId: TEST_ACCOUNT.externalAccountId,
    displayName: `Location ${id}`,
    verificationState: "VERIFIED",
    ...overrides,
  };
}

export function testCredentials(
  overrides: Partial<PlatformCredentials> = {},
): PlatformCredentials {
  return {
    accessToken: "test-access-token",
    refreshToken: "test-refresh-token",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    scopes: [GOOGLE_BUSINESS_MANAGE_SCOPE],
    tokenType: "Bearer",
    ...overrides,
  };
}

/** A review fixture with the boring fields already filled in. */
export function testReview(
  externalId: string,
  overrides: Partial<ExternalReview> = {},
): ExternalReview {
  return {
    externalId,
    externalResourceName: `accounts/1122334455/locations/1001/reviews/${externalId}`,
    comment: `Review ${externalId}`,
    rating: 4,
    authorName: "Test Reviewer",
    authorExternalId: null,
    authorAvatarUrl: null,
    authorIsAnonymous: false,
    publishedAt: "2026-07-01T12:00:00.000Z",
    sourceUpdatedAt: "2026-07-01T12:00:00.000Z",
    ownerReply: null,
    sourceUrl: null,
    metadata: {},
    ...overrides,
  };
}

export interface FakeConnectorOptions {
  accounts?: ExternalAccount[];
  profiles?: Record<string, ExternalProfile[]>;
  /** Throw from `revokeCredentials`, to exercise the unconfirmed path. */
  revokeFails?: boolean;
  /** Reviews per external profile id. */
  reviews?: Record<string, ExternalReview[]>;
  /** Google's reported total, when a test needs it to differ from the array. */
  totalReviewCount?: number | null;
  /** Items the connector could not normalise, to exercise partial success. */
  malformedCount?: number;
  /** Make `listExternalReviews` throw this normalised code instead. */
  reviewsFailWith?: IntegrationErrorCode;
}

export interface FakeConnector extends PlatformConnector {
  revokeCalls: number;
  /** How many times a sync asked for reviews. Proves the lock and the retries. */
  listReviewCalls: number;
}

/**
 * A connector that returns fixtures.
 *
 * Distinct from the shipped mock connector: this one is configurable per test,
 * where the shipped one is deliberately fixed so development behaviour is
 * reproducible.
 */
export function fakeGoogleConnector(
  options: FakeConnectorOptions = {},
): FakeConnector {
  const accounts = options.accounts ?? [TEST_ACCOUNT];
  const profiles = options.profiles ?? {};
  const reviews = options.reviews ?? {};

  const connector: FakeConnector = {
    platform: "google_business_profile",
    revokeCalls: 0,
    listReviewCalls: 0,
    capabilities: () => GOOGLE_CONNECTOR_CAPABILITIES,
    async getAuthorizationUrl() {
      return "https://accounts.google.com/o/oauth2/v2/auth?stub=1";
    },
    async exchangeAuthorizationCode() {
      return testCredentials();
    },
    async refreshCredentials(credentials) {
      return { ...credentials, accessToken: "refreshed-access-token" };
    },
    async revokeCredentials() {
      connector.revokeCalls += 1;
      if (options.revokeFails) throw new Error("google said no");
    },
    async testConnection() {
      return {
        status: "healthy",
        checkedAt: new Date().toISOString(),
        errorCode: null,
        message: null,
      };
    },
    async listExternalAccounts() {
      return accounts.map((account) => ({ ...account }));
    },
    async listExternalProfiles(_session, externalAccountId) {
      return (profiles[externalAccountId] ?? []).map((profile) => ({ ...profile }));
    },

    async listExternalReviews(
      _session,
      _externalAccountId,
      externalProfileId,
    ): Promise<ExternalReviewBatch> {
      connector.listReviewCalls += 1;

      if (options.reviewsFailWith) throw integrationError(options.reviewsFailWith);

      const page = (reviews[externalProfileId] ?? []).map((review) => ({ ...review }));

      return {
        reviews: page,
        totalReviewCount:
          options.totalReviewCount === undefined
            ? page.length
            : options.totalReviewCount,
        pagesFetched: 1,
        malformedCount: options.malformedCount ?? 0,
      };
    },
  };

  return connector;
}

/**
 * The connector the mocked registry hands out.
 *
 * Mocking at the registry rather than at `fetch` is deliberate: these suites
 * are about what Lia does with what Google said, not about how it talks to
 * Google — that is `tests/google-connector.test.ts`.
 *
 * The holder lives on `globalThis` rather than in a module binding, and that is
 * not incidental. A `vi.mock` factory is hoisted above every import, so it
 * cannot `await import` this file: this file reaches `google-service`, which
 * imports the very module being mocked, and the resolution deadlocks. A global
 * is the one channel a hoisted factory can read without importing anything.
 */
const HOLDER = Symbol.for("lia.tests.google-connector");

interface ConnectorHolder {
  [HOLDER]?: PlatformConnector;
}

export function setFakeConnector(connector: PlatformConnector): void {
  (globalThis as ConnectorHolder)[HOLDER] = connector;
}

export function getFakeConnector(): PlatformConnector {
  const existing = (globalThis as ConnectorHolder)[HOLDER];
  if (existing) return existing;

  const fallback = fakeGoogleConnector();
  (globalThis as ConnectorHolder)[HOLDER] = fallback;
  return fallback;
}

/** Establish a connected Google integration, through the real service path. */
export async function connectGoogle(
  dataSource: LiaDataSource,
  scope: OrganizationScope,
  options: {
    account?: ExternalAccount;
    credentials?: PlatformCredentials;
    reauthorization?: boolean;
  } = {},
) {
  return completeGoogleAuthorization({
    dataSource,
    scope,
    credentials: options.credentials ?? testCredentials(),
    account: options.account ?? TEST_ACCOUNT,
    userId: scope.userId,
    reauthorization: options.reauthorization ?? false,
  });
}
