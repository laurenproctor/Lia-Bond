"use client";

import { Cell, Pie, PieChart, ResponsiveContainer, Tooltip } from "recharts";
import { ChartTooltipCard } from "@/components/charts/chart-tooltip";
import { SERIES_COLORS } from "@/lib/chart-theme";
import { formatNumber, formatPercent } from "@/lib/format";
import type { OrganizationMetrics } from "@/lib/data/types";

type SourceMixEntry = OrganizationMetrics["sourceMix"][number];

interface TooltipPayloadEntry {
  name?: string | number;
  value?: number | string;
  payload?: SourceMixEntry;
}

interface MixTooltipProps {
  active?: boolean;
  payload?: TooltipPayloadEntry[];
}

function MixTooltip({ active, payload }: MixTooltipProps) {
  const entry = payload?.[0]?.payload;
  if (!active || !entry) return null;

  return (
    <ChartTooltipCard
      title={entry.label}
      rows={[
        { label: "Mentions", value: formatNumber(entry.count) },
        { label: "Share", value: formatPercent(entry.share, 1) },
      ]}
    />
  );
}

export interface SourceMixChartProps {
  data: SourceMixEntry[];
  total: number;
}

/**
 * Share of mention volume by source.
 *
 * A donut is defensible here because there are five parts of one whole and the
 * exact values are always read from the labelled list beside it, never from the
 * arc lengths.
 */
export function SourceMixChart({ data, total }: SourceMixChartProps) {
  return (
    <div className="relative h-full w-full">
      <ResponsiveContainer width="100%" height="100%">
        <PieChart>
          <Tooltip content={<MixTooltip />} />
          <Pie
            data={data}
            dataKey="count"
            nameKey="label"
            innerRadius="62%"
            outerRadius="94%"
            paddingAngle={2}
            stroke="var(--color-white, #fff)"
            strokeWidth={2}
            isAnimationActive={false}
          >
            {data.map((entry, index) => (
              <Cell
                key={entry.platform}
                fill={SERIES_COLORS[index % SERIES_COLORS.length]}
              />
            ))}
          </Pie>
        </PieChart>
      </ResponsiveContainer>

      <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
        <span className="text-[20px] leading-6 font-semibold text-gray-950 tabular-nums">
          {formatNumber(total)}
        </span>
        <span className="text-[11.5px] text-gray-500">Total</span>
      </div>
    </div>
  );
}
