"use client";

import { useEffect } from "react";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { StaleBuildNotice } from "@/components/ui/stale-build-notice";
import { isStaleBuildError, recoverFromStaleBuild } from "@/lib/stale-build";

/**
 * Route-level error boundary for organization creation.
 *
 * This route group had none, and the gap was not cosmetic. `/organizations`
 * sits outside both `(app)` and `(site)` — deliberately, because it has to work
 * for somebody who belongs to no organization at all — which also put it
 * outside both of their error boundaries, so a throw here fell through to
 * Next's own error page. That page is the framework's, not Lia's: no brand, no
 * way back, and a retry that re-renders the same stale tree.
 *
 * The wording is narrower than onboarding's on purpose. Nothing has been
 * created by the time this renders, so promising that progress is saved would
 * be false — there is no progress yet, only a name in a form. Saying so is also
 * the useful part: the fear on a failed "create" is a half-made tenant, and
 * `provision_organization` is one transaction precisely so that cannot happen.
 *
 * The link goes to `/overview` rather than back here. Somebody who already
 * belongs to an organization has somewhere to be, and somebody who does not is
 * bounced from `/overview` straight back to this route — the right destination
 * either way, decided by the guards rather than by this screen guessing.
 */
export default function OrganizationsError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const stale = isStaleBuildError(error);

  useEffect(() => {
    if (stale) {
      console.warn("[organizations] stale build, reloading", error.message);
      recoverFromStaleBuild();
      return;
    }

    console.error("[organizations]", error);
  }, [error, stale]);

  if (stale) return <StaleBuildNotice />;

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
          That organization could not be created
        </h1>
        <p className="mx-auto mt-2 max-w-[46ch] text-[14px] leading-relaxed text-site-body">
          Nothing was created, so there is no half-finished workspace to clean
          up. Try again, and if it keeps happening let us know.
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
            href="/overview"
            className="inline-flex min-h-[44px] items-center justify-center rounded-xl border border-site-blue-edge bg-white px-5 py-3 text-[15px] font-semibold text-site-blue transition-colors hover:bg-site-blue-tint"
          >
            Back to Lia
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
