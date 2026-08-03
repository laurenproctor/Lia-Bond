import Link from "next/link";
import { ChevronRight } from "lucide-react";
import { ChartContainer } from "@/components/charts/chart-container";
import { SourceMixChart } from "@/components/charts/source-mix-chart";
import { SERIES_HEX } from "@/lib/chart-theme";
import { formatNumber, formatPercent } from "@/lib/format";
import type { OrganizationMetrics } from "@/lib/data/types";

type SourceMixEntry = OrganizationMetrics["sourceMix"][number];

export interface SourceMixCardProps {
  entries: SourceMixEntry[];
  total: number;
  className?: string;
}

/**
 * Share of mention volume by source.
 *
 * The list beside the donut carries the exact counts and shares, so the colours
 * only have to group — nobody has to read a value off an arc.
 */
export function SourceMixCard({ entries, total, className }: SourceMixCardProps) {
  return (
    <ChartContainer
      title="Source mix"
      hint="Share of mention volume by source for the selected period."
      height={168}
      className={className}
      summary={`Source mix for ${formatNumber(total)} mentions: ${entries
        .map((entry) => `${entry.label} ${formatNumber(entry.count)}`)
        .join(", ")}.`}
      footer={
        <>
          <ul className="space-y-1.5">
            {entries.map((entry, index) => (
              <li
                key={entry.platform}
                className="flex items-center gap-2 text-[12.5px]"
              >
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: SERIES_HEX[index % SERIES_HEX.length] }}
                  aria-hidden
                />
                <span className="min-w-0 flex-1 truncate text-gray-700">
                  {entry.label}
                </span>
                <span className="shrink-0 font-medium text-gray-950 tabular-nums">
                  {formatNumber(entry.count)}
                </span>
                <span className="w-14 shrink-0 text-right text-gray-500 tabular-nums">
                  {formatPercent(entry.share, 1)}
                </span>
              </li>
            ))}
          </ul>
          <Link
            href="/insights"
            className="mt-3 inline-flex items-center gap-0.5 text-[13px] font-medium text-purple-600 hover:underline"
          >
            View all sources
            <ChevronRight className="size-3.5" aria-hidden />
          </Link>
        </>
      }
    >
      <SourceMixChart data={entries} total={total} />
    </ChartContainer>
  );
}
