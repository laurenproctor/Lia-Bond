import type { ReactNode } from "react";
import { cn } from "@/lib/cn";
import {
  SourceStatusBadge,
  type SourceStatus,
} from "@/components/onboarding/source-status-badge";

/**
 * The frame every step-2 source shares.
 *
 * One place for the surface — border, radius, spacing, the glyph-title-badge
 * header row — so Google, News & Media, and Reddit read as three of a kind
 * even though their bodies differ completely. Each card is an `<article>`
 * with an `h3`: the page's `h1` is the aside headline and the working card's
 * title is the `h2`, so the sources sit one level beneath it.
 *
 * `footer` is pinned to the bottom with `mt-auto`, which is what keeps three
 * action buttons on one line across the grid without forcing the three
 * bodies to identical heights through padding tricks.
 */
export function OnboardingSourceCard({
  glyph,
  title,
  status,
  children,
  footer,
  className,
}: {
  glyph: ReactNode;
  title: string;
  status: SourceStatus;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}) {
  return (
    <article
      className={cn(
        "flex min-w-0 flex-col gap-3 rounded-2xl border border-site-border bg-white p-4 sm:p-5",
        className,
      )}
    >
      <div className="flex flex-col gap-2.5">
        {glyph}
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-[15.5px] font-bold text-site-ink">{title}</h3>
          <SourceStatusBadge status={status} />
        </div>
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-3">{children}</div>
      {footer ? <div className="mt-auto pt-1">{footer}</div> : null}
    </article>
  );
}
