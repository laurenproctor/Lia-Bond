"use client";

import { useState, useTransition } from "react";
import { ExternalLink } from "lucide-react";
import { openBillingPortalAction } from "@/app/actions/billing";
import { Button } from "@/components/ui/button";
import type { ButtonVariant } from "@/components/ui/button";

/**
 * Send the customer to Stripe's hosted portal.
 *
 * Everything a customer does to their own subscription — changing a card,
 * downloading an invoice, cancelling, resuming — happens there rather than
 * here. That is the v1 decision, and it is not laziness: a card form in Lia
 * would put this codebase in scope for obligations it is nowhere near ready
 * for, and Stripe's portal already handles the payment-recovery flows that are
 * the hardest part to get right.
 *
 * The customer id is not a prop, and could not be: the action reads it from
 * the authenticated organization's billing row. There is nothing here for a
 * request to forge.
 */
export function PortalButton({
  children = "Manage billing",
  variant = "secondary",
}: {
  children?: string;
  variant?: ButtonVariant;
}) {
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function open() {
    setError(null);
    startTransition(async () => {
      const result = await openBillingPortalAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      window.location.assign(result.data.url);
    });
  }

  return (
    <div className="flex flex-col gap-2">
      <Button variant={variant} icon={ExternalLink} onClick={open} disabled={pending}>
        {pending ? "Opening…" : children}
      </Button>
      {error ? (
        <p role="alert" className="text-[12.5px] text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}
