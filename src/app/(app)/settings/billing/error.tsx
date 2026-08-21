"use client";

import { useEffect } from "react";
import Link from "next/link";
import { PageBody } from "@/components/shell/app-shell";
import { ErrorState } from "@/components/ui/error-state";

/**
 * Error boundary for billing.
 *
 * The message stays generic — the specific failure was logged server-side, and
 * a Stripe error can quote a request URL while a driver error can quote a
 * connection string.
 *
 * The reassurance matters more here than on other screens. Somebody reaching
 * this page has usually just paid for something, or is trying to fix a payment
 * that failed, and a bare error on a billing screen reads as "your money has
 * gone somewhere". It has not: Lia writes no billing state from a browser
 * request, so a failure here cannot have charged anybody or changed a
 * subscription.
 */
export default function BillingError({
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
        title="Something went wrong loading billing"
        description="Lia could not load your subscription details. Nothing has been charged or changed — this page only reads. Try again, and if it keeps happening your subscription is safe in Stripe either way."
        reference={error.digest}
        onRetry={reset}
      />
      <p className="text-center text-[13px]">
        <Link
          href="/settings"
          className="font-medium text-purple-600 underline underline-offset-2"
        >
          Back to settings
        </Link>
      </p>
    </PageBody>
  );
}
