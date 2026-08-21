import { CheckCircle2, Loader2 } from "lucide-react";

/**
 * What the Checkout redirect is allowed to say.
 *
 * Returning from Stripe proves the customer reached the end of a hosted page.
 * It does not prove a subscription exists, that a card was accepted, or that
 * Lia knows about any of it — only a signed webhook does that, and it may
 * arrive a second later or, if something is wrong, not at all.
 *
 * So this renders a *synchronising* state, and it is careful about the
 * difference between "we are waiting" and "you are subscribed". The second
 * sentence is only shown once the projection actually carries a subscription,
 * at which point it is describing the database rather than the redirect.
 */
export function BillingSyncNotice({
  checkoutState,
  hasSubscription,
}: {
  checkoutState: string | null;
  hasSubscription: boolean;
}) {
  if (checkoutState === "cancelled") {
    return (
      <div
        role="status"
        className="mb-4 rounded-lg border border-gray-200 bg-gray-50 p-3 text-[13px] text-gray-700"
      >
        Checkout was cancelled. Nothing was charged, and nothing has changed.
      </div>
    );
  }

  if (checkoutState !== "complete") return null;

  if (hasSubscription) {
    return (
      <div
        role="status"
        className="mb-4 flex items-center gap-2 rounded-lg border border-green-600/20 bg-green-50 p-3 text-[13px] text-green-600"
      >
        <CheckCircle2 className="size-4 shrink-0" aria-hidden />
        Your subscription is set up. The details below are live.
      </div>
    );
  }

  return (
    <div
      role="status"
      className="mb-4 flex items-center gap-2 rounded-lg border border-blue-600/20 bg-blue-100 p-3 text-[13px] text-blue-600"
    >
      <Loader2 className="size-4 shrink-0 animate-spin" aria-hidden />
      Stripe has your details and we are waiting for it to confirm. This usually takes a
      few seconds — refresh the page shortly. Nothing is lost if you navigate away.
    </div>
  );
}
