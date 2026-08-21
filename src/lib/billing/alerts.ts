import type { WebhookErrorCategory } from "@/domain";

/**
 * The one place a billing problem becomes a log line.
 *
 * Every call takes a Lia-authored category from a closed list and a small bag
 * of identifiers. There is no parameter for a message, and that absence is the
 * design: a Stripe error can quote a request URL, a driver error can quote a
 * connection string, and both would end up in a log that somebody pastes into
 * a ticket. `docs/architecture/current-state.md` already states this rule for
 * GNews and Anthropic; billing is where breaking it would be a compliance
 * incident rather than an embarrassment.
 *
 * Identifiers are safe and are the whole point of alerting: `evt_1abc` and
 * `cus_2def` are what let somebody find the thing in the Stripe Dashboard.
 * Amounts, names, emails, and anything resembling a payment method are not
 * passed and would not be logged if they were.
 */

export type BillingAlertCategory =
  | WebhookErrorCategory
  | "projection_drift"
  | "quantity_below_billable"
  | "trial_eligibility_conflict"
  | "repeated_webhook_failure";

export interface BillingAlertContext {
  stripeEventId?: string | null;
  stripeCustomerId?: string | null;
  stripeSubscriptionId?: string | null;
  organizationId?: string | null;
  eventType?: string | null;
  attemptCount?: number | null;
  /** Two numbers being compared, e.g. purchased capacity and billable count. */
  expected?: number | null;
  actual?: number | null;
}

export function billingAlert(
  category: BillingAlertCategory,
  context: BillingAlertContext = {},
): void {
  const fields = Object.entries(context)
    .filter(([, value]) => value !== null && value !== undefined)
    .map(([key, value]) => `${key}=${String(value)}`)
    .join(" ");

  // `console.error` rather than a logging library, matching every other alert
  // path in the codebase. Vercel collects stderr, and a structured prefix is
  // what makes these greppable.
  console.error(`[billing:${category}]${fields ? ` ${fields}` : ""}`);
}
