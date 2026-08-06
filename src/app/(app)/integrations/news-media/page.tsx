import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, ArrowLeft } from "lucide-react";
import { PageBody } from "@/components/shell/app-shell";
import { CapabilityTable } from "@/components/integrations/capability-table";
import {
  MonitoringQueryList,
  type MonitoringQueryListProps,
} from "@/components/integrations/monitoring-query-list";
import {
  PollRunHistory,
  type PollRunListItem,
  type RejectedCandidateListItem,
} from "@/components/integrations/poll-run-history";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { PlatformGlyph } from "@/components/ui/source-badge";
import { ConnectionStatusBadge } from "@/components/ui/status-badge";
import { can } from "@/lib/auth/permissions";
import { getDataSource } from "@/lib/data";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import { newsCapabilities } from "@/lib/monitoring/capabilities";
import { remainingScheduledRequests } from "@/lib/monitoring/budget";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";
import { isNewsMonitorAvailable } from "@/news/registry";
import type { MonitoringQuery } from "@/domain";

export const metadata: Metadata = { title: "News and media" };

/** How many of each query's own history rows to pull before merging. */
const HISTORY_PER_QUERY = 5;
/** How many merged rows to show once every query's history is combined. */
const HISTORY_LIMIT = 15;

/**
 * The news and media connection, in full.
 *
 * Mirrors `google-business-profile/page.tsx`: a page header, a capability
 * table that says exactly what this integration does and does not do, then
 * the content sections. The difference from Google is structural, not
 * cosmetic — news has no OAuth handshake and no per-location listing to map.
 * Its unit of configuration is the monitoring query, and its connection is
 * provisioned implicitly the first time one is saved (`createMonitoringQuery`
 * in `query-service.ts`), so this page can render meaningfully even before
 * that connection exists.
 *
 * Capability state comes from `isNewsMonitorAvailable()`, not from the
 * connection row's status — unlike Google, there is no successful handshake
 * whose existence would otherwise stand in for "this deployment can search
 * news at all."
 */
export default async function NewsMediaIntegrationPage() {
  const [context, dataSource] = await Promise.all([
    getOrganizationContext(),
    getDataSource(),
  ]);
  const { scope, role, organization } = context;

  const [connection, queries, locations] = await Promise.all([
    dataSource.platformConnections.getByPlatform(scope, "news_media"),
    dataSource.monitoringQueries.list(scope),
    dataSource.locations.list(scope),
  ]);

  const now = new Date().toISOString();
  const [remaining, runs, rejections] = await Promise.all([
    remainingScheduledRequests(dataSource, now),
    loadRunHistory(dataSource, scope, queries),
    loadRejectionHistory(dataSource, scope, queries),
  ]);

  const available = isNewsMonitorAvailable();
  const capabilities = newsCapabilities(available);

  const canManage = can(role, "monitoring.manage_queries");
  const canPoll = can(role, "monitoring.poll_now");

  const locationOptions: MonitoringQueryListProps["locations"] = locations.map((location) => ({
    id: location.id,
    name: location.name,
  }));
  const locationNamesById = Object.fromEntries(
    locations.map((location) => [location.id, location.name]),
  );

  return (
    <PageBody>
      <PageHeader
        title="News and media"
        description={
          queries.length > 0
            ? `Watching ${queries.length} ${queries.length === 1 ? "query" : "queries"} for ${organization.name}.`
            : `No monitoring queries yet for ${organization.name}.`
        }
        actions={
          <Link
            href="/integrations"
            className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 text-[13px] font-medium whitespace-nowrap text-gray-700 transition-colors hover:bg-gray-50 hover:text-gray-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-600"
          >
            <ArrowLeft className="size-4 shrink-0" aria-hidden />
            Back to integrations
          </Link>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <PlatformGlyph platform="news_media" size="md" />
          <ConnectionStatusBadge status={connection?.status ?? "disconnected"} />
        </div>
      </PageHeader>

      {!available ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-amber-600/20 bg-amber-100 px-3 py-2.5 text-[13px] text-gray-950"
        >
          <AlertTriangle className="mt-px size-4 shrink-0 text-amber-600" aria-hidden />
          News monitoring is not configured on this server. Your administrator
          needs to set the GNews API key before a monitoring query can be
          polled.
        </p>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-3">
        <Card className="xl:col-span-3">
          <CardHeader
            title="What this integration does"
            description="Stated per capability, so a configured query is never mistaken for continuous, complete coverage."
          />
          <div className="mt-3">
            <CapabilityTable capabilities={capabilities} />
          </div>
        </Card>

        <div className="xl:col-span-3">
          <MonitoringQueryList
            queries={queries}
            locations={locationOptions}
            locationNamesById={locationNamesById}
            canManage={canManage}
            canPoll={canPoll}
            connectorAvailable={available}
          />
        </div>

        <div className="xl:col-span-3">
          <PollRunHistory
            runs={runs}
            rejections={rejections}
            remainingScheduledRequests={remaining}
          />
        </div>
      </div>
    </PageBody>
  );
}

/** Every query's own recent runs, merged newest-first. */
async function loadRunHistory(
  dataSource: LiaDataSource,
  scope: OrganizationScope,
  queries: MonitoringQuery[],
): Promise<PollRunListItem[]> {
  const perQuery = await Promise.all(
    queries.map(async (query) => {
      const runs = await dataSource.newsPollRuns.listForQuery(
        scope,
        query.id,
        HISTORY_PER_QUERY,
      );
      return runs.map((run) => ({ run, queryName: query.name }));
    }),
  );

  return perQuery
    .flat()
    .sort((a, b) => Date.parse(b.run.startedAt) - Date.parse(a.run.startedAt))
    .slice(0, HISTORY_LIMIT);
}

/** Every query's own recent rejections, merged newest-first. */
async function loadRejectionHistory(
  dataSource: LiaDataSource,
  scope: OrganizationScope,
  queries: MonitoringQuery[],
): Promise<RejectedCandidateListItem[]> {
  const perQuery = await Promise.all(
    queries.map(async (query) => {
      const candidates = await dataSource.newsRejectedCandidates.listForQuery(
        scope,
        query.id,
        HISTORY_PER_QUERY,
      );
      return candidates.map((candidate) => ({ candidate, queryName: query.name }));
    }),
  );

  return perQuery
    .flat()
    .sort(
      (a, b) => Date.parse(b.candidate.publishedAt) - Date.parse(a.candidate.publishedAt),
    )
    .slice(0, HISTORY_LIMIT);
}
