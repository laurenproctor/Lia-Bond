import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import {
  MonitoringQueryForm,
  type MonitoringLocationOption,
} from "@/components/integrations/monitoring-query-form";
import { MonitoringQueryRowActions } from "@/components/integrations/monitoring-query-row-actions";
import { formatDuration, formatRelativeShort } from "@/lib/format";
import { MONITORING_QUERY_TYPE_LABELS } from "@/lib/labels";
import type { MonitoringQuery } from "@/domain";

/**
 * What Lia watches for, and the controls to change it.
 *
 * A server component: it queries nothing itself — `queries` and `locations`
 * arrive as props from the page — and renders no interactivity of its own.
 * The add form and the per-row toggle/poll/edit/delete controls are
 * `MonitoringQueryForm` and `MonitoringQueryRowActions`, the two client
 * components on this screen; this file only lays out the table around them,
 * the same split `RulesPage` makes with `RuleToggle`.
 */

export interface MonitoringQueryListProps {
  queries: MonitoringQuery[];
  locations: MonitoringLocationOption[];
  locationNamesById: Record<string, string>;
  canManage: boolean;
  canPoll: boolean;
  connectorAvailable: boolean;
}

function buildColumns(
  locationNamesById: Record<string, string>,
  locations: MonitoringLocationOption[],
  canManage: boolean,
  canPoll: boolean,
  connectorAvailable: boolean,
): DataTableColumn<MonitoringQuery>[] {
  return [
    {
      id: "name",
      header: "Query",
      cell: (query) => (
        <span>
          <span className="block font-medium text-gray-950">{query.name}</span>
          <span className="mt-0.5 flex flex-wrap gap-1">
            {query.keywords.map((keyword) => (
              <span
                key={keyword}
                className="rounded-md bg-gray-100 px-1.5 py-0.5 text-[11.5px] text-gray-700"
              >
                {keyword}
              </span>
            ))}
          </span>
        </span>
      ),
    },
    {
      id: "type",
      header: "Watching",
      secondary: true,
      cell: (query) => (
        <span>
          <span className="block">{MONITORING_QUERY_TYPE_LABELS[query.queryType]}</span>
          <span className="mt-0.5 block text-[12px] text-gray-500">
            {query.locationId ? (locationNamesById[query.locationId] ?? "Unknown location") : "Organization-wide"}
          </span>
        </span>
      ),
    },
    {
      id: "interval",
      header: "Interval",
      align: "right",
      secondary: true,
      cell: (query) => (
        <span className="tabular-nums">{formatDuration(query.pollIntervalMinutes)}</span>
      ),
    },
    {
      id: "lastPolled",
      header: "Last polled",
      align: "right",
      secondary: true,
      cell: (query) =>
        query.lastPolledAt ? (
          <span className="text-gray-500">{formatRelativeShort(query.lastPolledAt)}</span>
        ) : (
          <span className="text-gray-400">Never</span>
        ),
    },
    {
      id: "status",
      header: "Status",
      align: "right",
      cell: (query) => (
        <Badge tone={query.enabled ? "green" : "neutral"}>
          {query.enabled ? "Enabled" : "Disabled"}
        </Badge>
      ),
    },
    {
      id: "actions",
      header: "Manage",
      align: "right",
      cell: (query) => (
        <MonitoringQueryRowActions
          query={query}
          locations={locations}
          canManage={canManage}
          canPoll={canPoll}
          connectorAvailable={connectorAvailable}
        />
      ),
    },
  ];
}

export function MonitoringQueryList({
  queries,
  locations,
  locationNamesById,
  canManage,
  canPoll,
  connectorAvailable,
}: MonitoringQueryListProps) {
  return (
    <div className="flex flex-col gap-4">
      {canManage ? <MonitoringQueryForm locations={locations} /> : null}

      <Card flush>
        <CardHeader
          className="p-5 pb-3"
          title="Monitoring queries"
          description="Each query is polled on its own schedule. Polling it by hand also spends from today's shared request budget."
        />
        <DataTable
          caption="Monitoring queries"
          columns={buildColumns(
            locationNamesById,
            locations,
            canManage,
            canPoll,
            connectorAvailable,
          )}
          rows={queries}
          rowKey={(query) => query.id}
          emptyTitle="No monitoring queries yet"
          emptyDescription="Add one above to start watching news coverage for your brand or a location."
        />
      </Card>
    </div>
  );
}
