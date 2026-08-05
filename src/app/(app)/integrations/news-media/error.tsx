"use client";

import { useEffect } from "react";
import Link from "next/link";
import { PageBody } from "@/components/shell/app-shell";
import { ErrorState } from "@/components/ui/error-state";

/**
 * Error boundary for the news and media screen.
 *
 * Its own boundary rather than relying on `../error.tsx` alone, per
 * `CLAUDE.md`'s route-level requirement — and the recovery message differs
 * from Google's: nothing here talks to a live provider during render, so a
 * failure is almost always a data-layer problem rather than something a retry
 * against GNews would fix. The message says so instead of suggesting
 * reauthorization, which does not apply here.
 */
export default function NewsMediaError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error(error);
  }, [error]);

  return (
    <PageBody>
      <ErrorState
        title="We couldn't load news and media"
        description="Lia could not load your monitoring queries or their history. Try again — if it keeps happening, let your administrator know."
        reference={error.digest}
        onRetry={reset}
      />
      <p className="text-center text-[13px]">
        <Link
          href="/integrations"
          className="font-medium text-purple-600 underline underline-offset-2"
        >
          Back to integrations
        </Link>
      </p>
    </PageBody>
  );
}
