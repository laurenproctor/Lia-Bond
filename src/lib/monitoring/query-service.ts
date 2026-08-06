import "server-only";

import type { CreateMonitoringQueryInput, MonitoringQuery } from "@/domain";
import { recordAuditEvent } from "@/lib/audit/record";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import { ensureNewsConnection } from "@/lib/monitoring/connection";
import type { NewsMonitor } from "@/news/monitor";

/**
 * Monitoring-query mutations that need more than a repository call.
 *
 * Mirrors `google-service.ts`: a thin `ServiceContext`, no Next.js import, so
 * this is reachable from a test with a hand-built `{ dataSource, scope }` the
 * same way `google-integration.test.ts` exercises the Google service layer —
 * no session or cookie machinery required. `updateMonitoringQueryAction` and
 * `deleteMonitoringQueryAction` stay plain repository calls directly in the
 * action, the same as `updateLocationManagerAction` and
 * `setAutomationRuleEnabledAction`; only creation carries the extra step of
 * provisioning a connection, which is what earns this module.
 */

export interface ServiceContext {
  dataSource: LiaDataSource;
  scope: OrganizationScope;
}

/**
 * Create a monitoring query, provisioning the organization's `news_media`
 * connection first if this is its first one.
 *
 * D62: the connection is created "implicitly on first query save". The poll
 * service also provisions it (`ensureNewsConnection`, shared with this
 * function) but only when a poll actually runs, and a scheduled poll has no
 * human actor and refuses to create one (D70). Without this call, a brand-new
 * organization's very first monitoring query would sit unconnected until
 * somebody happened to poll it by hand — every scheduled poll until then
 * fails with `not_connected`. This function is called from a server action,
 * where `context.scope.userId` is always a verified person, so it is the one
 * write path allowed to create the connection outside of a manual poll.
 */
export async function createMonitoringQuery(
  context: ServiceContext,
  input: CreateMonitoringQueryInput,
  monitor: NewsMonitor,
  now: string,
): Promise<MonitoringQuery> {
  await ensureNewsConnection(
    context.dataSource,
    context.scope,
    monitor,
    context.scope.userId,
    now,
  );

  const created = await context.dataSource.monitoringQueries.create(context.scope, input);

  await recordAuditEvent(context, {
    eventType: "monitoring_query.created",
    entityType: "monitoring_query",
    entityId: created.id,
    previousState: null,
    // The query's own configuration, never article content — a monitoring
    // query has ingested nothing yet at the moment it is created.
    newState: {
      name: created.name,
      queryType: created.queryType,
      enabled: created.enabled,
    },
    metadata: {},
  });

  return created;
}
