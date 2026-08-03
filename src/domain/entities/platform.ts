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
 */
export type PublishingMode = "direct" | "manual" | "unavailable";

export function resolvePublishingMode(
  capabilities: ConnectorCapabilities,
): PublishingMode {
  if (capabilities.canPublishResponses) return "direct";
  if (capabilities.canReadMentions) return "manual";
  return "unavailable";
}
