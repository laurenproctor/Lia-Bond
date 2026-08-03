import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface DetailPanelProps {
  /** Sticky header region: source, author, primary link. */
  header?: ReactNode;
  children: ReactNode;
  /** Sticky footer region: the action row that must stay reachable. */
  footer?: ReactNode;
  className?: string;
  label?: string;
}

/**
 * The right-hand half of every split view.
 *
 * Scrolls independently of the queue so selecting a row never loses the
 * reader's place in the list, and pins the action row to the bottom so the
 * primary action stays visible without scrolling.
 */
export function DetailPanel({
  header,
  children,
  footer,
  className,
  label = "Selected item",
}: DetailPanelProps) {
  return (
    <section
      aria-label={label}
      className={cn("lia-card flex min-h-0 flex-col overflow-hidden", className)}
    >
      {header ? (
        <header className="shrink-0 border-b border-gray-200 px-5 py-3.5">
          {header}
        </header>
      ) : null}
      <div className="lia-scroll min-h-0 flex-1 overflow-y-auto px-5 py-4">
        {children}
      </div>
      {footer ? (
        <footer className="shrink-0 border-t border-gray-200 bg-white px-5 py-3">
          {footer}
        </footer>
      ) : null}
    </section>
  );
}

export function DetailSection({
  title,
  actions,
  children,
  className,
}: {
  title: string;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cn("border-t border-gray-200 pt-4 first:border-0 first:pt-0", className)}>
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[13px] font-semibold text-gray-950">{title}</h3>
        {actions}
      </div>
      <div className="mt-2">{children}</div>
    </section>
  );
}

/** Label-over-value pair used across detail panels and settings. */
export function DetailField({
  label,
  children,
  className,
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("min-w-0", className)}>
      <dt className="text-[12px] font-medium text-gray-500">{label}</dt>
      <dd className="mt-1 text-[13px] text-gray-950">{children}</dd>
    </div>
  );
}
