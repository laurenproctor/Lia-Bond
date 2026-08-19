import "server-only";

import type { PlatformConnection } from "@/domain";
import { recordAuditEvent } from "@/lib/audit/record";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import { YELP_ASSISTED_CAPABILITIES } from "@/yelp/capabilities";

/**
 * The `yelp` connection.
 *
 * Created implicitly on first connect, exactly as `ensureNewsConnection` does
 * and for the same structural reason (D80): `mentions.platform_connection_id`
 * is `not null`, so a captured Yelp review needs a connection row whether or
 * not "connection" means much here. Nothing touches `platform_credentials`,
 * `oauth_states`, or the AES vault — the Places key is Lia's, held in the
 * environment and shared by every tenant (D79's posture).
 *
 * **This is a mapping, not an authorization, and the wording matters.** A Yelp
 * Places API key authenticates *Lia*, and proves nothing whatsoever about
 * whether the customer owns the listing they are pointing at. There is no
 * business-owner OAuth here, so `externalAccountName` deliberately does not
 * name a Yelp account — there is no account — and every piece of copy above
 * this calls it a connected listing rather than a connected account.
 */

/**
 * The synthetic external account id.
 *
 * `platform_connections_unique_account (organization_id, platform,
 * external_account_id)` needs a value, and there is no Yelp account to name.
 * Derived from the organization id so it is stable across reconnects and
 * unique per tenant, mirroring `news-monitor-${organizationId}`.
 */
export function yelpExternalAccountId(organizationId: string): string {
  return `yelp-listings-${organizationId}`;
}

/** What the connection is called on the integrations screen. */
export const YELP_CONNECTION_NAME = "Yelp listings";

/**
 * Find, or create, the organization's `yelp` connection.
 *
 * Returns null when there is no verified person behind the call and no
 * connection exists yet. `connectedByUserId` is not nullable, and the system
 * actor sentinel must never reach a foreign key (D88) — so a scheduled check
 * that finds no connection cannot invent one, and reports a failed run
 * instead. In practice a scheduled check can only reach a listing that
 * somebody connected through the UI, which is the path that creates this row.
 */
export async function ensureYelpConnection(
  dataSource: LiaDataSource,
  scope: OrganizationScope,
  actorUserId: string | null,
  now: string,
): Promise<PlatformConnection | null> {
  const existing = await dataSource.platformConnections.getByPlatform(scope, "yelp");
  if (existing) return existing;
  if (!actorUserId) return null;

  const created = await dataSource.platformConnections.upsert(scope, {
    platform: "yelp",
    externalAccountId: yelpExternalAccountId(scope.organizationId),
    externalAccountName: YELP_CONNECTION_NAME,
    status: "connected",
    // From the provider's own declaration rather than a hand-written guess, so
    // the integrations screen can never advertise review reading or webhooks
    // that the Places plan does not have.
    capabilities: YELP_ASSISTED_CAPABILITIES,
    // No token, so nothing expires and nothing was granted. Empty rather than
    // fabricated: a scope list here would imply an authorization handshake that
    // never happened.
    tokenExpiresAt: null,
    grantedScopes: [],
    providerMetadata: {},
    connectedByUserId: actorUserId,
    connectedAt: now,
  });

  await recordAuditEvent(
    { dataSource, scope },
    {
      eventType: "integration.connected",
      entityType: "platform_connection",
      entityId: created.id,
      previousState: null,
      newState: {
        platform: "yelp",
        externalAccountId: created.externalAccountId,
      },
      metadata: {},
      actorType: "user",
    },
  );

  return created;
}
