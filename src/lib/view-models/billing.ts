import type { BadgeTone } from "@/components/ui/badge";
import type { EntitlementReason, OrganizationBilling } from "@/domain";
import type { Entitlement } from "@/lib/billing/entitlement";
import { formatCents } from "@/lib/billing/catalog";
/**
 * Billing dates carry the year, which `formatDate` deliberately does not.
 *
 * "Jul 14" is right for a review that arrived last week and wrong for the day
 * a card is charged: an annual renewal is eleven months away, and a customer
 * reading "Sep 4" beside an amount has no way to tell whether that is a
 * fortnight from now or a year. Its own formatter rather than a change to
 * `formatDate`, because every existing caller is looking at recent activity
 * where the year would be noise.
 */
const billingDateFormatter = new Intl.DateTimeFormat("en-US", {
  day: "numeric",
  month: "long",
  year: "numeric",
  timeZone: "UTC",
});

/** "4 September 2026" — unambiguous, because money moves on it. */
export function formatBillingDate(value: string): string {
  return billingDateFormatter.format(new Date(value));
}

/**
 * What the billing screens say, decided once.
 *
 * Pure, so every state below is reachable from a test rather than only from a
 * Stripe account in the right condition — which is the only way some of them
 * (a lapsed trial, an unpaid subscription, a cancellation mid-period) would
 * ever be seen before a customer saw them.
 *
 * ## The copy rules this module enforces
 *
 * **Nothing here is a countdown clock, and no wording is urgent before it is
 * warranted.** The trial banner is neutral at seven days, neutral at three,
 * and amber only on the last day. Restraint is not decoration: a product that
 * shouts on day one has nothing left to say on day thirteen, and the point of
 * the reminder is that somebody acts on the last one.
 *
 * **Automatic renewal is stated in every trial state.** Card networks require
 * it, and it is the single fact a customer is most likely to feel misled about
 * later. It appears in the trial copy below without exception, which is why
 * there is no variant of `trialSummary` that omits it.
 *
 * **A payment problem never becomes a threat.** The `past_due` copy says what
 * happened and what to do, and does not name a date on which access will be
 * cut off — Lia does not know one. Stripe's retry schedule decides, and
 * inventing a deadline would be a second, contradictory clock.
 */

export interface BillingStatusView {
  label: string;
  tone: BadgeTone;
}

/** The pill at the top of the billing page and in the shell banner. */
export function billingStatusView(entitlement: Entitlement): BillingStatusView {
  const byReason: Record<EntitlementReason, BillingStatusView> = {
    unbilled_not_enforced: { label: "No plan yet", tone: "neutral" },
    no_subscription: { label: "No plan", tone: "amber" },
    trialing: { label: "Trial", tone: "purple" },
    active: { label: "Active", tone: "green" },
    payment_past_due: { label: "Payment failed", tone: "red" },
    billing_setup_incomplete: { label: "Setup incomplete", tone: "amber" },
    billing_setup_expired: { label: "Setup expired", tone: "red" },
    payment_unpaid: { label: "Unpaid", tone: "red" },
    trial_canceled: { label: "Trial cancelled", tone: "neutral" },
    trial_expired: { label: "Trial ended", tone: "neutral" },
    subscription_canceled: { label: "Cancelled", tone: "neutral" },
    canceled_paid_through: { label: "Cancels soon", tone: "amber" },
    subscription_paused: { label: "Paused", tone: "amber" },
    complimentary: { label: "Complimentary", tone: "blue" },
  };

  return byReason[entitlement.reason];
}

/**
 * The one sentence under the pill.
 *
 * Every branch names a date or an amount where one exists, because "your trial
 * is ending soon" is the kind of sentence that makes somebody open a support
 * ticket to ask when.
 */
export function billingHeadline(
  entitlement: Entitlement,
  billing: OrganizationBilling,
  chargeInCents: number | null,
): string {
  const charge = chargeInCents === null ? null : formatCents(chargeInCents);

  switch (entitlement.reason) {
    case "unbilled_not_enforced":
      return "This organization is not on a paid plan yet. Everything is available while Lia is being set up.";
    case "no_subscription":
      return "Choose a plan to restore full access.";
    case "trialing": {
      const ends = billing.trialEnd ? formatBillingDate(billing.trialEnd) : "the trial end";
      const amount = charge ? `${charge} ` : "";
      // Renewal is stated here rather than in a footnote.
      return `Your free trial ends on ${ends}, when the ${amount}subscription begins automatically. Cancel any time before then and you will not be charged.`;
    }
    case "active": {
      const renews = billing.currentPeriodEnd
        ? formatBillingDate(billing.currentPeriodEnd)
        : null;
      if (!renews) return "Your subscription is active.";
      return charge
        ? `Renews automatically on ${renews} for ${charge}.`
        : `Renews automatically on ${renews}.`;
    }
    case "payment_past_due":
      // No deadline named: Lia does not know Stripe's retry schedule, and a
      // number invented here would contradict the one Stripe is acting on.
      return "We could not take payment. Lia keeps working while your card is retried — update your payment method to avoid interruption.";
    case "billing_setup_incomplete":
      return "Your payment needs one more step before the subscription starts.";
    case "billing_setup_expired":
      return "Billing setup was not completed, so the subscription never started.";
    case "payment_unpaid":
      return "Payment could not be collected. Lia is read-only until the outstanding invoice is paid.";
    case "trial_canceled":
      return "You cancelled during the trial, so nothing was charged. Your data is all still here.";
    case "trial_expired":
      return "Your trial has ended and nothing was charged. Your data is all still here.";
    case "subscription_canceled":
      return "Your subscription has ended. Lia is read-only, and every record you made is still here.";
    case "canceled_paid_through": {
      const until = billing.currentPeriodEnd
        ? formatBillingDate(billing.currentPeriodEnd)
        : "the end of the period you have paid for";
      return `Your subscription is cancelled. Full access continues until ${until}.`;
    }
    case "subscription_paused":
      return "Your subscription is paused. Add a payment method to resume it.";
    case "complimentary": {
      const until = billing.accessDispositionExpiresAt
        ? ` until ${formatBillingDate(billing.accessDispositionExpiresAt)}`
        : "";
      return `This organization has complimentary access${until}.`;
    }
  }
}

/**
 * How loudly to render the trial countdown.
 *
 * Neutral until the last day. See the module comment for why this is a rule
 * rather than a preference.
 */
export function trialCountdownTone(daysRemaining: number | null): BadgeTone {
  if (daysRemaining === null) return "neutral";
  if (daysRemaining <= 1) return "amber";
  return "purple";
}

/** "7 days left", "1 day left", "Ends today". Never a clock. */
export function trialCountdownLabel(daysRemaining: number | null): string | null {
  if (daysRemaining === null) return null;
  if (daysRemaining === 0) return "Ends today";
  return daysRemaining === 1 ? "1 day left" : `${daysRemaining} days left`;
}

/**
 * Whether the shell should carry a banner at all, and how insistent it is.
 *
 * `null` means say nothing. An active subscription with nothing wrong is the
 * overwhelmingly common case, and a persistent banner for it would train
 * everybody to ignore the ones that matter.
 */
export interface BillingBannerView {
  message: string;
  tone: "info" | "warning" | "danger";
  actionLabel: string;
}

export function billingBannerView(
  entitlement: Entitlement,
  billing: OrganizationBilling,
): BillingBannerView | null {
  switch (entitlement.reason) {
    case "active":
    case "complimentary":
    case "canceled_paid_through":
      return null;

    case "unbilled_not_enforced":
      return {
        message: "Start your 14-day free trial whenever you are ready.",
        tone: "info",
        actionLabel: "See plans",
      };

    case "trialing": {
      const days = entitlement.trialDaysRemaining;
      // Nothing at all for the first week: a trial banner every day from day
      // one is furniture by day three.
      if (days === null || days > 7) return null;
      const label = trialCountdownLabel(days);
      const ends = billing.trialEnd ? formatBillingDate(billing.trialEnd) : null;
      return {
        message: ends
          ? `Free trial: ${label?.toLowerCase()}. Your subscription starts automatically on ${ends}.`
          : `Free trial: ${label?.toLowerCase()}.`,
        tone: days <= 1 ? "warning" : "info",
        actionLabel: "Manage billing",
      };
    }

    case "payment_past_due":
    case "billing_setup_incomplete":
      return {
        message: "We could not take payment. Update your payment method to avoid interruption.",
        tone: "warning",
        actionLabel: "Fix payment",
      };

    case "no_subscription":
    case "billing_setup_expired":
    case "payment_unpaid":
    case "trial_canceled":
    case "trial_expired":
    case "subscription_canceled":
    case "subscription_paused":
      return {
        message: "Lia is read-only. Your data is all still here — choose a plan to start working again.",
        tone: "danger",
        actionLabel: "Restore access",
      };
  }
}
