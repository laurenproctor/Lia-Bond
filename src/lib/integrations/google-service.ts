import "server-only";

import {
  HEALTH_STATUSES_NEEDING_ACTION,
  type ConnectionHealthStatus,
  type JsonObject,
  type Location,
  type PlatformConnection,
  type PlatformConnectionStatus,
  type PlatformProfile,
} from "@/domain";
import type {
  ConnectionHealth,
  ExternalAccount,
  ExternalProfile,
  PlatformCredentials,
} from "@/integrations/connector";
import { IntegrationError, toIntegrationMessage } from "@/integrations/errors";
import { getGoogleConnector } from "@/integrations/registry";
import { recordAuditEvent } from "@/lib/audit/record";
import { DataError, notFound } from "@/lib/data/errors";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import {
  credentialSession,
  loadCredentials,
  mergeCredentials,
  saveCredentials,
} from "@/lib/integrations/credentials";
import { suggestLocation, type MatchSuggestion } from "@/lib/integrations/matching";

/**
 * Google connection operations.
 *
 * Sits between the connector (which knows Google) and the actions and routes
 * (which know Lia). Everything that has to happen in a particular order —
 * decrypt, refresh, persist, audit, update health — happens here once, so a
 * route handler cannot get the order wrong or skip a step.
 *
 * No function in this module returns a token, and none accepts one.
 */

export const GOOGLE_PLATFORM = "google_business_profile" as const;

export interface ServiceContext {
  dataSource: LiaDataSource;
  scope: OrganizationScope;
}

/* -------------------------------------------------------------------------- */
/* Connection lookup                                                           */
/* -------------------------------------------------------------------------- */

export async function getGoogleConnection(
  context: ServiceContext,
): Promise<PlatformConnection | null> {
  return context.dataSource.platformConnections.getByPlatform(
    context.scope,
    GOOGLE_PLATFORM,
  );
}

async function requireGoogleConnection(
  context: ServiceContext,
): Promise<PlatformConnection> {
  const connection = await getGoogleConnection(context);
  if (!connection) throw notFound("Google connection");
  return connection;
}

/**
 * Open a session against a connection's stored credentials.
 *
 * Throws rather than returning null when nothing is stored: every caller of
 * this needs working credentials, and the only useful answer for a connection
 * without them is "reauthorize".
 */
async function openSession(context: ServiceContext, connection: PlatformConnection) {
  const loaded = await loadCredentials(
    context.dataSource,
    context.scope,
    connection.id,
  );

  if (!loaded) {
    throw new DataError(
      "unavailable",
      "This Google connection has no stored credentials. Reauthorize to reconnect it.",
    );
  }

  return credentialSession(
    context.dataSource,
    context.scope,
    connection.id,
    loaded.credentials,
  );
}

/* -------------------------------------------------------------------------- */
/* Persisting a completed handshake                                            */
/* -------------------------------------------------------------------------- */

export interface CompleteAuthorizationInput extends ServiceContext {
  credentials: PlatformCredentials;
  account: ExternalAccount;
  userId: string;
  reauthorization: boolean;
}

export interface CompleteAuthorizationResult {
  connection: PlatformConnection;
  /** True when the stored refresh token was carried forward rather than replaced. */
  preservedRefreshToken: boolean;
}

/**
 * Store a completed grant.
 *
 * The refresh-token merge is the subtle part. Google issues a refresh token on
 * first consent and **withholds it** on later approvals of the same grant, so a
 * reauthorization legitimately arrives without one. Writing the response
 * verbatim would replace a working refresh token with null and the connection
 * would die quietly hours later, when its access token expired. The existing
 * token is therefore carried forward whenever the new response has none.
 */
export async function completeGoogleAuthorization(
  input: CompleteAuthorizationInput,
): Promise<CompleteAuthorizationResult> {
  const context: ServiceContext = {
    dataSource: input.dataSource,
    scope: input.scope,
  };
  const connector = getGoogleConnector();
  const existingConnection = await getGoogleConnection(context);

  const existingCredentials = existingConnection
    ? await loadCredentials(
        input.dataSource,
        input.scope,
        existingConnection.id,
      ).catch(() => null)
    : null;

  const merged = mergeCredentials(
    input.credentials,
    existingCredentials?.credentials ?? null,
  );
  const preservedRefreshToken =
    input.credentials.refreshToken === null && merged.refreshToken !== null;

  const providerMetadata: JsonObject = {
    ...(input.account.accountType ? { accountType: input.account.accountType } : {}),
    ...(input.account.role ? { role: input.account.role } : {}),
    ...(input.account.verificationState
      ? { verificationState: input.account.verificationState }
      : {}),
    ...(input.account.organizationInfo ?? {}),
  };

  const connectedAt = new Date().toISOString();

  const connection = await input.dataSource.platformConnections.upsert(input.scope, {
    platform: GOOGLE_PLATFORM,
    externalAccountId: input.account.externalAccountId,
    externalAccountName: input.account.name,
    status: "connected",
    // Whatever the connector honestly claims today: reading reviews yes,
    // publishing anything no. See src/lib/integrations/capabilities.ts.
    capabilities: connector.capabilities(),
    tokenExpiresAt: merged.expiresAt,
    grantedScopes: merged.scopes,
    providerMetadata,
    connectedByUserId: input.userId,
    connectedAt,
  });

  await saveCredentials(input.dataSource, input.scope, connection.id, merged);

  // Reconnecting reactivates the mappings a previous disconnect preserved.
  // Without this, reauthorizing a disconnected connection would leave every
  // profile inactive and look like the reconnection failed.
  if (input.reauthorization) {
    const profiles = await input.dataSource.platformProfiles.listForConnection(
      input.scope,
      connection.id,
    );
    for (const profile of profiles) {
      if (profile.status !== "disconnected") continue;
      await input.dataSource.platformProfiles.upsert(input.scope, {
        platformConnectionId: connection.id,
        locationId: profile.locationId,
        externalProfileId: profile.externalProfileId,
        externalProfileName: profile.externalProfileName,
        externalAccountId:
          profile.externalAccountId ?? input.account.externalAccountId,
        profileUrl: profile.profileUrl,
        status: "active",
        verificationState: profile.verificationState,
        providerMetadata: profile.providerMetadata,
        lastConfirmedAt: connectedAt,
      });
    }
  }

  await recordAuditEvent(context, {
    eventType: "integration.oauth_completed",
    entityType: "platform_connection",
    entityId: connection.id,
    previousState: null,
    // Scopes and account identity only. No token, no authorization code, no
    // state value ever appears in an audit record.
    newState: {
      platform: GOOGLE_PLATFORM,
      externalAccountId: connection.externalAccountId,
      grantedScopes: connection.grantedScopes.join(" "),
    },
    metadata: {
      reauthorization: input.reauthorization,
      preservedRefreshToken,
    },
  });

  await recordAuditEvent(context, {
    eventType: input.reauthorization
      ? "integration.reauthorized"
      : "integration.connected",
    entityType: "platform_connection",
    entityId: connection.id,
    previousState: existingConnection
      ? { status: existingConnection.status }
      : null,
    newState: { status: connection.status },
    metadata: {
      accountName: connection.externalAccountName ?? "",
      scopeCount: connection.grantedScopes.length,
    },
  });

  return { connection, preservedRefreshToken };
}

/* -------------------------------------------------------------------------- */
/* Discovery                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * The Business Profile accounts this connection may manage.
 *
 * Failures update connection health on the way past. A user who opens the setup
 * screen and sees "Google access was revoked" should not have to click Test
 * connection to make the integration screen agree with them.
 */
export async function listGoogleBusinessAccounts(
  context: ServiceContext,
  connectionId: string,
): Promise<ExternalAccount[]> {
  const connection = await context.dataSource.platformConnections.get(
    context.scope,
    connectionId,
  );
  if (!connection) throw notFound("Google connection");

  const session = await openSession(context, connection);

  try {
    return await getGoogleConnector().listExternalAccounts(session);
  } catch (error) {
    await recordConnectionFailureHealth(context, connection, error);
    throw error;
  }
}

export async function listGoogleBusinessLocations(
  context: ServiceContext,
  connectionId: string,
  externalAccountId: string,
): Promise<ExternalProfile[]> {
  const connection = await context.dataSource.platformConnections.get(
    context.scope,
    connectionId,
  );
  if (!connection) throw notFound("Google connection");

  const session = await openSession(context, connection);

  try {
    return await getGoogleConnector().listExternalProfiles(session, externalAccountId);
  } catch (error) {
    await recordConnectionFailureHealth(context, connection, error);
    throw error;
  }
}

/**
 * How a discovered Google location relates to Lia already.
 *
 * Rendered as a per-row status on the mapping screen, so someone can see at a
 * glance which listings still need a decision.
 */
export type CandidateState =
  | "unmapped"
  | "mapped"
  | "already_connected"
  | "unavailable";

export interface LocationCandidate {
  profile: ExternalProfile;
  state: CandidateState;
  /** The Lia location this profile already points at, when there is one. */
  mappedLocationId: string | null;
  /** A proposal, never an applied mapping. Requires explicit confirmation. */
  suggestion: MatchSuggestion | null;
}

/**
 * Annotate discovered listings with what Lia already knows.
 *
 * Suggestions are computed for unmapped candidates only, and locations that are
 * already spoken for are excluded from the candidate pool — proposing a
 * location that is taken would produce a suggestion the user cannot accept.
 */
export function buildCandidates(
  profiles: ExternalProfile[],
  existingProfiles: PlatformProfile[],
  locations: Location[],
): LocationCandidate[] {
  const byExternalId = new Map(
    existingProfiles.map((profile) => [profile.externalProfileId, profile]),
  );
  const takenLocationIds = new Set(
    existingProfiles.flatMap((profile) =>
      profile.locationId && profile.status !== "disconnected"
        ? [profile.locationId]
        : [],
    ),
  );

  return profiles.map((profile) => {
    const existing = byExternalId.get(profile.externalProfileId);

    if (existing) {
      return {
        profile,
        state:
          existing.status === "disconnected"
            ? "unavailable"
            : existing.locationId
              ? "already_connected"
              : "mapped",
        mappedLocationId: existing.locationId,
        suggestion: null,
      } satisfies LocationCandidate;
    }

    return {
      profile,
      state: "unmapped",
      mappedLocationId: null,
      suggestion: suggestLocation(profile, locations, takenLocationIds),
    } satisfies LocationCandidate;
  });
}

/* -------------------------------------------------------------------------- */
/* Health                                                                      */
/* -------------------------------------------------------------------------- */

/** Health that leaves the connection unusable moves its status, and nothing else does. */
function statusForHealth(health: ConnectionHealthStatus): PlatformConnectionStatus {
  if (HEALTH_STATUSES_NEEDING_ACTION.includes(health)) return "action_required";
  if (health === "token_expiring") return "action_required";
  // Quota limits and provider outages are Google's problem and they pass. A
  // rate limit is not a reason to tell an operator their integration is broken.
  return "connected";
}

/**
 * Test a connection against Google and record the result.
 *
 * Audit events are written for the check itself and, separately, only when the
 * health state actually *changed* for the worse. Emitting a degradation event on
 * every poll of a still-broken connection would bury the moment it broke.
 */
export async function checkGoogleConnectionHealth(
  context: ServiceContext,
  connectionId: string,
): Promise<{ connection: PlatformConnection; health: ConnectionHealth }> {
  const connection = await context.dataSource.platformConnections.get(
    context.scope,
    connectionId,
  );
  if (!connection) throw notFound("Google connection");

  let health: ConnectionHealth;

  try {
    const session = await openSession(context, connection);
    health = await getGoogleConnector().testConnection(session, connection);
  } catch (error) {
    health = {
      status:
        error instanceof IntegrationError ? healthFromError(error) : "unknown_error",
      checkedAt: new Date().toISOString(),
      errorCode: error instanceof IntegrationError ? error.code : "unavailable",
      message: toIntegrationMessage(error),
    };
  }

  const updated = await context.dataSource.platformConnections.updateHealth(
    context.scope,
    connectionId,
    {
      lastHealthCheckAt: health.checkedAt,
      lastHealthStatus: health.status,
      lastErrorCode: health.errorCode,
      // Lia's own sentence, capped. Provider payloads are never persisted.
      lastErrorMessage: health.message ? health.message.slice(0, 400) : null,
      status: statusForHealth(health.status),
    },
  );

  await recordAuditEvent(context, {
    eventType: "integration.health_checked",
    entityType: "platform_connection",
    entityId: connectionId,
    previousState: { lastHealthStatus: connection.lastHealthStatus },
    newState: { lastHealthStatus: health.status },
    metadata: { errorCode: health.errorCode ?? "" },
  });

  const degraded =
    health.status !== "healthy" && connection.lastHealthStatus !== health.status;

  if (degraded) {
    await recordAuditEvent(context, {
      eventType: "integration.health_degraded",
      entityType: "platform_connection",
      entityId: connectionId,
      previousState: { status: connection.status },
      newState: { status: updated.status, health: health.status },
      metadata: { errorCode: health.errorCode ?? "" },
    });
  }

  return { connection: updated, health };
}

function healthFromError(error: IntegrationError): ConnectionHealthStatus {
  switch (error.code) {
    case "authorization_revoked":
    case "credentials_expired":
      return "authorization_required";
    case "insufficient_scope":
      return "insufficient_permissions";
    case "quota_exceeded":
      return "quota_limited";
    case "provider_unavailable":
      return "provider_unavailable";
    default:
      return "unknown_error";
  }
}

/**
 * Record a failure that happened during ordinary work.
 *
 * Best-effort by design: a discovery call that failed should surface *its* error
 * to the user, not a secondary failure from trying to write down that the first
 * one happened.
 *
 * Exported because a review sync needs the same behaviour for the same reason:
 * a revoked credential discovered while importing is a fact about the
 * connection, and the integrations screen must not keep showing "healthy"
 * beside a location that has not imported anything for a week.
 */
export async function recordConnectionFailureHealth(
  context: ServiceContext,
  connection: PlatformConnection,
  error: unknown,
): Promise<void> {
  if (!(error instanceof IntegrationError)) return;

  const health = healthFromError(error);

  try {
    await context.dataSource.platformConnections.updateHealth(
      context.scope,
      connection.id,
      {
        lastHealthCheckAt: new Date().toISOString(),
        lastHealthStatus: health,
        lastErrorCode: error.code,
        lastErrorMessage: error.message.slice(0, 400),
        status: statusForHealth(health),
      },
    );
  } catch {
    // Swallowed deliberately. See the doc comment above.
  }
}

/* -------------------------------------------------------------------------- */
/* Disconnect                                                                  */
/* -------------------------------------------------------------------------- */

export interface DisconnectResult {
  connection: PlatformConnection;
  profilesDeactivated: number;
  /**
   * Whether Google confirmed the revocation.
   *
   * `false` is reported to the user as "could not be confirmed", never as
   * success. The local credentials are gone either way, but a token Google
   * still honours is a fact an administrator may need to act on in their own
   * Google account.
   */
  remoteRevocationConfirmed: boolean;
}

/**
 * Disconnect Google.
 *
 * Ordered so the local side always ends up clean. Remote revocation is
 * attempted first, because it needs the credentials that the next step
 * destroys, but its failure never stops the local teardown — leaving encrypted
 * tokens behind because Google was briefly unreachable would be the worse
 * outcome.
 *
 * Idempotent: disconnecting an already-disconnected connection succeeds
 * quietly, so a double-clicked confirm button does not produce an error for
 * getting exactly what was asked for.
 */
export async function disconnectGoogle(
  context: ServiceContext,
): Promise<DisconnectResult> {
  const connection = await requireGoogleConnection(context);

  if (connection.status === "disconnected") {
    const profiles = await context.dataSource.platformProfiles.listForConnection(
      context.scope,
      connection.id,
    );
    return {
      connection,
      profilesDeactivated: profiles.length,
      remoteRevocationConfirmed: false,
    };
  }

  let remoteRevocationConfirmed = false;
  let revocationErrorCode: string | null = null;

  const loaded = await loadCredentials(
    context.dataSource,
    context.scope,
    connection.id,
  ).catch(() => null);

  if (loaded) {
    try {
      await getGoogleConnector().revokeCredentials(loaded.credentials);
      remoteRevocationConfirmed = true;
    } catch (error) {
      revocationErrorCode =
        error instanceof IntegrationError ? error.code : "unknown";
    }
  } else {
    // Nothing to revoke. Not a failure, but not a confirmation either — there
    // was no credential here to tell Google about.
    revocationErrorCode = "no_stored_credentials";
  }

  await context.dataSource.platformCredentials.clear(context.scope, connection.id);

  const profiles = await context.dataSource.platformProfiles.deactivateForConnection(
    context.scope,
    connection.id,
  );

  const updated = await context.dataSource.platformConnections.markDisconnected(
    context.scope,
    connection.id,
  );

  await recordAuditEvent(context, {
    eventType: remoteRevocationConfirmed
      ? "integration.credentials_revoked"
      : "integration.credentials_revocation_failed",
    entityType: "platform_connection",
    entityId: connection.id,
    previousState: null,
    newState: null,
    metadata: {
      remoteRevocationConfirmed,
      reason: revocationErrorCode ?? "",
    },
  });

  await recordAuditEvent(context, {
    eventType: "integration.disconnected",
    entityType: "platform_connection",
    entityId: connection.id,
    previousState: { status: connection.status },
    newState: { status: updated.status },
    metadata: {
      profilesDeactivated: profiles.length,
      remoteRevocationConfirmed,
    },
  });

  return {
    connection: updated,
    profilesDeactivated: profiles.length,
    remoteRevocationConfirmed,
  };
}
