import "server-only";

import {
  NO_CAPABILITIES,
  type ConnectorCapabilities,
  type JsonObject,
} from "@/domain";
import type {
  AuthorizationCallbackInput,
  AuthorizationRequest,
  ConnectionHealth,
  CredentialSession,
  ExternalAccount,
  ExternalProfile,
  ExternalReviewBatch,
  PlatformConnector,
  PlatformCredentials,
} from "@/integrations/connector";
import { normalizeReviews } from "@/integrations/google-business-profile/reviews";
import { healthStatusFor, IntegrationError, integrationError } from "@/integrations/errors";
import {
  createGoogleClient,
  type GoogleClient,
  type GoogleClientConfig,
} from "@/integrations/google-business-profile/client";
import type {
  GoogleAccount,
  GoogleLocation,
} from "@/integrations/google-business-profile/schemas";
import {
  GOOGLE_REQUIRED_SCOPES,
  hasRequiredScopes,
} from "@/integrations/google-business-profile/scopes";

/**
 * The Google Business Profile connector.
 *
 * Owns two things the HTTP client deliberately does not: when to refresh an
 * access token, and how a Google resource becomes a Lia-shaped record. Both are
 * policy rather than transport, and both need to behave identically whether the
 * caller is the callback route, the mapping screen, or a health check.
 *
 * What this connector does **not** do: publish a reply, edit or delete one, or
 * subscribe to notifications. Reading reviews it does, as of workflow 03. The
 * capability set below states each separately, and the integration screen reads
 * that set rather than assuming a working connection implies working anything.
 */

/** How close to expiry counts as expired. Covers clock skew and request latency. */
const REFRESH_LEEWAY_MS = 120_000;

/**
 * What Lia can honestly do with a Google connection.
 *
 * Reading is now true and stays exactly that narrow. `canReadMentions` and
 * `canReadFullText` are earned: reviews are imported, and Google returns the
 * whole comment rather than a snippet. Every publishing capability remains
 * false, because Lia still posts nothing — a response is prepared in Lia and
 * published by a person. `resolvePublishingMode` reads this pair and now
 * answers "manual", which is the truth rather than an upgrade.
 *
 * `supportsWebhooks` stays false. Google delivers new-review notifications over
 * Pub/Sub and Lia does not subscribe, so review data is as fresh as the last
 * sync and the UI must not imply otherwise.
 */
export const GOOGLE_CONNECTOR_CAPABILITIES: ConnectorCapabilities = {
  ...NO_CAPABILITIES,
  canReadMentions: true,
  canReadFullText: true,
  requiresApproval: true,
};

function nowIso(): string {
  return new Date().toISOString();
}

function expiryFrom(expiresInSeconds: number | undefined): string | null {
  if (expiresInSeconds === undefined) return null;
  return new Date(Date.now() + expiresInSeconds * 1000).toISOString();
}

function parseScopes(scope: string | undefined): string[] {
  if (!scope) return [];
  return scope.split(/\s+/).filter((entry) => entry.length > 0);
}

/* -------------------------------------------------------------------------- */
/* Normalisation                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Only fields Lia has reviewed are carried into provider metadata.
 *
 * `providerMetadata` ends up on a row that UI clients can read, so it is built
 * by naming fields rather than by spreading a provider response. A field Google
 * adds tomorrow does not silently become part of Lia's stored data.
 */
function accountMetadata(account: GoogleAccount): JsonObject {
  const metadata: JsonObject = {};
  if (account.accountNumber) metadata.accountNumber = account.accountNumber;
  if (account.permissionLevel) metadata.permissionLevel = account.permissionLevel;
  if (account.vettedState) metadata.vettedState = account.vettedState;
  if (account.organizationInfo?.registeredDomain) {
    metadata.registeredDomain = account.organizationInfo.registeredDomain;
  }
  return metadata;
}

export function normalizeAccount(account: GoogleAccount): ExternalAccount {
  const organizationInfo = accountMetadata(account);

  return {
    externalAccountId: account.name,
    // Google omits accountName on some personal accounts. Falling back to the
    // resource name keeps the account selectable rather than rendering blank.
    name: account.accountName?.trim() || account.name,
    ...(account.type ? { accountType: account.type } : {}),
    ...(account.role ? { role: account.role } : {}),
    ...(account.verificationState
      ? { verificationState: account.verificationState }
      : {}),
    ...(Object.keys(organizationInfo).length > 0 ? { organizationInfo } : {}),
  };
}

function locationMetadata(location: GoogleLocation): JsonObject {
  const metadata: JsonObject = {};
  if (location.metadata?.placeId) metadata.placeId = location.metadata.placeId;
  if (location.metadata?.mapsUri) metadata.mapsUri = location.metadata.mapsUri;
  if (location.metadata?.newReviewUri) {
    metadata.newReviewUri = location.metadata.newReviewUri;
  }
  if (location.metadata?.hasVoiceOfMerchant !== undefined) {
    metadata.hasVoiceOfMerchant = location.metadata.hasVoiceOfMerchant;
  }
  if (location.openInfo?.status) metadata.openStatus = location.openInfo.status;
  return metadata;
}

export function normalizeLocation(
  location: GoogleLocation,
  externalAccountId: string,
): ExternalProfile {
  const address = location.storefrontAddress;
  const lines = address?.addressLines ?? [];

  const normalizedAddress = {
    ...(lines[0] ? { addressLine1: lines[0] } : {}),
    // Google returns an array of arbitrary length; anything past the first line
    // is joined rather than dropped, because a suite number matters for matching.
    ...(lines.length > 1 ? { addressLine2: lines.slice(1).join(", ") } : {}),
    ...(address?.locality ? { city: address.locality } : {}),
    ...(address?.administrativeArea ? { region: address.administrativeArea } : {}),
    ...(address?.postalCode ? { postalCode: address.postalCode } : {}),
    ...(address?.regionCode ? { countryCode: address.regionCode } : {}),
  };

  const metadata = locationMetadata(location);
  const title = location.title?.trim();

  return {
    externalProfileId: location.name,
    externalAccountId,
    // Never blank: the mapping screen has to render something clickable, and a
    // location with no title is still a location the user must decide about.
    displayName: title || location.storeCode || location.name,
    ...(title ? { title } : {}),
    ...(location.storeCode ? { storeCode: location.storeCode } : {}),
    ...(location.websiteUri ? { websiteUrl: location.websiteUri } : {}),
    ...(location.phoneNumbers?.primaryPhone
      ? { phoneNumber: location.phoneNumbers.primaryPhone }
      : {}),
    ...(Object.keys(normalizedAddress).length > 0
      ? { address: normalizedAddress }
      : {}),
    // Google's Business Information API does not return a verification state on
    // the location resource; `hasVoiceOfMerchant` is the closest signal it gives
    // for "this profile is genuinely yours to manage", so it is surfaced as one
    // rather than inventing a state Google never sent.
    ...(location.metadata?.hasVoiceOfMerchant === true
      ? { verificationState: "VERIFIED" }
      : location.metadata?.hasVoiceOfMerchant === false
        ? { verificationState: "UNVERIFIED" }
        : {}),
    ...(location.metadata?.mapsUri ? { profileUrl: location.metadata.mapsUri } : {}),
    ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
  };
}

/**
 * Drop repeats, keeping the first.
 *
 * Google can return the same location twice when an account belongs to a group
 * that also grants access directly. Two identical checkboxes on the mapping
 * screen is a bug the user cannot resolve, so they are collapsed here.
 */
export function dedupeProfiles(profiles: ExternalProfile[]): ExternalProfile[] {
  const seen = new Set<string>();
  const unique: ExternalProfile[] = [];

  for (const profile of profiles) {
    if (seen.has(profile.externalProfileId)) continue;
    seen.add(profile.externalProfileId);
    unique.push(profile);
  }

  return unique;
}

/* -------------------------------------------------------------------------- */
/* Connector                                                                   */
/* -------------------------------------------------------------------------- */

export function createGoogleBusinessProfileConnector(
  config: GoogleClientConfig,
): PlatformConnector {
  const client: GoogleClient = createGoogleClient(config);

  /**
   * A usable access token, refreshing first if the current one is spent.
   *
   * The refreshed credentials are written back through the session callback
   * before the request is made. Doing it after would mean a failed request
   * discards a perfectly good new token and forces another refresh next time.
   */
  async function accessTokenFor(session: CredentialSession): Promise<string> {
    const { credentials } = session;
    const expiresAt = credentials.expiresAt
      ? Date.parse(credentials.expiresAt)
      : null;
    const stale =
      expiresAt !== null && Number.isFinite(expiresAt)
        ? expiresAt - REFRESH_LEEWAY_MS <= Date.now()
        : false;

    if (!stale) return credentials.accessToken;

    if (!credentials.refreshToken) {
      // No refresh token and a dead access token is terminal: only a person
      // clicking through consent again can fix it.
      throw integrationError("authorization_revoked");
    }

    const refreshed = await refresh(credentials);
    await session.onRefreshed(refreshed);
    session.credentials = refreshed;
    return refreshed.accessToken;
  }

  async function refresh(
    credentials: PlatformCredentials,
  ): Promise<PlatformCredentials> {
    if (!credentials.refreshToken) {
      throw integrationError("authorization_revoked");
    }

    const response = await client.refreshAccessToken(credentials.refreshToken);
    const grantedScopes = parseScopes(response.scope);

    return {
      accessToken: response.access_token,
      // Google does not reissue the refresh token on an ordinary refresh, so
      // the existing one is carried forward. Overwriting it with undefined here
      // would silently break the connection on the next refresh.
      refreshToken: response.refresh_token ?? credentials.refreshToken,
      expiresAt: expiryFrom(response.expires_in),
      // Likewise for scopes: a refresh response often omits them, and an empty
      // list would read as "permissions were withdrawn".
      scopes: grantedScopes.length > 0 ? grantedScopes : credentials.scopes,
      tokenType: response.token_type ?? credentials.tokenType,
    };
  }

  return {
    platform: "google_business_profile",

    capabilities() {
      return GOOGLE_CONNECTOR_CAPABILITIES;
    },

    async getAuthorizationUrl(input: AuthorizationRequest): Promise<string> {
      return client.buildAuthorizationUrl({
        state: input.state,
        scopes: GOOGLE_REQUIRED_SCOPES,
        forceConsent: input.forceConsent,
        ...(input.loginHint ? { loginHint: input.loginHint } : {}),
      });
    },

    async exchangeAuthorizationCode(
      input: AuthorizationCallbackInput,
    ): Promise<PlatformCredentials> {
      const response = await client.exchangeCode(input.code);
      const scopes = parseScopes(response.scope);

      // Checked here rather than at the call site: a grant missing the scope is
      // a credential that cannot do anything, and storing it would produce a
      // connection that looks healthy and fails on every request.
      if (!hasRequiredScopes(scopes)) {
        throw integrationError("insufficient_scope");
      }

      return {
        accessToken: response.access_token,
        // Legitimately absent on re-consent. The callback preserves the stored
        // refresh token when this is null rather than treating it as a failure.
        refreshToken: response.refresh_token ?? null,
        expiresAt: expiryFrom(response.expires_in),
        scopes,
        tokenType: response.token_type ?? "Bearer",
      };
    },

    refreshCredentials: refresh,

    async revokeCredentials(credentials: PlatformCredentials): Promise<void> {
      // Revoking the refresh token invalidates the whole grant including every
      // access token minted from it. Falling back to the access token still
      // helps when no refresh token was ever issued.
      const token = credentials.refreshToken ?? credentials.accessToken;
      await client.revokeToken(token);
    },

    async testConnection(session: CredentialSession): Promise<ConnectionHealth> {
      const checkedAt = nowIso();

      try {
        const token = await accessTokenFor(session);
        // The lightest authenticated call Google offers on this scope. It
        // proves the credential works without pulling a location catalogue.
        await client.listAccounts(token);

        const expiresAt = session.credentials.expiresAt
          ? Date.parse(session.credentials.expiresAt)
          : null;
        const expiringSoon =
          expiresAt !== null &&
          Number.isFinite(expiresAt) &&
          expiresAt - Date.now() < 24 * 60 * 60 * 1000 &&
          session.credentials.refreshToken === null;

        // Only flagged when there is no refresh token: with one, an expiring
        // access token is routine and renews itself without anybody's help.
        if (expiringSoon) {
          return {
            status: "token_expiring",
            checkedAt,
            errorCode: null,
            message:
              "Google access expires soon and cannot be renewed automatically. Reauthorize to keep this connection working.",
          };
        }

        if (!hasRequiredScopes(session.credentials.scopes)) {
          return {
            status: "insufficient_permissions",
            checkedAt,
            errorCode: "insufficient_scope",
            message:
              "This connection is missing a Google permission Lia needs. Reauthorize and accept every requested permission.",
          };
        }

        return { status: "healthy", checkedAt, errorCode: null, message: null };
      } catch (error) {
        return {
          status: healthStatusFor(error),
          checkedAt,
          errorCode: error instanceof IntegrationError ? error.code : "unknown",
          message:
            error instanceof IntegrationError
              ? error.message
              : "Something went wrong talking to Google. Try again shortly.",
        };
      }
    },

    async listExternalAccounts(session: CredentialSession): Promise<ExternalAccount[]> {
      const token = await accessTokenFor(session);
      const accounts = await client.listAccounts(token);
      return accounts.map(normalizeAccount);
    },

    async listExternalProfiles(
      session: CredentialSession,
      externalAccountId: string,
    ): Promise<ExternalProfile[]> {
      const token = await accessTokenFor(session);
      const locations = await client.listLocations(token, externalAccountId);
      return dedupeProfiles(
        locations.map((location) => normalizeLocation(location, externalAccountId)),
      );
    },

    /**
     * Every review for one location.
     *
     * The token is resolved through `accessTokenFor`, so a sync that starts
     * with an hour-old access token refreshes it and persists the new one
     * before the first page is requested — rather than issuing 400 requests
     * with a credential that expired on page three.
     */
    async listExternalReviews(
      session: CredentialSession,
      externalAccountId: string,
      externalProfileId: string,
    ): Promise<ExternalReviewBatch> {
      const token = await accessTokenFor(session);
      const parent = reviewParent(externalAccountId, externalProfileId);
      const page = await client.listReviews(token, parent);
      const batch = normalizeReviews(page.reviews, parent);

      return {
        reviews: batch.reviews,
        totalReviewCount: page.totalReviewCount,
        pagesFetched: page.pages,
        malformedCount: batch.failures.length,
      };
    },
  };
}

/**
 * The parent a review hangs off: `accounts/{account}/locations/{location}`.
 *
 * Both halves arrive as full resource names from discovery
 * (`accounts/112…`, `locations/456…`), so they are joined rather than
 * interpolated into a template — and normalised first, because a stored value
 * from an older mapping could be either form and a doubled `accounts/accounts/`
 * is a 404 that reads like a permissions problem.
 */
export function reviewParent(
  externalAccountId: string,
  externalProfileId: string,
): string {
  const account = externalAccountId.startsWith("accounts/")
    ? externalAccountId
    : `accounts/${externalAccountId}`;
  const location = externalProfileId.startsWith("locations/")
    ? externalProfileId
    : `locations/${externalProfileId}`;

  return `${account.replace(/\/+$/, "")}/${location}`;
}
