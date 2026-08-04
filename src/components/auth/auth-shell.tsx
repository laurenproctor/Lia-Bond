import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Logo } from "@/components/shell/logo";

/**
 * The frame every signed-out screen shares.
 *
 * Extracted once there was a second one. Sign-in, forgot-password, and
 * reset-password are the same card on the same navy field, and three copies
 * would have drifted the moment one of them was touched.
 */
export function AuthShell({
  title,
  description,
  children,
  footer,
}: {
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}) {
  return (
    <main
      id="main"
      className="flex min-h-dvh flex-col items-center justify-center bg-navy-900 px-4 py-10"
    >
      <div className="w-full max-w-[26rem]">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <Logo />
          <p className="text-[13px] text-white/60">
            Reputation intelligence for restaurants
          </p>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
          <h1 className="text-[17px] font-semibold text-gray-950">{title}</h1>
          <p className="mt-1 mb-5 text-[13px] text-gray-500">{description}</p>
          {children}
        </div>

        {footer ? <div className="mt-4 text-center">{footer}</div> : null}
      </div>
    </main>
  );
}

/** Shared field styling, so the forms cannot drift apart. */
export const AUTH_INPUT_CLASS =
  "h-11 w-full rounded-[10px] border border-gray-300 bg-white px-3.5 text-[14px] text-gray-950 outline-none focus-visible:border-purple-600 focus-visible:ring-2 focus-visible:ring-purple-600/20";

/**
 * A labelled field.
 *
 * `htmlFor` and `id` are bound to the same name rather than passed separately,
 * because the failure mode of getting that wrong is silent: the label still
 * renders, still looks correct, and no longer moves focus or reads out to a
 * screen reader.
 */
export function AuthField({
  name,
  label,
  type = "text",
  autoComplete,
  hint,
  defaultValue,
  readOnly,
  autoFocus,
  required = true,
  minLength,
}: {
  name: string;
  label: string;
  type?: string;
  autoComplete?: string;
  hint?: string;
  defaultValue?: string;
  readOnly?: boolean;
  autoFocus?: boolean;
  required?: boolean;
  minLength?: number;
}) {
  const hintId = hint ? `${name}-hint` : undefined;

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={name} className="text-[13px] font-medium text-gray-950">
        {label}
      </label>
      <input
        id={name}
        name={name}
        type={type}
        autoComplete={autoComplete}
        defaultValue={defaultValue}
        readOnly={readOnly}
        autoFocus={autoFocus}
        required={required}
        minLength={minLength}
        aria-describedby={hintId}
        className={
          readOnly ? `${AUTH_INPUT_CLASS} bg-gray-50 text-gray-500` : AUTH_INPUT_CLASS
        }
      />
      {hint ? (
        <p id={hintId} className="text-[12px] text-gray-500">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

/**
 * A failure the person can act on.
 *
 * `role="alert"` rather than a styled paragraph: a form error that appears
 * after submission is announced nowhere unless it is announced deliberately.
 */
export function AuthError({ children }: { children: ReactNode }) {
  return (
    <p
      role="alert"
      className="flex items-start gap-1.5 rounded-lg border border-red-600/20 bg-red-100 px-3 py-2.5 text-[13px] text-gray-950"
    >
      <AlertTriangle className="mt-px size-4 shrink-0 text-red-600" aria-hidden />
      {children}
    </p>
  );
}
