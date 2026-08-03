import type { ReactNode } from "react";
import { cn } from "@/lib/cn";

export interface CardProps {
  children: ReactNode;
  className?: string;
  /** Removes the default padding so the card can hold a flush table or list. */
  flush?: boolean;
}

export function Card({ children, className, flush = false }: CardProps) {
  return (
    <section className={cn("lia-card flex min-w-0 flex-col", flush ? "" : "p-5", className)}>
      {children}
    </section>
  );
}

export interface CardHeaderProps {
  title: ReactNode;
  description?: ReactNode;
  /** Tooltip-style hint rendered next to the title. */
  hint?: string;
  actions?: ReactNode;
  className?: string;
}

export function CardHeader({
  title,
  description,
  hint,
  actions,
  className,
}: CardHeaderProps) {
  return (
    <header
      className={cn(
        "flex flex-wrap items-start justify-between gap-3",
        className,
      )}
    >
      <div className="min-w-0">
        <h2 className="flex items-center gap-1.5 text-[15px] leading-6 font-semibold text-gray-950">
          <span className="truncate">{title}</span>
          {hint ? (
            <span
              className="inline-flex size-4 shrink-0 items-center justify-center rounded-full border border-gray-300 text-[10px] font-semibold text-gray-500"
              title={hint}
              aria-label={hint}
              role="img"
            >
              i
            </span>
          ) : null}
        </h2>
        {description ? (
          <p className="mt-0.5 text-[13px] text-gray-500">{description}</p>
        ) : null}
      </div>
      {actions ? (
        <div className="flex shrink-0 items-center gap-2">{actions}</div>
      ) : null}
    </header>
  );
}

export function CardFooter({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <footer
      className={cn(
        "mt-auto flex items-center justify-between gap-3 border-t border-gray-200 px-5 py-3 text-[13px]",
        className,
      )}
    >
      {children}
    </footer>
  );
}
