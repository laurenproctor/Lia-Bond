import type { ReactNode } from "react";
import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/cn";

export type BadgeTone =
  | "neutral"
  | "purple"
  | "green"
  | "amber"
  | "red"
  | "blue";

const TONE_CLASSES: Record<BadgeTone, string> = {
  neutral: "bg-gray-100 text-gray-700 ring-gray-200",
  purple: "bg-purple-100 text-purple-600 ring-purple-600/15",
  green: "bg-green-100 text-green-600 ring-green-600/15",
  amber: "bg-amber-100 text-amber-600 ring-amber-600/15",
  red: "bg-red-100 text-red-600 ring-red-600/15",
  blue: "bg-blue-100 text-blue-600 ring-blue-600/15",
};

export interface BadgeProps {
  children: ReactNode;
  tone?: BadgeTone;
  icon?: LucideIcon;
  className?: string;
}

/**
 * Low-level pill. Prefer `StatusBadge` or `SourceBadge` so the same domain
 * value never picks up two different colours on two screens.
 */
export function Badge({
  children,
  tone = "neutral",
  icon: Icon,
  className,
}: BadgeProps) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11.5px] leading-4 font-medium ring-1 ring-inset whitespace-nowrap",
        TONE_CLASSES[tone],
        className,
      )}
    >
      {Icon ? <Icon className="size-3 shrink-0" aria-hidden /> : null}
      {children}
    </span>
  );
}
