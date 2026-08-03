import { ArrowDownRight, ArrowUpRight } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Sparkline } from "@/components/charts/sparkline";
import { cn } from "@/lib/cn";
import { formatSignedPercent } from "@/lib/format";
import type { Kpi } from "@/lib/view-models/kpi";

export interface KpiCardProps {
  kpi: Kpi;
  icon?: LucideIcon;
  /** Tints the icon chip; use sparingly to mark the metric that needs work. */
  accent?: "neutral" | "purple" | "green" | "amber" | "red" | "blue";
  className?: string;
}

const ACCENT_CLASSES = {
  neutral: "bg-gray-100 text-gray-700",
  purple: "bg-purple-100 text-purple-600",
  green: "bg-green-100 text-green-600",
  amber: "bg-amber-100 text-amber-600",
  red: "bg-red-100 text-red-600",
  blue: "bg-blue-100 text-blue-600",
} as const;

export function KpiCard({
  kpi,
  icon: Icon,
  accent = "neutral",
  className,
}: KpiCardProps) {
  const { trend } = kpi;
  const rising = trend.changePercent > 0;
  const flat = trend.changePercent === 0;
  const good = flat ? null : rising === trend.higherIsBetter;
  const tone = good === null ? "neutral" : good ? "good" : "bad";
  const DirectionIcon = rising ? ArrowUpRight : ArrowDownRight;

  return (
    <article className={cn("lia-card p-4", className)}>
      <div className="flex items-center gap-2">
        {Icon ? (
          <span
            className={cn(
              "inline-flex size-7 shrink-0 items-center justify-center rounded-lg",
              ACCENT_CLASSES[accent],
            )}
          >
            <Icon className="size-4" aria-hidden />
          </span>
        ) : null}
        {/* Two lines rather than an ellipsis: a truncated metric name is
            unreadable, and every card in the row keeps the same height. */}
        <h3 className="line-clamp-2 min-w-0 text-[13px] leading-4 font-medium text-gray-700">
          {kpi.label}
        </h3>
      </div>

      <div className="mt-2.5 flex items-end justify-between gap-2">
        <p className="min-w-0 text-[26px] leading-8 font-semibold tracking-tight text-gray-950">
          {kpi.value}
        </p>
        <Sparkline points={trend.points} tone={tone} className="mb-1.5" />
      </div>

      <p className="mt-2 flex items-center gap-1.5 text-[12px] whitespace-nowrap">
        {flat ? (
          <span className="font-medium text-gray-500">No change</span>
        ) : (
          <span
            className={cn(
              "inline-flex items-center gap-0.5 font-semibold",
              good ? "text-green-600" : "text-red-600",
            )}
          >
            <DirectionIcon className="size-3.5" aria-hidden />
            {formatSignedPercent(trend.changePercent)}
          </span>
        )}
        <span className="min-w-0 truncate text-gray-500">
          {trend.comparisonLabel}
        </span>
      </p>
    </article>
  );
}
