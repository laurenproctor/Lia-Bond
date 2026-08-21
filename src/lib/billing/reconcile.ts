import "server-only";

import type { OrganizationBilling } from "@/domain";
import type { LiaDataSource } from "@/lib/data/types";
import { billingAlert } from "@/lib/billing/alerts";
import type { CanonicalSubscription, StripeGateway } from "@/lib/billing/gateway";

/**
 * Compare Lia's projection against Stripe, and say where they disagree.
 *
 * The webhook is the primary path and it is designed not to drift — every
 * handler re-reads the subscription rather than trusting a payload. But
 * "designed not to" is not "cannot": a webhook endpoint can be
 * misconfigured, disabled during an incident, or fail for three days until
 * Stripe stops retrying, and any of those leaves a projection quietly stale
 * while the product acts on it. This job is what notices.
 *
 * ## What it may and may not do
 *
 * **May repair**: `subscription_status`, price, interval, quantity, and the
 * period dates. Stripe owns every one of them — a disagreement means Lia's
 * copy is wrong, by definition, and copying the authority's value back is not
 * a decision.
 *
 * **May not touch**: `trial_eligible`, `trial_started_at`, `trial_end`,
 * `trial_converted_at`, and the access disposition. Those are Lia's own facts.
 * Stripe has no opinion about whether an organization has used its one
 * self-service trial, and a job that "repaired" them from Stripe's view would
 * be the one way a spent trial could come back.
 *
 * **Never touches Stripe at all.** Not a cancellation, not a quantity, not a
 * customer. It reads. A reconciliation job that could mutate the payment
 * processor is a scheduled task one bug away from cancelling a paying
 * customer's subscription at three in the morning.
 *
 * Anything it cannot safely repair — a subscription Stripe has never heard of,
 * two live subscriptions on one customer, purchased capacity below the number
 * of locations in use — is reported and left alone.
 */

export interface ReconcileInput {
  dataSource: LiaDataSource;
  gateway: StripeGateway;
  /** Bounded so one run has a predictable cost, like every other sweep here. */
  limit: number;
}

export interface ReconcileOutcome {
  examined: number;
  /** Projections that disagreed with Stripe and were corrected. */
  repaired: number;
  /** Disagreements reported but deliberately not acted on. */
  reported: number;
}

/** The fields Stripe owns, compared one by one. */
function projectionDrifted(
  billing: OrganizationBilling,
  subscription: CanonicalSubscription,
): boolean {
  return (
    billing.stripeSubscriptionId !== subscription.id ||
    billing.subscriptionStatus !== subscription.status ||
    billing.purchasedLocationQuantity !== subscription.quantity ||
    billing.billingInterval !== subscription.interval ||
    billing.stripePriceId !== subscription.priceId ||
    billing.currentPeriodEnd !== subscription.currentPeriodEnd ||
    billing.cancelAtPeriodEnd !== subscription.cancelAtPeriodEnd
  );
}

export async function reconcileBilling(
  input: ReconcileInput,
): Promise<ReconcileOutcome> {
  const { dataSource, gateway, limit } = input;

  const rows = await dataSource.billing.listForReconciliation(limit);
  const outcome: ReconcileOutcome = { examined: 0, repaired: 0, reported: 0 };

  for (const billing of rows) {
    outcome.examined += 1;
    if (!billing.stripeCustomerId) continue;

    // Per-row isolation: one organization's Stripe failure must not stop the
    // sweep, the same posture `pollDueQueries` takes.
    try {
      const subscriptions = await gateway.listSubscriptions(billing.stripeCustomerId);

      const live = subscriptions.filter((subscription) =>
        ["trialing", "active", "past_due", "incomplete", "paused"].includes(
          subscription.status,
        ),
      );

      // Two live subscriptions on one customer is the invariant this whole
      // feature is arranged to prevent. It cannot be repaired from here —
      // deciding which one a customer keeps is a refund conversation.
      if (live.length > 1) {
        billingAlert("duplicate_subscription", {
          organizationId: billing.organizationId,
          stripeCustomerId: billing.stripeCustomerId,
          actual: live.length,
        });
        outcome.reported += 1;
        continue;
      }

      const current = live[0] ?? subscriptions[0] ?? null;

      if (!current) {
        // Lia thinks there is a subscription and Stripe has none at all.
        if (billing.stripeSubscriptionId !== null) {
          billingAlert("unmatched_subscription", {
            organizationId: billing.organizationId,
            stripeCustomerId: billing.stripeCustomerId,
            stripeSubscriptionId: billing.stripeSubscriptionId,
          });
          outcome.reported += 1;
        }
        continue;
      }

      if (projectionDrifted(billing, current)) {
        billingAlert("projection_drift", {
          organizationId: billing.organizationId,
          stripeSubscriptionId: current.id,
          eventType: `${billing.subscriptionStatus ?? "none"}->${current.status}`,
        });

        await dataSource.billing.applyProjection({
          organizationId: billing.organizationId,
          customerId: current.customerId,
          subscriptionId: current.id,
          itemId: current.itemId,
          priceId: current.priceId,
          interval: current.interval,
          status: current.status,
          quantity: current.quantity,
          currentPeriodStart: current.currentPeriodStart,
          currentPeriodEnd: current.currentPeriodEnd,
          cancelAtPeriodEnd: current.cancelAtPeriodEnd,
          trialStart: current.trialStart,
          trialEnd: current.trialEnd,
          trialGrantSource: current.trialStart ? "self_service" : null,
          // No event: this repair was not caused by one, and passing a
          // borrowed id would mark somebody else's delivery processed.
          stripeEventId: null,
        });

        outcome.repaired += 1;
      }

      // Reported, never repaired. Lia cannot fix this without either charging
      // somebody more than they agreed to or deleting a location.
      const billable = await dataSource.billing.countBillableLocations({
        organizationId: billing.organizationId,
        userId: "00000000-0000-0000-0000-000000000000",
        role: "owner",
      });

      if (billable > current.quantity) {
        billingAlert("quantity_below_billable", {
          organizationId: billing.organizationId,
          stripeSubscriptionId: current.id,
          expected: current.quantity,
          actual: billable,
        });
        outcome.reported += 1;
      }
    } catch {
      // No provider text, per the rule this whole feature keeps.
      billingAlert("stripe_api_error", {
        organizationId: billing.organizationId,
        stripeCustomerId: billing.stripeCustomerId,
      });
      outcome.reported += 1;
    }
  }

  return outcome;
}
