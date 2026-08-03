import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import { Skeleton } from "@/components/ui/skeleton";

export interface SectionPlaceholderProps {
  /** The module name from `docs/screens.md`. */
  title: string;
  description?: string;
  /** Shape of the placeholder body, so the layout reads at the right density. */
  shape?: "lines" | "rows" | "chart" | "grid";
  className?: string;
  children?: ReactNode;
}

/**
 * A named region of a screen that is laid out but not yet built.
 *
 * These exist so the route structure, spacing and responsive behaviour can be
 * reviewed before the modules land. Each one names the module it stands in for
 * rather than showing an anonymous grey box.
 */
export function SectionPlaceholder({
  title,
  description,
  shape = "lines",
  className,
  children,
}: SectionPlaceholderProps) {
  return (
    <section
      className={cn(
        "rounded-card flex min-w-0 flex-col border border-dashed border-gray-300 bg-white p-5",
        className,
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h2 className="text-[15px] leading-6 font-semibold text-gray-950">
            {title}
          </h2>
          {description ? (
            <p className="mt-0.5 text-[13px] text-gray-500">{description}</p>
          ) : null}
        </div>
        <span className="shrink-0 rounded-md bg-gray-100 px-1.5 py-0.5 text-[11px] font-medium text-gray-500">
          Not built yet
        </span>
      </div>

      <div className="mt-4 flex-1">
        {children ?? <PlaceholderShape shape={shape} />}
      </div>
    </section>
  );
}

function PlaceholderShape({
  shape,
}: {
  shape: NonNullable<SectionPlaceholderProps["shape"]>;
}) {
  // Heights are fixed rather than random so the placeholder is stable between
  // renders and in screenshots.
  if (shape === "chart") {
    return (
      <div className="flex h-40 items-end gap-2" aria-hidden>
        {[38, 62, 48, 74, 56, 88, 66, 94].map((height, index) => (
          <span key={index} className="flex flex-1 items-end">
            <Skeleton
              className="w-full rounded-t-md"
              style={{ height: `${height}%` }}
            />
          </span>
        ))}
      </div>
    );
  }

  if (shape === "rows") {
    return (
      <div className="space-y-3" aria-hidden>
        {[0, 1, 2, 3].map((row) => (
          <div key={row} className="flex items-center gap-3">
            <Skeleton className="size-7 rounded-lg" />
            <Skeleton className="h-3 flex-1" />
            <Skeleton className="h-5 w-16 rounded-md" />
          </div>
        ))}
      </div>
    );
  }

  if (shape === "grid") {
    return (
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3" aria-hidden>
        {[0, 1, 2, 3, 4, 5].map((cell) => (
          <Skeleton key={cell} className="h-16 rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-2.5" aria-hidden>
      <Skeleton className="h-3 w-full" />
      <Skeleton className="h-3 w-11/12" />
      <Skeleton className="h-3 w-3/4" />
    </div>
  );
}
