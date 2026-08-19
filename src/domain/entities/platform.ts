import { z } from "zod";
import {
  connectionHealthStatusSchema,
  platformConnectionStatusSchema,
  platformProfileStatusSchema,
  platformSchema,
} from "@/domain/enums";
import {
  jsonObjectSchema,
  organizationOwnedSchema,
  timestampSchema,
  timestampsSchema,
  uuidSchema,
} from "@/domain/primitives";

/**
 * What a connector can actually do.
 *
 * This is the contract that keeps the product honest: the UI reads capabilities
 * to decide whether to offer "publish" or "copy for manual publishing", and
 * never assumes a capability a platform does not grant.
 */
export const connectorCapabilitiesSchema = z.object({
  canReadMentions: z.boolean(),
  canReadFullText: z.boolean(),
  supportsWebhooks: z.boolean(),
  canPublishResponses: z.boolean(),
  canEditResponses: z.boolean(),
  canDeleteResponses: z.boolean(),
  /** The platform or our own policy demands a human decision before publishing. */
  requiresApproval: z.boolean(),
  /** Needs a partner agreement before the capability set becomes available. */
  requiresPartnerAccess: z.boolean(),
  /**
   * The provider can identify which external listing is which Lia location.
   *
   * Separate from `canReadMentions`, and Yelp Assisted is why: its Places plan
   * matches a restaurant to a listing and returns nothing but that listing's
   * counters, so it can map locations while being unable to read a single
   * review. Google happens to hold both, which is exactly what made one flag
   * look sufficient until a provider arrived that splits them.
   */
  canMatchLocations: z.boolean(),
  /**
   * Lia can carry an approved response to the provider's own surface, but a
   * person completes the posting.
   *
   * Deliberately not derivable from `canPublishResponses` being false. "Lia
   * cannot publish" is true of a newspaper, where there is no reply path at
   * all, and equally true of Yelp, where the customer posts the reply
   * themselves and comes back to confirm. Those want different screens, so
   * they get different flags rather than one flag and a comment.
   */
  supportsAssistedPosting: z.boolean(),
});

export type ConnectorCapabilities = z.infer<typeof connectorCapabilitiesSchema>;

/** Every capability off. Connectors opt in explicitly. */
export const NO_CAPABILITIES: ConnectorCapabilities = {
  canReadMentions: false,
  canReadFullText: false,
  supportsWebhooks: false,
  canPublishResponses: false,
  canEditResponses: false,
  canDeleteResponses: false,
  requiresApproval: true,
  requiresPartnerAccess: false,
  canMatchLocations: false,
  supportsAssistedPosting: false,
};

/**
 * An authorised link to a platform account.
 *
 * Credentials are deliberately absent, and this is load-bearing rather than
 * tidy: tokens live in a separate, service-role-only table
 * (`platform_connection_secrets`), reached through `PlatformCredentialRepository`
 * and never through this schema. Because `.parse()` strips unknown keys, a
 * credential column that ever leaked into a row would be dropped here rather
 * than serialised to a client component.
 *
 * `providerMetadata` is for safe, displayable provider facts only — account
 * type, verification state, an organization name. Never a token, never a raw
 * error payload.
 */
export const platformConnectionSchema = z
  .object({
    platform: platformSchema,
    externalAccountId: z.string().max(200).nullable(),
    externalAccountName: z.string().max(200).nullable(),
    status: platformConnectionStatusSchema,
    capabilities: connectorCapabilitiesSchema,
    tokenExpiresAt: timestampSchema.nullable(),
    lastSyncedAt: timestampSchema.nullable(),
    /** Scopes the provider actually granted, which may be fewer than requested. */
    grantedScopes: z.array(z.string().min(1).max(200)),
    providerMetadata: jsonObjectSchema,
    lastHealthCheckAt: timestampSchema.nullable(),
    lastHealthStatus: connectionHealthStatusSchema.nullable(),
    lastErrorCode: z.string().max(80).nullable(),
    /** Lia's own sentence about the failure. Never the provider's message. */
    lastErrorMessage: z.string().max(400).nullable(),
    connectedByUserId: uuidSchema.nullable(),
    connectedAt: timestampSchema.nullable(),
    disconnectedAt: timestampSchema.nullable(),
  })
  .extend(organizationOwnedSchema.shape)
  .extend(timestampsSchema.shape);

export type PlatformConnection = z.infer<typeof platformConnectionSchema>;

/** Defaults for the fields workflow 02 added, so older fixtures stay valid. */
export const NEW_CONNECTION_DEFAULTS = {
  grantedScopes: [] as string[],
  providerMetadata: {},
  lastHealthCheckAt: null,
  lastHealthStatus: null,
  lastErrorCode: null,
  lastErrorMessage: null,
  connectedByUserId: null,
  connectedAt: null,
  disconnectedAt: null,
} as const;

/**
 * One monitored presence on a platform, bound to a location.
 *
 * `syncCursor` is connector-defined — a page token, a high-water timestamp, a
 * Reddit fullname — so it stays an opaque string here.
 */
export const platformProfileSchema = z
  .object({
    locationId: uuidSchema.nullable(),
    platformConnectionId: uuidSchema,
    externalProfileId: z.string().min(1).max(200),
    externalProfileName: z.string().min(1).max(200),
    /** Which provider account owns this profile. Google nests locations under accounts. */
    externalAccountId: z.string().max(200).nullable(),
    profileUrl: z.url().nullable(),
    status: platformProfileStatusSchema,
    verificationState: z.string().max(80).nullable(),
    providerMetadata: jsonObjectSchema,
    /** When Lia last saw this profile in a live provider listing. */
    lastConfirmedAt: timestampSchema.nullable(),
    syncCursor: z.string().max(400).nullable(),
    lastSyncedAt: timestampSchema.nullable(),
  })
  .extend(organizationOwnedSchema.shape)
  .extend(timestampsSchema.shape);

export type PlatformProfile = z.infer<typeof platformProfileSchema>;

/** Defaults for the profile fields workflow 02 added. */
export const NEW_PROFILE_DEFAULTS = {
  externalAccountId: null,
  verificationState: null,
  providerMetadata: {},
  lastConfirmedAt: null,
} as const;

/** A connection joined to the profiles that use it, for the integrations screen. */
export const platformConnectionWithProfilesSchema = platformConnectionSchema.extend({
  profiles: z.array(platformProfileSchema),
});

export type PlatformConnectionWithProfiles = z.infer<
  typeof platformConnectionWithProfilesSchema
>;

/* -------------------------------------------------------------------------- */
/* Write inputs                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What an OAuth callback hands the connection repository.
 *
 * Credentials are not in here. They travel separately to
 * `PlatformCredentialRepository`, which is the only thing that touches
 * ciphertext, so no code path can accidentally persist a token onto a row that
 * a UI client is allowed to read.
 */
export const upsertPlatformConnectionInputSchema = z.object({
  platform: platformSchema,
  externalAccountId: z.string().min(1).max(200),
  externalAccountName: z.string().min(1).max(200),
  status: platformConnectionStatusSchema,
  capabilities: connectorCapabilitiesSchema,
  tokenExpiresAt: timestampSchema.nullable(),
  grantedScopes: z.array(z.string().min(1).max(200)),
  providerMetadata: jsonObjectSchema,
  connectedByUserId: uuidSchema,
  connectedAt: timestampSchema,
});

export type UpsertPlatformConnectionInput = z.infer<
  typeof upsertPlatformConnectionInputSchema
>;

export const connectionHealthUpdateSchema = z.object({
  lastHealthCheckAt: timestampSchema,
  lastHealthStatus: connectionHealthStatusSchema,
  lastErrorCode: z.string().max(80).nullable(),
  lastErrorMessage: z.string().max(400).nullable(),
  /** Health can move the connection between `connected` and `action_required`. */
  status: platformConnectionStatusSchema,
});

export type ConnectionHealthUpdate = z.infer<typeof connectionHealthUpdateSchema>;

export const upsertPlatformProfileInputSchema = z.object({
  platformConnectionId: uuidSchema,
  locationId: uuidSchema.nullable(),
  externalProfileId: z.string().min(1).max(200),
  externalProfileName: z.string().min(1).max(200),
  externalAccountId: z.string().min(1).max(200),
  profileUrl: z.url().nullable(),
  status: platformProfileStatusSchema,
  verificationState: z.string().max(80).nullable(),
  providerMetadata: jsonObjectSchema,
  lastConfirmedAt: timestampSchema,
});

export type UpsertPlatformProfileInput = z.infer<
  typeof upsertPlatformProfileInputSchema
>;

/**
 * How a response can leave Lia for a given connection.
 *
 * Derived from capabilities rather than stored, so it can never contradict them.
 *
 * `assisted` is the fourth state, and it is a distinction the previous three
 * could not carry. Before Yelp, "Lia cannot publish" had one meaning — prepare
 * the text and a person will deal with it — and `manual` covered it. Yelp
 * Assisted is a different thing: Lia knows the exact page, hands over the
 * approved words, and takes a recorded confirmation back afterwards. Collapsing
 * that into `manual` would have made the screen offer a bare copy button for a
 * flow that has three steps and a state to record at the end of it.
 *
 * The order is a precedence, not a preference: a provider that can publish
 * directly is never routed through a handoff, whatever else it supports.
 */
export type PublishingMode = "direct" | "assisted" | "manual" | "unavailable";

export function resolvePublishingMode(
  capabilities: ConnectorCapabilities,
): PublishingMode {
  if (capabilities.canPublishResponses) return "direct";
  if (capabilities.supportsAssistedPosting) return "assisted";
  if (capabilities.canReadMentions) return "manual";
  return "unavailable";
}
