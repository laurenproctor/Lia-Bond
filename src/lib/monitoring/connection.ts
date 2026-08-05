import "server-only";

import type { PlatformConnection } from "@/domain";
import { recordAuditEvent } from "@/lib/audit/record";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import type { NewsMonitor } from "@/news/monitor";

/**
 * The `news_media` connection.
 *
 * Its own module rather than a private helper inside `poll-service.ts`: the
 * scheduled sweep and a server action both need it, and a person creating a
 * monitoring query is exactly the moment D62 names — "implicitly on first
 * query save" — so this must be reachable from `src/app/actions/monitoring.ts`
 * as well as from `pollMonitoringQuery`.
 */

/**
 * Find, or create, the organization's `news_media` connection.
 *
 * `mentions.platform_connection_id` is `not null`, and news has no OAuth flow
 * or credential to hang a connection off (D61) — so it is created implicitly
 * the first time a poll needs the row, one per organization, status
 * `connected`, no credential row (D62). Capabilities come from
 * `monitor.capabilities()`, never a hand-written guess — the same "whatever
 * the connector honestly claims today" rule `connectGoogleAccount` follows,
 * so the integrations screen never advertises full-text reading or webhooks a
 * free-tier search API does not have.
 *
 * Attribution needs a real person: `connectedByUserId` is not nullable, and
 * the system actor sentinel used under cron must never reach a foreign key
 * (D70). A scheduled poll that finds no connection and no human behind it
 * cannot create one — it returns `null`, and the caller finishes the run as
 * failed rather than inventing an owner. `createMonitoringQueryAction`, by
 * contrast, always has a verified human behind it (a server action cannot run
 * without one), which is what closes the gap a brand-new organization would
 * otherwise hit: its scheduled polls would fail forever with `not_connected`
 * until somebody happened to poll manually once.
 */
export async function ensureNewsConnection(
  dataSource: LiaDataSource,
  scope: OrganizationScope,
  monitor: NewsMonitor,
  actorUserId: string | null,
  now: string,
): Promise<PlatformConnection | null> {
  const existing = await dataSource.platformConnections.getByPlatform(scope, "news_media");
  if (existing) return existing;
  if (!actorUserId) return null;

  const created = await dataSource.platformConnections.upsert(scope, {
    platform: "news_media",
    externalAccountId: `news-monitor-${scope.organizationId}`,
    externalAccountName: "News and media monitoring",
    status: "connected",
    capabilities: monitor.capabilities(),
    tokenExpiresAt: null,
    grantedScopes: [],
    providerMetadata: {},
    connectedByUserId: actorUserId,
    connectedAt: now,
  });

  // Every other connection creation records one (`connectGoogleAccount`); a
  // `news_media` row appearing on the integrations screen with no audit trail
  // of who created it or when would be the one silent exception.
  await recordAuditEvent(
    { dataSource, scope },
    {
      eventType: "integration.connected",
      entityType: "platform_connection",
      entityId: created.id,
      previousState: null,
      newState: {
        platform: "news_media",
        externalAccountId: created.externalAccountId,
      },
      metadata: {},
      actorType: "user",
    },
  );

  return created;
}
