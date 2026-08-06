import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Info } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * The white working card, and the pieces that go inside it.
 *
 * One place for the surface treatment — radius, border, shadow, padding — so
 * seven screens cannot drift into seven slightly different cards.
 */

export function OnboardingCard({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-[20px] border border-site-border bg-white p-5 sm:p-7 lg:p-8",
        "shadow-[0_10px_30px_-18px_rgb(11_15_24/0.25)]",
        className,
      )}
    >
      {children}
    </section>
  );
}

/**
 * The card's own title.
 *
 * An `h2`: the page's `h1` is the headline in the contextual panel, and two
 * `h1`s would leave a screen-reader user with no way to tell which one is the
 * page. The icon is decorative — the title beside it says the same thing.
 */
export function OnboardingStepHeader({
  icon: Icon,
  title,
  description,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
}) {
  return (
    <div className="flex items-start gap-4">
      <span className="hidden size-12 shrink-0 items-center justify-center rounded-full bg-site-blue-tint sm:flex">
        <Icon className="size-6 text-site-blue" strokeWidth={1.7} aria-hidden />
      </span>
      <div className="min-w-0">
        <h2 className="text-[21px] leading-tight font-bold tracking-[-0.01em] text-site-ink sm:text-[24px]">
          {title}
        </h2>
        <p className="mt-1.5 max-w-[56ch] text-[14px] leading-relaxed text-site-body">
          {description}
        </p>
      </div>
    </div>
  );
}

/**
 * The pale blue information panel.
 *
 * Reassurance, never a warning and never an error — those have their own
 * treatments in `onboarding-feedback.tsx`, because collapsing them into one
 * blue box is how a failed save comes to look like a helpful tip.
 */
export function OnboardingNote({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="flex gap-3 rounded-xl border border-site-blue-edge bg-site-blue-tint px-4 py-3.5">
      <Info
        className="mt-0.5 size-[18px] shrink-0 text-site-blue"
        strokeWidth={2}
        aria-hidden
      />
      <div className="min-w-0">
        <p className="text-[13.5px] font-semibold text-site-blue">{title}</p>
        <div className="mt-1 text-[13px] leading-relaxed text-site-blue-ink">
          {children}
        </div>
      </div>
    </div>
  );
}

/**
 * A completed-setup line: a green tick, a label, and a value.
 *
 * The tick is accompanied by the word "done" for screen readers, so completion
 * is never carried by the colour of a glyph alone.
 */
export function OnboardingStatusItem({
  label,
  value,
  done,
}: {
  label: string;
  value: string;
  /** False renders the neutral treatment — a step that was skipped, say. */
  done: boolean;
}) {
  return (
    <li className="flex items-start gap-2.5">
      <span
        className={cn(
          "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[11px] font-bold",
          done ? "bg-green-100 text-green-600" : "bg-site-tint text-site-muted",
        )}
        aria-hidden
      >
        {done ? "✓" : "–"}
      </span>
      <span className="min-w-0 text-[13px] leading-snug">
        <span className="block font-semibold text-site-ink">{label}</span>
        <span className="block text-site-body">{value}</span>
        <span className="sr-only">{done ? "Done." : "Not done."}</span>
      </span>
    </li>
  );
}
