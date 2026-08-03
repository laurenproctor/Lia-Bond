import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface FilterBarProps {
  children: ReactNode;
  /** Right-aligned slot, typically a date range or sort control. */
  trailing?: ReactNode;
  className?: string;
  /** Accessible name for the group of controls. */
  label?: string;
}

export function FilterBar({
  children,
  trailing,
  className,
  label = "Filters",
}: FilterBarProps) {
  return (
    <section
      aria-label={label}
      className={cn(
        "flex flex-wrap items-center justify-between gap-x-3 gap-y-2",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 flex-wrap items-center gap-2">
        {children}
      </div>
      {trailing ? (
        <div className="flex shrink-0 items-center gap-2">{trailing}</div>
      ) : null}
    </section>
  );
}
