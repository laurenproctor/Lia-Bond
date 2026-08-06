"use client";

import Link from "next/link";
import type { ComponentProps, ReactNode } from "react";
import { AlertTriangle, ArrowRight, Lock } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Buttons, links, and feedback for the wizard.
 *
 * Every interactive element here is at least 44px tall. That is the touch
 * target minimum, and it is not negotiable on this flow specifically: setup is
 * frequently finished on a phone, one-handed, by somebody who has had the
 * product for four minutes and will not persevere through a mis-tap.
 *
 * The primary is orange with **ink** text, not white. White on `site-orange`
 * measures 2.60:1 — below AA and below even the 3:1 large-text floor — and
 * darkening the orange would replace the brand colour on every primary action
 * in the product. `tests/site-palette.test.ts` holds that pairing in place for
 * the marketing site and the same reasoning applies here.
 */

type ButtonProps = Omit<ComponentProps<"button">, "className">;

export function PrimaryAction({
  children,
  pending,
  pendingLabel,
  icon = true,
  ...props
}: ButtonProps & {
  children: ReactNode;
  pending?: boolean;
  pendingLabel?: string;
  icon?: boolean;
}) {
  return (
    <button
      {...props}
      // `aria-disabled` rather than `disabled` while pending: a disabled button
      // loses focus, and a keyboard user who pressed Enter would be dropped to
      // the top of the document mid-submit. The handler is what actually
      // refuses the second press.
      aria-disabled={pending || props.disabled ? true : undefined}
      disabled={props.disabled}
      className={cn(
        "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl px-6 py-3",
        "bg-site-orange text-[15px] font-bold text-site-ink transition-colors",
        "hover:bg-site-orange-hover",
        "disabled:cursor-not-allowed disabled:opacity-60",
        pending && "cursor-progress opacity-80",
      )}
    >
      {pending ? (pendingLabel ?? "Saving…") : children}
      {icon && !pending ? (
        <ArrowRight className="size-[18px] shrink-0" strokeWidth={2.4} aria-hidden />
      ) : null}
    </button>
  );
}

export function SecondaryAction({
  children,
  ...props
}: ButtonProps & { children: ReactNode }) {
  return (
    <button
      {...props}
      className={cn(
        "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl px-5 py-3",
        "border border-site-blue-edge bg-white text-[15px] font-semibold text-site-blue",
        "transition-colors hover:bg-site-blue-tint",
        "disabled:cursor-not-allowed disabled:opacity-60",
      )}
    >
      {children}
    </button>
  );
}

/** The same treatment as `SecondaryAction`, for a real navigation. */
export function SecondaryLink({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={cn(
        "inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl px-5 py-3",
        "border border-site-blue-edge bg-white text-[15px] font-semibold text-site-blue",
        "transition-colors hover:bg-site-blue-tint",
        className,
      )}
    >
      {children}
    </Link>
  );
}

/**
 * The quiet third option — "Skip for now", "Continue without connecting".
 *
 * A text button rather than an outlined one, deliberately. Skipping is a real
 * choice and it stays reachable, but the visual direction is explicit that it
 * must not read as the primary path.
 */
export function TertiaryAction({
  children,
  ...props
}: ButtonProps & { children: ReactNode }) {
  return (
    <button
      {...props}
      className={cn(
        "inline-flex min-h-[44px] items-center justify-center rounded-xl px-3 py-3",
        "text-[14px] font-semibold text-site-blue underline-offset-4 transition-colors",
        "hover:underline disabled:cursor-not-allowed disabled:opacity-60",
      )}
    >
      {children}
    </button>
  );
}

/** The action row: primary right, secondary left, wrapping on narrow screens. */
export function OnboardingActions({
  primary,
  secondary,
  tertiary,
  note,
}: {
  primary: ReactNode;
  secondary?: ReactNode;
  tertiary?: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          {secondary}
          {tertiary}
        </div>
        <div className="flex justify-end">{primary}</div>
      </div>
      {note ? (
        <p className="flex items-center justify-end gap-2 text-[12.5px] text-site-muted">
          <Lock className="size-3.5 shrink-0" aria-hidden />
          {note}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A failure the person has to read.
 *
 * `role="alert"` so it is announced when it appears, and it is rendered *above*
 * the action row rather than beside it, because an error that only appears
 * below the fold is an error nobody sees.
 */
export function OnboardingError({ children }: { children: ReactNode }) {
  return (
    <div
      role="alert"
      className="flex gap-3 rounded-xl border border-red-600/30 bg-red-100 px-4 py-3 text-[13.5px] text-red-600"
    >
      <AlertTriangle className="mt-0.5 size-[18px] shrink-0" strokeWidth={2} aria-hidden />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

/**
 * The summary shown after a validation failure.
 *
 * Exists because a form with nine fields can put its first error off-screen.
 * Each entry is a real anchor to the field it names, so a keyboard user reaches
 * the problem in one press rather than tabbing back through the form.
 */
export function OnboardingErrorSummary({
  errors,
  labels,
}: {
  errors: Record<string, string>;
  /** Field name → its visible label, so the summary reads like the form. */
  labels: Record<string, string>;
}) {
  const entries = Object.entries(errors).filter(([field]) => field !== "form");
  if (entries.length === 0) return null;

  return (
    <div
      role="alert"
      // Focusable so the submit handler can move focus here, which is what
      // makes the summary useful rather than decorative.
      tabIndex={-1}
      id="onboarding-error-summary"
      className="rounded-xl border border-red-600/30 bg-red-100 px-4 py-3"
    >
      <p className="text-[13.5px] font-semibold text-red-600">
        {entries.length === 1
          ? "There is a problem with one field."
          : `There are problems with ${entries.length} fields.`}
      </p>
      <ul className="mt-2 flex flex-col gap-1">
        {entries.map(([field, message]) => (
          <li key={field}>
            <a
              href={`#${field}`}
              className="text-[13px] text-red-600 underline underline-offset-2"
            >
              {labels[field] ?? field}: {message}
            </a>
          </li>
        ))}
      </ul>
    </div>
  );
}
