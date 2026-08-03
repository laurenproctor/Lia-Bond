"use client";

import { useEffect } from "react";
import { PageBody } from "@/components/shell/app-shell";
import { ErrorState } from "@/components/ui/error-state";

/** Route-level error boundary shared by every screen inside the shell. */
export default function AppError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // Phase 2 forwards this to the audit log and an error reporter.
    console.error(error);
  }, [error]);

  return (
    <PageBody>
      <ErrorState reference={error.digest} onRetry={reset} />
    </PageBody>
  );
}
