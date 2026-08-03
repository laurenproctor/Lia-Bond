import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { Circle } from "lucide-react";
import { cn } from "@/lib/cn";

export type TimelineTone = "neutral" | "purple" | "green" | "amber" | "red";

const TONE_CLASSES: Record<TimelineTone, string> = {
  neutral: "bg-gray-100 text-gray-500 ring-gray-200",
  purple: "bg-purple-100 text-purple-600 ring-purple-600/15",
  green: "bg-green-100 text-green-600 ring-green-600/15",
  amber: "bg-amber-100 text-amber-600 ring-amber-600/15",
  red: "bg-red-100 text-red-600 ring-red-600/15",
};

export interface TimelineEntry {
  id: string;
  title: string;
  detail?: ReactNode;
  meta?: string;
  timestamp: string;
  icon?: LucideIcon;
  tone?: TimelineTone;
}

export interface TimelineProps {
  entries: TimelineEntry[];
  /** `vertical` for audit trails, `horizontal` for a short response history. */
  orientation?: "vertical" | "horizontal";
  className?: string;
}

export function Timeline({
  entries,
  orientation = "vertical",
  className,
}: TimelineProps) {
  if (orientation === "horizontal") {
    return (
      <ol
        className={cn(
          "lia-scroll flex items-start gap-3 overflow-x-auto pb-1",
          className,
        )}
      >
        {entries.map((entry, index) => {
          const Icon = entry.icon ?? Circle;
          return (
            <li
              key={entry.id}
              className="flex min-w-[9.5rem] flex-1 items-start gap-2.5"
            >
              <span
                className={cn(
                  "inline-flex size-7 shrink-0 items-center justify-center rounded-full ring-1 ring-inset",
                  TONE_CLASSES[entry.tone ?? "neutral"],
                )}
              >
                <Icon className="size-3.5" aria-hidden />
              </span>
              <div className="min-w-0">
                <p className="text-[13px] font-medium text-gray-950">
                  {entry.title}
                </p>
                {entry.meta ? (
                  <p className="truncate text-[12px] text-gray-500">{entry.meta}</p>
                ) : null}
                <p className="text-[12px] text-gray-400">{entry.timestamp}</p>
              </div>
              {index < entries.length - 1 ? (
                <span
                  className="mt-3.5 hidden h-px flex-1 border-t border-dashed border-gray-300 md:block"
                  aria-hidden
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    );
  }

  return (
    <ol className={cn("relative", className)}>
      {entries.map((entry, index) => {
        const Icon = entry.icon ?? Circle;
        const last = index === entries.length - 1;
        return (
          <li key={entry.id} className="relative flex gap-3 pb-4 last:pb-0">
            {!last ? (
              <span
                className="absolute top-8 bottom-1 left-[13px] w-px bg-gray-200"
                aria-hidden
              />
            ) : null}
            <span
              className={cn(
                "relative inline-flex size-7 shrink-0 items-center justify-center rounded-full ring-1 ring-inset",
                TONE_CLASSES[entry.tone ?? "neutral"],
              )}
            >
              <Icon className="size-3.5" aria-hidden />
            </span>
            <div className="min-w-0 flex-1 pt-0.5">
              <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                <p className="text-[13px] font-medium text-gray-950">
                  {entry.title}
                </p>
                <p className="shrink-0 text-[12px] text-gray-400">
                  {entry.timestamp}
                </p>
              </div>
              {entry.meta ? (
                <p className="text-[12.5px] text-gray-500">{entry.meta}</p>
              ) : null}
              {entry.detail ? (
                <div className="mt-1 text-[12.5px] text-gray-700">
                  {entry.detail}
                </div>
              ) : null}
            </div>
          </li>
        );
      })}
    </ol>
  );
}
