"use client";

import { useEffect } from "react";
import Link from "next/link";
import { PageBody } from "@/components/shell/app-shell";
import { ErrorState } from "@/components/ui/error-state";

/**
 * Error boundary for the rules routes.
 *
 * The message stays generic — the specific failure was already logged
 * server-side, and an unhandled error message can carry a request URL.
 */
export default function RulesError({
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
        title="Something went wrong loading rules"
        description="Lia could not load the automation rules. Try again — if it keeps happening, come back in a moment."
        reference={error.digest}
        onRetry={reset}
      />
      <p className="text-center text-[13px]">
        <Link
          href="/rules"
          className="font-medium text-purple-600 underline underline-offset-2"
        >
          Back to rules
        </Link>
      </p>
    </PageBody>
  );
}
