"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";

/**
 * Route-level error boundary for onboarding.
 *
 * Its own, rather than falling through to the product's, because the product's
 * renders inside `PageBody` — which lives in the app shell this route group
 * deliberately does not have.
 *
 * The error's own message is never rendered. Anything that reaches here is
 * unhandled, and an unhandled message can carry a table name, a query, or a
 * provider payload. The digest is shown so support can find the trace.
 *
 * "Try again" is offered first because most failures here are transient — a
 * database hiccup, a Google timeout during discovery — and progress is stored
 * server-side, so retrying resumes at exactly the same step rather than
 * restarting setup.
 */
export default function OnboardingError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("[onboarding]", error);
  }, [error]);

  return (
    <div
      data-surface="site"
      className="font-site flex min-h-dvh items-center justify-center bg-site-tint px-4 py-10"
    >
      <div className="w-full max-w-lg rounded-[20px] border border-site-border bg-white p-7 text-center shadow-[0_10px_30px_-18px_rgb(11_15_24/0.25)]">
        <span
          className="mx-auto flex size-12 items-center justify-center rounded-full bg-site-amber-tint"
          aria-hidden
        >
          <AlertTriangle className="size-6 text-site-amber-edge" strokeWidth={2} />
        </span>

        <h1 className="mt-4 text-[22px] font-bold text-site-ink">
          Something went wrong setting up your workspace
        </h1>
        <p className="mx-auto mt-2 max-w-[46ch] text-[14px] leading-relaxed text-site-body">
          Your progress is saved. Try again, and you&rsquo;ll pick up exactly where
          you left off.
        </p>

        <div className="mt-6 flex flex-wrap items-center justify-center gap-3">
          <button
            type="button"
            onClick={reset}
            className="inline-flex min-h-[44px] items-center justify-center rounded-xl bg-site-orange px-6 py-3 text-[15px] font-bold text-site-ink transition-colors hover:bg-site-orange-hover"
          >
            Try again
          </button>
          <Link
            href="/help"
            className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-site-blue-edge bg-white px-5 py-3 text-[15px] font-semibold text-site-blue transition-colors hover:bg-site-blue-tint"
          >
            Get help
          </Link>
        </div>

        {error.digest ? (
          <p className="mt-5 text-[12px] text-site-muted">
            Reference: <span className="font-mono">{error.digest}</span>
          </p>
        ) : null}
      </div>
    </div>
  );
}
