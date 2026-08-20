"use client";

import { RefreshCw } from "lucide-react";
import {
  clearStaleBuildMarker,
  recoverFromStaleBuild,
} from "@/lib/stale-build";

/**
 * What a person sees when their tab is running a deployment that no longer
 * exists.
 *
 * Deliberately **not** an error state. Nothing went wrong with their work,
 * nothing failed to save, and nothing they did caused it: Lia shipped a new
 * version while their tab was open, and the page they are holding refers to
 * files that version replaced. Dressing that up in the red-triangle panel
 * teaches somebody to distrust a product that is behaving correctly.
 *
 * It is usually on screen for a few hundred milliseconds — the boundary starts
 * a reload in the same commit that renders this — so the copy has to make sense
 * as a flash. It stays put only when the automatic reload was suppressed
 * because this tab already tried one, and in that case the button is the way
 * out: pressing it clears the guard and asks again, because a person choosing
 * to retry outranks a loop protection aimed at automatic retries.
 *
 * Shared by the two full-screen boundaries — onboarding and organization
 * creation — which render outside the app shell on the marketing surface. The
 * product's own boundary reuses `ErrorState` instead, because it renders inside
 * `PageBody` where a full-viewport panel would sit inside the shell chrome and
 * look like a broken page rather than a message.
 */
export function StaleBuildNotice() {
  return (
    <div
      data-surface="site"
      className="font-site flex min-h-dvh items-center justify-center bg-site-tint px-4 py-10"
    >
      <div
        role="status"
        className="w-full max-w-lg rounded-[20px] border border-site-border bg-white p-7 text-center shadow-[0_10px_30px_-18px_rgb(11_15_24/0.25)]"
      >
        <span
          className="mx-auto flex size-12 items-center justify-center rounded-full bg-site-blue-tint"
          aria-hidden
        >
          <RefreshCw className="size-6 text-site-blue" strokeWidth={2} />
        </span>

        <h1 className="mt-4 text-[22px] font-bold text-site-ink">
          Lia was just updated
        </h1>
        <p className="mx-auto mt-2 max-w-[46ch] text-[14px] leading-relaxed text-site-body">
          This tab is still running the previous version. Reloading picks up the
          new one — nothing you have entered is lost.
        </p>

        <button
          type="button"
          onClick={() => {
            clearStaleBuildMarker();
            recoverFromStaleBuild();
          }}
          className="mt-6 inline-flex min-h-[44px] items-center justify-center rounded-xl bg-site-orange px-6 py-3 text-[15px] font-bold text-site-ink transition-colors hover:bg-site-orange-hover"
        >
          Reload
        </button>
      </div>
    </div>
  );
}
