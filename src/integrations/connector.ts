import type {
  ConnectionHealthStatus,
  ConnectorCapabilities,
  JsonObject,
  Platform,
  PlatformConnection,
} from "@/domain";

/**
 * The platform connector boundary.
 *
 * One interface, implemented per platform. Everything provider-specific — URLs,
 * request shapes, error vocabularies, pagination quirks — lives behind it, so a
 * route handler or a screen never contains an `if (platform === "google")`.
 *
 * This is deliberately not a plugin framework. There is no registration
 * lifecycle, no capability negotiation protocol, and no dynamic loading:
 * workflow 02 ships exactly one implementation plus a mock, and inventing
 * extension points for connectors that do not exist yet would be guessing at
 * their requirements. What it does provide is the shape a second connector will
 * need to satisfy, which is the part that is expensive to retrofit.
 */

/* -------------------------------------------------------------------------- */
/* Credentials                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Decrypted OAuth material.
 *
 * This type exists only inside the server integration layer. It is never
 * returned from a repository, never placed on a domain entity, never
 * serialised into an audit event, and never crosses into a component. The
 * `Sealed*` forms in `PlatformCredentialRepository` are what the rest of the
 * application is allowed to hold.
 */
export interface PlatformCredentials {
  accessToken: string;
  /**
   * Null is a real state, not an error. Google withholds the refresh token on
   * re-consent when one was already issued, so a reauthorization can legitimately
   * return credentials without one — the caller keeps the token it already has.
   */
  refreshToken: string | null;
  /** Absolute expiry of the access token, ISO-8601. Null when unknown. */
  expiresAt: string | null;
  /** Scopes the provider granted. May be narrower than what was requested. */
  scopes: string[];
  tokenType: string;
}

/* -------------------------------------------------------------------------- */
/* Authorization                                                               */
/* -------------------------------------------------------------------------- */

export interface AuthorizationRequest {
  /** Opaque, single-use, already persisted by the caller. */
  state: string;
  /**
   * Whether to force the consent screen.
   *
   * False for a first connection: Google shows consent anyway when no prior
   * grant exists, and forcing it unconditionally means every reconnection nags
   * a user who already agreed. True only when we specifically need a *new*
   * refresh token — that is the one case where re-consent buys something.
   */
  forceConsent: boolean;
  /** Pre-fills the Google account chooser on reauthorization. */
  loginHint?: string;
}

export interface AuthorizationCallbackInput {
  code: string;
}

/* -------------------------------------------------------------------------- */
/* Discovery                                                                   */
/* -------------------------------------------------------------------------- */

/** A provider-side account whose listings the credential may manage. */
export interface ExternalAccount {
  externalAccountId: string;
  name: string;
  accountType?: string;
  role?: string;
  verificationState?: string;
  organizationInfo?: JsonObject;
}

export interface ExternalProfileAddress {
  addressLine1?: string;
  addressLine2?: string;
  city?: string;
  region?: string;
  postalCode?: string;
  countryCode?: string;
}

/** A provider-side location that could be mapped to a Lia location. */
export interface ExternalProfile {
  externalProfileId: string;
  externalAccountId: string;
  displayName: string;
  title?: string;
  storeCode?: string;
  websiteUrl?: string;
  phoneNumber?: string;
  address?: ExternalProfileAddress;
  timezone?: string;
  verificationState?: string;
  profileUrl?: string;
  metadata?: JsonObject;
}

/* -------------------------------------------------------------------------- */
/* Reviews                                                                     */
/* -------------------------------------------------------------------------- */

/** The owner reply currently published at the source. Never a Lia draft. */
export interface ExternalReviewReply {
  comment: string;
  /** When the owner last edited it. Null when the provider does not say. */
  updatedAt: string | null;
}

/**
 * A review as the provider has it.
 *
 * Deliberately provider-neutral: Yelp and Trustpilot have the same shape, and
 * the next connector should be normalising into this rather than adding its own
 * near-identical type.
 *
 * Nothing here is optional-by-omission. Every field a provider might not supply
 * is explicitly nullable, so "the provider did not tell us" is a value a caller
 * has to handle rather than a key it might forget to check.
 */
export interface ExternalReview {
  /** The provider's identifier for the review. The idempotency key. */
  externalId: string;
  /** Fully qualified resource name, when the provider has one. */
  externalResourceName: string | null;
  /** Null on a rating-only review, which is most of them. */
  comment: string | null;
  /** Integer 1–5, or null when the provider did not give one. */
  rating: number | null;
  authorName: string | null;
  /** Null unless the provider exposes a stable reviewer identity. */
  authorExternalId: string | null;
  authorAvatarUrl: string | null;
  /** The reviewer chose to be anonymous. Distinct from having no name. */
  authorIsAnonymous: boolean;
  publishedAt: string;
  /** When the author last edited it at the source. */
  sourceUpdatedAt: string | null;
  ownerReply: ExternalReviewReply | null;
  /** Null when the provider offers no per-review permalink. Never fabricated. */
  sourceUrl: string | null;
  metadata: JsonObject;
}

/** Everything one review-listing call returned. */
export interface ExternalReviewBatch {
  reviews: ExternalReview[];
  /** The provider's own total, when it gave one. Never inferred. */
  totalReviewCount: number | null;
  pagesFetched: number;
  /**
   * Items the provider sent that could not be normalised.
   *
   * Counted rather than thrown, so one unusable review does not cost a location
   * its other nine hundred. The reasons are Lia's own vocabulary; no provider
   * payload travels in them.
   */
  malformedCount: number;
}

/* -------------------------------------------------------------------------- */
/* Health                                                                      */
/* -------------------------------------------------------------------------- */

export interface ConnectionHealth {
  status: ConnectionHealthStatus;
  checkedAt: string;
  /** Normalised error code, or null when healthy. */
  errorCode: string | null;
  /** Lia's own sentence. Never the provider's message. */
  message: string | null;
}

/* -------------------------------------------------------------------------- */
/* The connector                                                               */
/* -------------------------------------------------------------------------- */

/**
 * Credentials plus a way to persist them when they change.
 *
 * A refresh mints a new access token, and losing it means refreshing again on
 * the next request — burning quota and, worse, risking a refresh-token rotation
 * being dropped. So the connector is handed a write-back callback rather than
 * being asked to return "and also please save this".
 */
export interface CredentialSession {
  credentials: PlatformCredentials;
  onRefreshed(credentials: PlatformCredentials): Promise<void>;
}

export interface PlatformConnector {
  readonly platform: Platform;

  /** What this connector can honestly do today. Drives every capability display. */
  capabilities(): ConnectorCapabilities;

  getAuthorizationUrl(input: AuthorizationRequest): Promise<string>;

  exchangeAuthorizationCode(
    input: AuthorizationCallbackInput,
  ): Promise<PlatformCredentials>;

  refreshCredentials(credentials: PlatformCredentials): Promise<PlatformCredentials>;

  /**
   * Ask the provider to invalidate the credential.
   *
   * Resolves only when the provider confirmed it. Anything else throws, because
   * telling a user "revoked" when the request failed is the one outcome a
   * disconnect flow must never produce.
   */
  revokeCredentials(credentials: PlatformCredentials): Promise<void>;

  testConnection(
    session: CredentialSession,
    connection: PlatformConnection,
  ): Promise<ConnectionHealth>;

  listExternalAccounts(session: CredentialSession): Promise<ExternalAccount[]>;

  listExternalProfiles(
    session: CredentialSession,
    externalAccountId: string,
  ): Promise<ExternalProfile[]>;

  /**
   * Every review for one profile.
   *
   * Complete rather than paged at this boundary: pagination is a provider
   * detail, and a caller that had to drive it would have to know Google's page
   * cap, its ordering vocabulary, and what an absent `reviews` key means. The
   * connector follows every page and returns the history.
   *
   * Read-only, and that is the whole of it in workflow 03. There is no
   * `publishReviewReply` here because Lia does not publish one — the owner
   * reply on `ExternalReview` is what the provider already shows.
   */
  listExternalReviews(
    session: CredentialSession,
    externalAccountId: string,
    externalProfileId: string,
  ): Promise<ExternalReviewBatch>;
}

/**
 * Capability states shown on an integration detail screen.
 *
 * Separate from `ConnectorCapabilities`, which answers "what may Lia do with a
 * mention once it has one". This answers "which parts of this integration are
 * actually built and configured", and the honest answer after workflow 02 is
 * that authentication and discovery work while review synchronisation does not
 * exist. Conflating the two would let a successful OAuth handshake imply that
 * reviews are flowing.
 */
export type IntegrationCapabilityState = "enabled" | "not_configured" | "unavailable";

export interface IntegrationCapability {
  id: string;
  label: string;
  state: IntegrationCapabilityState;
  detail: string;
}
