"use client";

import { useEffect } from "react";
import Link from "next/link";
import { PageBody } from "@/components/shell/app-shell";
import { ErrorState } from "@/components/ui/error-state";

/**
 * Error boundary for the integration routes.
 *
 * Distinct from the shell-wide one because the recovery here is different:
 * these screens talk to Google, so "try again" is often the right move but
 * "go back to integrations and check the connection" is the one that actually
 * resolves a revoked grant. The message stays generic — the specific provider
 * failure was already logged server-side, and an unhandled error message can
 * carry a request URL.
 */
export default function IntegrationsError({
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
        title="We couldn't load this integration"
        description="Lia could not read the connection or reach Google. Try again — if it keeps happening, check the connection status and reauthorize."
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
