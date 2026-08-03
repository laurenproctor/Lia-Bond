"use client";

import { cn } from "@/lib/cn";

export interface TooltipRow {
  label: string;
  value: string;
  color?: string;
}

export interface ChartTooltipCardProps {
  title: string;
  rows: TooltipRow[];
  className?: string;
}

/** Shared tooltip surface so every chart in the app reads the same way. */
export function ChartTooltipCard({
  title,
  rows,
  className,
}: ChartTooltipCardProps) {
  return (
    <div
      className={cn(
        "rounded-lg border border-gray-200 bg-white px-3 py-2 shadow-raised",
        className,
      )}
    >
      <p className="text-[12px] font-semibold text-gray-950">{title}</p>
      <ul className="mt-1 space-y-0.5">
        {rows.map((row) => (
          <li
            key={row.label}
            className="flex items-center gap-2 text-[12px] text-gray-700"
          >
            {row.color ? (
              <span
                className="size-2 shrink-0 rounded-full"
                style={{ background: row.color }}
                aria-hidden
              />
            ) : null}
            <span className="flex-1 whitespace-nowrap">{row.label}</span>
            <span className="font-medium tabular-nums">{row.value}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}
