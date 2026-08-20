import Link from "next/link";
import { ChevronRight, Star } from "lucide-react";
import { Card, CardFooter, CardHeader } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { ProgressBar } from "@/components/ui/progress-bar";
import { SentimentBadge } from "@/components/ui/status-badge";
import { formatNumber, formatPercent, formatRating } from "@/lib/format";
import type { Location } from "@/domain";
import type { LocationMetrics } from "@/lib/data/types";

/** A location joined to its computed metrics — the row shape this table renders. */
export interface LocationRow {
  location: Location;
  metrics: LocationMetrics;
}

const COLUMNS: DataTableColumn<LocationRow>[] = [
  {
    id: "location",
    header: "Location",
    cell: (row) => (
      <Link
        href="/locations"
        className="font-medium text-gray-950 hover:text-purple-600 hover:underline"
      >
        {row.location.name}
      </Link>
    ),
  },
  {
    id: "sentiment",
    header: "Sentiment",
    cell: (row) => <SentimentBadge sentiment={row.metrics.sentiment} />,
  },
  {
    id: "volume",
    header: "Mention volume",
    align: "right",
    cell: (row) => (
      <span className="tabular-nums">{formatNumber(row.metrics.mentionVolume)}</span>
    ),
  },
  {
    id: "rating",
    header: "Avg. rating",
    align: "right",
    cell: (row) =>
      row.metrics.averageRating === null ? (
        <span className="text-gray-400">—</span>
      ) : (
        <span className="inline-flex items-center gap-1 tabular-nums">
          {formatRating(row.metrics.averageRating)}
          <Star className="size-3.5 fill-amber-600 text-amber-600" aria-hidden />
        </span>
      ),
  },
  {
    id: "coverage",
    header: "Response coverage",
    secondary: true,
    cell: (row) => (
      <span className="flex items-center gap-2">
        <span className="w-9 shrink-0 text-right tabular-nums">
          {formatPercent(row.metrics.responseCoveragePercent)}
        </span>
        <ProgressBar
          value={row.metrics.responseCoveragePercent}
          tone={row.metrics.responseCoveragePercent >= 80 ? "green" : "amber"}
          label={`Response coverage at ${row.location.name}`}
          className="max-w-24"
        />
      </span>
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

export function LocationComparisonCard({
  rows,
  className,
}: {
  rows: LocationRow[];
  className?: string;
}) {
  return (
    <Card flush className={className}>
      <CardHeader
        className="p-5 pb-3"
        title="Location comparison"
        hint="Active locations only. Locations still onboarding, and retired ones, are excluded."
        actions={
          <Link
            href="/locations"
            className="text-[13px] font-medium text-purple-600 hover:underline"
          >
            View all locations
          </Link>
        }
      />
      <DataTable
        caption="Reputation metrics by location"
        columns={COLUMNS}
        rows={rows}
        rowKey={(row) => row.location.id}
        emptyTitle="No active locations"
        emptyDescription="Connect a location profile to start comparing performance."
      />
      <CardFooter>
        <span className="text-gray-500">
          {rows.length} active {rows.length === 1 ? "location" : "locations"}
        </span>
        <Link
          href="/locations"
          className="inline-flex items-center gap-0.5 font-medium text-purple-600 hover:underline"
        >
          Compare all locations
          <ChevronRight className="size-3.5" aria-hidden />
        </Link>
      </CardFooter>
    </Card>
  );
}
