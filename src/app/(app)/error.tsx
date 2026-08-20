"use client";

import { useEffect } from "react";
import { PageBody } from "@/components/shell/app-shell";
import { ErrorState } from "@/components/ui/error-state";
import {
  clearStaleBuildMarker,
  isStaleBuildError,
  recoverFromStaleBuild,
} from "@/lib/stale-build";

/**
 * Route-level error boundary shared by every screen inside the shell.
 *
 * A retired deployment's missing chunks are handled the way onboarding handles
 * them and for the same reason — `reset()` re-renders this tree from a document
 * that is already stale, so only a full page load recovers. The product is
 * where a tab stays open longest, which makes it the likeliest place to meet a
 * deploy mid-session. See `@/lib/stale-build`.
 *
 * It reuses `ErrorState` rather than the full-screen notice the site-surfaced
 * boundaries show: this renders inside `PageBody`, where a viewport-height
 * panel would sit within the shell chrome and read as a broken page. The copy
 * still says what actually happened — nothing here claims a failure.
 */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const stale = isStaleBuildError(error);

  useEffect(() => {
    if (stale) {
      console.warn("[app] stale build, reloading", error.message);
      recoverFromStaleBuild();
      return;
    }

    // Phase 2 forwards this to the audit log and an error reporter.
    console.error(error);
  }, [error, stale]);

  if (stale) {
    return (
      <PageBody>
        <ErrorState
          title="Lia was just updated"
          description="This tab is still running the previous version. Reloading picks up the new one — nothing you have entered is lost."
          onRetry={() => {
            // Clearing first: the automatic attempt has already been made and
            // suppressed by the time anybody can press this, and a person
            // asking again outranks a guard aimed at automatic retries.
            clearStaleBuildMarker();
            recoverFromStaleBuild();
          }}
        />
      </PageBody>
    );
  }

  return (
    <PageBody>
      <ErrorState reference={error.digest} onRetry={reset} />
    </PageBody>
  );
}
