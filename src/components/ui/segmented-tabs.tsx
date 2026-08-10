"use client";

import { useId, useState } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface SegmentedTab {
  id: string;
  label: string;
  count?: number;
  icon?: ReactNode;
}

export interface SegmentedTabsProps {
  tabs: SegmentedTab[];
  defaultTabId?: string;
  /**
   * Controls the active tab from outside (e.g. a URL search param). When
   * provided, this wins over internal state — the internal `useState` still
   * updates on click, but harmlessly, since the controlled value takes over
   * on the next render.
   */
  activeTabId?: string;
  onChange?: (tabId: string) => void;
  /** `pills` for source tabs, `chips` for the lighter status row beneath. */
  variant?: "pills" | "chips";
  label: string;
  className?: string;
}

/**
 * Roving-focus tab strip.
 *
 * Follows the ARIA tabs pattern: arrow keys move between tabs, Home and End
 * jump to the ends, and only the selected tab is in the tab order.
 */
export function SegmentedTabs({
  tabs,
  defaultTabId,
  activeTabId,
  onChange,
  variant = "pills",
  label,
  className,
}: SegmentedTabsProps) {
  const baseId = useId();
  const [internalActiveId, setInternalActiveId] = useState(defaultTabId ?? tabs[0]?.id ?? "");
  const activeId = activeTabId ?? internalActiveId;

  function select(id: string) {
    setInternalActiveId(id);
    onChange?.(id);
  }

  function handleKeyDown(event: React.KeyboardEvent<HTMLDivElement>) {
    const index = tabs.findIndex((tab) => tab.id === activeId);
    if (index < 0) return;

    let nextIndex: number | null = null;
    if (event.key === "ArrowRight") nextIndex = (index + 1) % tabs.length;
    if (event.key === "ArrowLeft") nextIndex = (index - 1 + tabs.length) % tabs.length;
    if (event.key === "Home") nextIndex = 0;
    if (event.key === "End") nextIndex = tabs.length - 1;
    if (nextIndex === null) return;

    event.preventDefault();
    const next = tabs[nextIndex];
    if (!next) return;
    select(next.id);
    document.getElementById(`${baseId}-${next.id}`)?.focus();
  }

  return (
    <div
      role="tablist"
      aria-label={label}
      onKeyDown={handleKeyDown}
      className={cn("flex flex-wrap items-center gap-2", className)}
    >
      {tabs.map((tab) => {
        const active = tab.id === activeId;
        return (
          <button
            key={tab.id}
            id={`${baseId}-${tab.id}`}
            role="tab"
            type="button"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => select(tab.id)}
            className={cn(
              "inline-flex items-center gap-1.5 font-medium whitespace-nowrap transition-colors",
              variant === "pills"
                ? "h-9 rounded-lg border px-3 text-[13px]"
                : "h-7 rounded-md border px-2.5 text-[12.5px]",
              active
                ? "border-purple-600 bg-purple-100 text-purple-600"
                : "border-gray-200 bg-white text-gray-700 hover:bg-gray-50 hover:text-gray-950",
            )}
          >
            {tab.icon}
            {tab.label}
            {typeof tab.count === "number" ? (
              <span
                className={cn(
                  "rounded px-1 text-[11.5px] font-semibold tabular-nums",
                  active ? "bg-white/70 text-purple-600" : "bg-gray-100 text-gray-500",
                )}
              >
                {tab.count}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}
