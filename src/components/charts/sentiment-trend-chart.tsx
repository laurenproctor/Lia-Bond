"use client";

import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { ChartTooltipCard } from "@/components/charts/chart-tooltip";
import { formatDate } from "@/lib/format";
import type { OrganizationMetrics } from "@/lib/data/types";

type TrendPoint = OrganizationMetrics["sentimentTrend"][number];

/**
 * Sentiment over time.
 *
 * Three series on one axis — positive, neutral, negative — using the reserved
 * status colours rather than the categorical palette, because these are states
 * and not arbitrary categories. The legend lives in the chart container.
 */

const SERIES = [
  { key: "positive", label: "Positive", color: "var(--color-positive)" },
  { key: "neutral", label: "Neutral", color: "var(--color-neutral)" },
  { key: "negative", label: "Negative", color: "var(--color-negative)" },
] as const;

interface TooltipPayloadEntry {
  dataKey?: string | number;
  value?: number | string;
  color?: string;
}

interface TrendTooltipProps {
  active?: boolean;
  label?: string | number;
  payload?: TooltipPayloadEntry[];
}

function TrendTooltip({ active, label, payload }: TrendTooltipProps) {
  if (!active || !payload || payload.length === 0) return null;

  return (
    <ChartTooltipCard
      title={typeof label === "string" ? formatDate(label) : ""}
      rows={SERIES.map((series) => {
        const entry = payload.find((item) => item.dataKey === series.key);
        return {
          label: series.label,
          value: String(entry?.value ?? 0),
          color: series.color,
        };
      })}
    />
  );
}

export function SentimentTrendChart({ data }: { data: TrendPoint[] }) {
  return (
    <ResponsiveContainer width="100%" height="100%">
      <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: -18 }}>
        <defs>
          {SERIES.map((series) => (
            <linearGradient
              key={series.key}
              id={`lia-sentiment-${series.key}`}
              x1="0"
              y1="0"
              x2="0"
              y2="1"
            >
              <stop offset="0%" stopColor={series.color} stopOpacity={0.22} />
              <stop offset="100%" stopColor={series.color} stopOpacity={0.02} />
            </linearGradient>
          ))}
        </defs>

        <CartesianGrid
          vertical={false}
          stroke="var(--color-gray-200)"
          strokeDasharray="3 3"
        />
        <XAxis
          dataKey="date"
          tickFormatter={(value: string) => formatDate(value)}
          tickLine={false}
          axisLine={false}
          minTickGap={28}
          tick={{ fill: "var(--color-gray-500)", fontSize: 11 }}
        />
        <YAxis
          tickLine={false}
          axisLine={false}
          width={44}
          tick={{ fill: "var(--color-gray-500)", fontSize: 11 }}
        />
        <Tooltip
          content={<TrendTooltip />}
          cursor={{ stroke: "var(--color-gray-300)", strokeWidth: 1 }}
        />

        {SERIES.map((series) => (
          <Area
            key={series.key}
            type="monotone"
            dataKey={series.key}
            name={series.label}
            stroke={series.color}
            strokeWidth={2}
            fill={`url(#lia-sentiment-${series.key})`}
            activeDot={{ r: 4, strokeWidth: 2, stroke: "var(--color-white, #fff)" }}
            isAnimationActive={false}
          />
        ))}
      </AreaChart>
    </ResponsiveContainer>
  );
}
