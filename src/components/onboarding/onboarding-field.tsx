"use client";

import type { ComponentProps, ReactNode } from "react";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * Form fields for the wizard.
 *
 * Every one of them:
 *
 * - has a real `<label htmlFor>`, never a placeholder standing in for one — a
 *   placeholder disappears the moment somebody types, which is exactly when
 *   they are most likely to want to check what they are filling in;
 * - names its own error through `aria-describedby` and sets `aria-invalid`, so
 *   the message is announced with the field rather than found by hunting;
 * - marks required fields with `required` *and* a visible asterisk carrying a
 *   screen-reader word, because a red star is a colour-only signal on its own;
 * - uses `site-field` (#8296b4) for the border rather than the ornamental
 *   `site-border` (#e6eaf0), which measures 1.21:1 against white and fails WCAG
 *   1.4.11 for a control boundary.
 */

function RequiredMark() {
  return (
    <>
      <span aria-hidden className="ml-0.5 text-red-600">
        *
      </span>
      <span className="sr-only"> (required)</span>
    </>
  );
}

function FieldFrame({
  id,
  label,
  hint,
  error,
  required,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  required?: boolean;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <label htmlFor={id} className="text-[13.5px] font-semibold text-site-ink">
        {label}
        {required ? <RequiredMark /> : null}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="text-[12.5px] font-medium text-red-600">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="text-[12.5px] text-site-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * The ids a field points `aria-describedby` at.
 *
 * The error wins when both exist: a hint that is still being announced beside a
 * failure it does not explain is noise at the worst moment.
 */
function describedBy(id: string, hint?: string, error?: string): string | undefined {
  if (error) return `${id}-error`;
  if (hint) return `${id}-hint`;
  return undefined;
}

const CONTROL_CLASSES =
  "min-h-[46px] w-full rounded-xl border bg-white px-3.5 text-[15px] text-site-ink " +
  "placeholder:text-site-muted transition-colors focus:border-site-blue focus:outline-none";

export function OnboardingTextField({
  id,
  label,
  hint,
  error,
  ...props
}: ComponentProps<"input"> & {
  id: string;
  label: string;
  hint?: string;
  error?: string;
}) {
  return (
    <FieldFrame
      id={id}
      label={label}
      hint={hint}
      error={error}
      required={props.required}
    >
      <input
        {...props}
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy(id, hint, error)}
        className={cn(
          CONTROL_CLASSES,
          error ? "border-red-600" : "border-site-field",
        )}
      />
    </FieldFrame>
  );
}

export interface SelectOption {
  value: string;
  label: string;
}

export function OnboardingSelectField({
  id,
  label,
  hint,
  error,
  options,
  placeholder,
  ...props
}: ComponentProps<"select"> & {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  options: readonly SelectOption[];
  /** Rendered as a disabled empty-value option, so it cannot be submitted. */
  placeholder?: string;
}) {
  return (
    <FieldFrame
      id={id}
      label={label}
      hint={hint}
      error={error}
      required={props.required}
    >
      <div className="relative">
        <select
          {...props}
          id={id}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy(id, hint, error)}
          className={cn(
            CONTROL_CLASSES,
            // Room for the chevron, which is decorative and sits on top.
            "appearance-none pr-10",
            error ? "border-red-600" : "border-site-field",
          )}
        >
          {placeholder ? (
            <option value="" disabled>
              {placeholder}
            </option>
          ) : null}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <ChevronDown
          className="pointer-events-none absolute top-1/2 right-3.5 size-[18px] -translate-y-1/2 text-site-body"
          strokeWidth={2}
          aria-hidden
        />
      </div>
    </FieldFrame>
  );
}
