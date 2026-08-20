import type { Metadata } from "next";
import { Plus } from "lucide-react";
import { PageBody } from "@/components/shell/app-shell";
import {
  LocationComparisonCard,
  type LocationRow,
} from "@/components/overview/location-comparison-card";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { LocationFilters } from "@/components/locations/location-filters";
import { EmptyState } from "@/components/ui/empty-state";
import { KpiCard } from "@/components/ui/kpi-card";
import { PageHeader } from "@/components/ui/page-header";
import { SectionPlaceholder } from "@/components/ui/section-placeholder";
import { LocationStatusBadge } from "@/components/ui/status-badge";
import { formatDuration, formatNumber, formatPercent, formatRating } from "@/lib/format";
import { getDataSource } from "@/lib/data";
import { can } from "@/lib/auth/permissions";
import {
  filterLocations,
  parseLocationSearchParam,
  parseLocationStatusParam,
} from "@/lib/locations/search-params";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";
import type { Kpi } from "@/lib/view-models/kpi";
import type { Location } from "@/domain";
import type { LocationMetrics } from "@/lib/data/types";

export const metadata: Metadata = { title: "Locations" };

interface PortfolioRow {
  location: Location;
  metrics: LocationMetrics;
  managerName: string | null;
}

const COLUMNS: DataTableColumn<PortfolioRow>[] = [
  {
    id: "name",
    header: "Location",
    cell: (row) => (
      <span>
        <span className="block font-medium text-gray-950">{row.location.name}</span>
        <span className="block text-[12px] text-gray-500">
          {row.location.city}, {row.location.region}
        </span>
      </span>
    ),
  },
  {
    id: "status",
    header: "Status",
    cell: (row) => <LocationStatusBadge status={row.location.status} />,
  },
  {
    id: "manager",
    header: "Manager",
    secondary: true,
    cell: (row) => row.managerName ?? <span className="text-gray-400">Unassigned</span>,
  },
  {
    id: "volume",
    header: "Mentions",
    align: "right",
    cell: (row) => (
      <span className="tabular-nums">{formatNumber(row.metrics.mentionVolume)}</span>
    ),
  },
  {
    id: "rating",
    header: "Avg. rating",
    align: "right",
    cell: (row) => (
      <span className="tabular-nums">{formatRating(row.metrics.averageRating)}</span>
    ),
  },
  {
    id: "risk",
    header: "Risk mentions",
    align: "right",
    cell: (row) => (
      <span
        className={
          row.metrics.riskMentions > 0
            ? "font-semibold text-red-600 tabular-nums"
            : "tabular-nums"
        }
      >
        {row.metrics.riskMentions}
      </span>
    ),
  },
];

/** Portfolio roll-ups, derived from per-location metrics rather than stored. */
function buildPortfolioKpis(rows: PortfolioRow[]): Kpi[] {
  const active = rows.filter((row) => row.location.status === "active");
  const divisor = active.length || 1;

  const totalVolume = active.reduce((sum, row) => sum + row.metrics.mentionVolume, 0);
  const rated = active.filter((row) => row.metrics.averageRating !== null);
  const averageRating =
    rated.length === 0
      ? null
      : rated.reduce((sum, row) => sum + (row.metrics.averageRating ?? 0), 0) / rated.length;
  const averageCoverage =
    active.reduce((sum, row) => sum + row.metrics.responseCoveragePercent, 0) / divisor;
  const averageResponse =
    active.reduce((sum, row) => sum + row.metrics.averageResponseMinutes, 0) / divisor;
  const totalRisk = active.reduce((sum, row) => sum + row.metrics.riskMentions, 0);

  // No comparison period is stored yet, so these render "No change" rather than
  // showing a delta nobody computed.
  const flat = { changePercent: 0, higherIsBetter: true, comparisonLabel: "this period" };

  return [
    {
      id: "locations",
      label: "Active locations",
      value: String(active.length),
      trend: { points: [active.length, active.length], ...flat },
    },
    {
      id: "volume",
      label: "Mentions",
      value: formatNumber(totalVolume),
      trend: { points: [0, totalVolume], ...flat },
    },
    {
      id: "rating",
      label: "Portfolio rating",
      value: formatRating(averageRating),
      trend: { points: [0, averageRating ?? 0], ...flat },
    },
    {
      id: "coverage",
      label: "Response coverage",
      value: formatPercent(averageCoverage),
      trend: { points: [0, averageCoverage], ...flat },
    },
    {
      id: "risk",
      label: "Risk mentions",
      value: String(totalRisk),
      trend: {
        points: [0, totalRisk],
        changePercent: 0,
        higherIsBetter: false,
        comparisonLabel: "high and critical",
      },
    },
    {
      id: "response_time",
      label: "Average response time",
      value: formatDuration(averageResponse),
      trend: {
        points: [0, averageResponse],
        changePercent: 0,
        higherIsBetter: false,
        comparisonLabel: "first published response",
      },
    },
  ];
}

interface LocationsPageProps {
  searchParams: Promise<{ q?: string; status?: string }>;
}

export default async function LocationsPage({ searchParams }: LocationsPageProps) {
  const params = await searchParams;
  const query = parseLocationSearchParam(params.q);
  const status = parseLocationStatusParam(params.status);

  const context = await getOrganizationContext();
  const scope = context.scope;
  const canCreate = can(context.role, "location.create");
  const dataSource = await getDataSource();

  const [locations, locationMetrics, members] = await Promise.all([
    dataSource.locations.list(scope),
    dataSource.locations.metrics(scope),
    dataSource.memberships.listMembers(scope),
  ]);

  const metricsById = new Map(locationMetrics.map((entry) => [entry.locationId, entry]));
  const namesById = new Map(members.map((member) => [member.userId, member.user.fullName]));

  const rows: PortfolioRow[] = locations.flatMap((location) => {
    const metrics = metricsById.get(location.id);
    if (!metrics) return [];
    return [
      {
        location,
        metrics,
        managerName: location.managerUserId
          ? (namesById.get(location.managerUserId) ?? null)
          : null,
      },
    ];
  });

  // The filter applies to the table, and to nothing else on the page.
  //
  // The KPI row and the comparison card are both portfolio views: they answer
  // "how is the estate doing", which is not a question about the current
  // search. A "Portfolio rating" that moved while somebody typed would not be a
  // portfolio rating.
  //
  // The comparison card was filtered in an earlier draft, and looking at the
  // rendered screen is what settled it: with a filter matching nothing, the KPI
  // read "Active locations 4" while the card immediately beneath it read "0
  // active locations". Both were true of different sets, and side by side they
  // read as the page contradicting itself. One rule — the filter changes the
  // table — is legible; two scopes stacked vertically are not.
  const visible = filterLocations(rows, { query, status });
  const isFiltered = query !== "" || status !== "all";

  const activeRows: LocationRow[] = rows
    .filter((row) => row.location.status === "active")
    .map((row) => ({ location: row.location, metrics: row.metrics }));

  return (
    <PageBody>
      <PageHeader
        title="Locations"
        description="Portfolio performance, connected profiles, and per-location settings."
        actions={
          // Rendered only for roles that can act. A disabled button telling
          // somebody they may not do the thing is the pattern D188 rejected on
          // the rules screen: no action at all beats a dead control.
          //
          // Row navigation, search, and the status filter are still inert —
          // they are the next task. This is here so the screens behind it are
          // reachable at all.
          canCreate ? (
            <ButtonLink href="/locations/new" variant="primary" icon={Plus}>
              Add location
            </ButtonLink>
          ) : null
        }
      >
        <LocationFilters query={query} status={status} />
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-6">
        {buildPortfolioKpis(rows).map((kpi) => (
          <KpiCard key={kpi.id} kpi={kpi} />
        ))}
      </div>

      <LocationComparisonCard rows={activeRows} />

      <Card flush>
        <CardHeader
          className="p-5 pb-3"
          title="All locations"
          description={
            isFiltered
              ? `${visible.length} of ${rows.length} locations match.`
              : "Including locations still onboarding and ones no longer in service."
          }
        />

        {/* Two different empty states, because they are two different facts
            with two different fixes — the split D186 made for the rules screen.
            "You have no locations" wants a way to add one; "none match this
            filter" wants a way to clear it, and offering to create a restaurant
            there answers a question nobody asked. */}
        {rows.length === 0 ? (
          <div className="p-5 pt-0">
            <EmptyState
              title="No locations yet"
              description="Add a location to start monitoring its profiles."
              action={
                canCreate ? (
                  <ButtonLink href="/locations/new" variant="primary" size="sm" icon={Plus}>
                    Add location
                  </ButtonLink>
                ) : undefined
              }
            />
          </div>
        ) : visible.length === 0 ? (
          <div className="p-5 pt-0">
            <EmptyState
              title="No locations match"
              description="Nothing in this portfolio matches the current search and status."
              action={
                <ButtonLink href="/locations" variant="secondary" size="sm">
                  Clear filters
                </ButtonLink>
              }
            />
          </div>
        ) : (
          <DataTable
            caption="Every location in the portfolio"
            columns={COLUMNS}
            rows={visible}
            rowKey={(row) => row.location.id}
            rowHref={(row) => `/locations/${row.location.id}`}
            rowLabel={(row) => `Open ${row.location.name}`}
          />
        )}
      </Card>

      <div className="grid gap-4 xl:grid-cols-2">
        <SectionPlaceholder
          title="Connected profiles"
          description="Which source profiles map to this location, and their sync state."
          shape="rows"
        />
        <SectionPlaceholder
          title="Location voice override and notes"
          description="Whether this location writes differently, and the operational context behind its numbers."
          shape="lines"
        />
      </div>
    </PageBody>
  );
}
