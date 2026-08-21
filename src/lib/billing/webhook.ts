import "server-only";

import type { WebhookErrorCategory } from "@/domain";
import type { LiaDataSource } from "@/lib/data/types";
import { billingAlert } from "@/lib/billing/alerts";
import type { StripeGateway, VerifiedEvent } from "@/lib/billing/gateway";

/**
 * The webhook state machine.
 *
 * Separated from the route so the whole of it is reachable from a test with
 * the mock gateway and the demo data source — the route itself is then thin
 * enough to read in one screen, and is only responsible for turning an outcome
 * into a status code.
 *
 * ## The three properties this is arranged around
 *
 * **An event is never acknowledged before its effects are durable.** Marking
 * processed happens inside `apply_stripe_billing_projection` and
 * `record_billing_payment`, in the same transaction as the projection and the
 * audit entries. A crash between the two is not a state this code can reach,
 * because there is no "between".
 *
 * **The event says what changed; Stripe says what is true.** Every
 * subscription-bearing event triggers a fresh `retrieveSubscription`. That is
 * what makes out-of-order delivery harmless: an `updated` that arrives after
 * the `deleted` which followed it still projects the deleted state, because
 * both re-read the same current object. No ordering assumption anywhere.
 *
 * **Metadata is correlation, not authorization.** The tenant is resolved by
 * looking up the Stripe customer in `organization_billing`. The
 * `lia_organization_id` on the event is compared against that answer and a
 * mismatch is refused and alerted — it is never the thing that decides.
 */

/** What the route should do about this delivery. */
export type WebhookOutcome =
  /** Processed, or a duplicate of something already processed. 200. */
  | { kind: "ok"; detail: "processed" | "duplicate" | "ignored" }
  /**
   * Another delivery of this same event is in flight. 409, so Stripe retries
   * later rather than immediately — by then the first will have finished and
   * the retry sees a duplicate.
   */
  | { kind: "in_progress" }
  /** Durable processing failed. Non-2xx, so Stripe retries. */
  | { kind: "failed"; category: WebhookErrorCategory };

export interface ProcessEventInput {
  dataSource: LiaDataSource;
  gateway: StripeGateway;
  event: VerifiedEvent;
  now: string;
}

/**
 * Event types Lia acts on.
 *
 * Anything verified and unlisted is recorded as `ignored` and acknowledged.
 * That is a success rather than a failure: Stripe adds event types, an
 * endpoint that 500s on an unfamiliar one would retry it for three days, and
 * "we received it and it was not ours to act on" is the honest record.
 */
const HANDLED = new Set([
  "checkout.session.completed",
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "customer.subscription.trial_will_end",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.payment_action_required",
  "invoice.finalization_failed",
]);

export async function processStripeEvent(
  input: ProcessEventInput,
): Promise<WebhookOutcome> {
  const { dataSource, gateway, event } = input;

  // ---------------------------------------------------------------------
  // Mode. Before anything is stored: a sandbox key must never process a live
  // event and a live key must never process a sandbox one. The first would
  // grant access for a payment that did not happen in the account that
  // matters; the second would apply test data to real customers.
  // ---------------------------------------------------------------------
  if (event.livemode !== gateway.isLiveMode()) {
    billingAlert("mode_mismatch", {
      stripeEventId: event.id,
      eventType: event.type,
    });
    return { kind: "failed", category: "mode_mismatch" };
  }

  const claim = await dataSource.stripeWebhookEvents.claim({
    stripeEventId: event.id,
    eventType: event.type,
    stripeObjectId: event.objectId,
    livemode: event.livemode,
    stripeCreatedAt: event.createdAt,
  });

  if (claim === "already_processed") return { kind: "ok", detail: "duplicate" };
  if (claim === "in_progress") return { kind: "in_progress" };

  if (!HANDLED.has(event.type)) {
    await dataSource.stripeWebhookEvents.finish(event.id, "ignored");
    return { kind: "ok", detail: "ignored" };
  }

  try {
    return await handle(input);
  } catch (error) {
    // No provider or driver text: both can quote things that must not be
    // logged. The category is Lia's word for what happened.
    const category: WebhookErrorCategory =
      error instanceof Error && error.message.includes("Stripe")
        ? "stripe_api_error"
        : "database_error";

    billingAlert(category, { stripeEventId: event.id, eventType: event.type });
    await dataSource.stripeWebhookEvents.finish(event.id, "failed", category);
    return { kind: "failed", category };
  }
}

async function handle(input: ProcessEventInput): Promise<WebhookOutcome> {
  const { dataSource, event } = input;

  // -----------------------------------------------------------------------
  // Resolve the tenant, through the customer mapping and nothing else.
  // -----------------------------------------------------------------------
  if (!event.customerId) {
    billingAlert("unmatched_customer", {
      stripeEventId: event.id,
      eventType: event.type,
    });
    await dataSource.stripeWebhookEvents.finish(event.id, "failed", "unmatched_customer");
    return { kind: "failed", category: "unmatched_customer" };
  }

  const billing = await dataSource.billing.findByCustomerId(event.customerId);
  if (!billing) {
    // Retryable on purpose. The usual cause is a race: the customer was
    // created moments ago and the binding write has not committed. Stripe will
    // send this again, and by then it will resolve.
    billingAlert("unmatched_customer", {
      stripeEventId: event.id,
      stripeCustomerId: event.customerId,
      eventType: event.type,
    });
    await dataSource.stripeWebhookEvents.finish(event.id, "failed", "unmatched_customer");
    return { kind: "failed", category: "unmatched_customer" };
  }

  // Compared, never trusted. A mismatch means either a hand-edited metadata
  // field or two organizations pointed at one Stripe object, and neither
  // should resolve itself quietly.
  if (
    event.organizationIdHint &&
    event.organizationIdHint !== billing.organizationId
  ) {
    billingAlert("organization_mismatch", {
      stripeEventId: event.id,
      stripeCustomerId: event.customerId,
      organizationId: billing.organizationId,
      eventType: event.type,
    });
    await dataSource.stripeWebhookEvents.finish(
      event.id,
      "failed",
      "organization_mismatch",
    );
    return { kind: "failed", category: "organization_mismatch" };
  }

  // -----------------------------------------------------------------------
  // Invoice events: money moved, or did not.
  // -----------------------------------------------------------------------
  if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
    // Whether this is the charge that ends a trial cannot be read off the
    // invoice — a trial-ending charge and an ordinary renewal both carry
    // `subscription_cycle`. Lia's own projection is what knows: a trial that
    // started and has not converted.
    const endsATrial =
      billing.trialStartedAt !== null && billing.trialConvertedAt === null;

    await dataSource.billing.recordPayment({
      organizationId: billing.organizationId,
      paid: event.type === "invoice.paid",
      occurredAt: event.createdAt,
      isFirstCharge: event.isFirstCharge || endsATrial,
      stripeEventId: event.id,
    });

    // The subscription's own status moved too, and it is re-read rather than
    // inferred: `invoice.paid` does not by itself mean `active`.
    if (event.subscriptionId) {
      await projectSubscription(input, billing.organizationId, event.subscriptionId, null);
    }

    return { kind: "ok", detail: "processed" };
  }

  // Neither changes a projected value; both need somebody to know.
  if (
    event.type === "invoice.payment_action_required" ||
    event.type === "invoice.finalization_failed"
  ) {
    billingAlert(
      event.type === "invoice.finalization_failed" ? "stripe_api_error" : "unhandled",
      {
        stripeEventId: event.id,
        eventType: event.type,
        organizationId: billing.organizationId,
        stripeCustomerId: event.customerId,
      },
    );
    await dataSource.stripeWebhookEvents.finish(event.id, "processed");
    return { kind: "ok", detail: "processed" };
  }

  // A notification, not a state change. Stripe sends the customer the email;
  // Lia's countdown already comes from `trial_end`, so there is nothing to
  // write and inventing something to write would be worse than nothing.
  if (event.type === "customer.subscription.trial_will_end") {
    await dataSource.stripeWebhookEvents.finish(event.id, "processed");
    return { kind: "ok", detail: "processed" };
  }

  // -----------------------------------------------------------------------
  // Everything else is a subscription state change.
  // -----------------------------------------------------------------------
  if (!event.subscriptionId) {
    // A `checkout.session.completed` for a mode Lia does not use, or a
    // session abandoned before a subscription existed. Verified, harmless,
    // nothing to project.
    await dataSource.stripeWebhookEvents.finish(event.id, "ignored");
    return { kind: "ok", detail: "ignored" };
  }

  await projectSubscription(
    input,
    billing.organizationId,
    event.subscriptionId,
    event.id,
  );

  return { kind: "ok", detail: "processed" };
}

/**
 * Re-read the subscription from Stripe and project it.
 *
 * `eventId` is passed only when this write is the one that closes the event
 * out. An invoice event has already been closed by `recordPayment`, so it
 * passes null and this becomes a plain projection refresh.
 */
async function projectSubscription(
  input: ProcessEventInput,
  organizationId: string,
  subscriptionId: string,
  eventId: string | null,
): Promise<void> {
  const { dataSource, gateway } = input;

  const subscription = await gateway.retrieveSubscription(subscriptionId);

  if (!subscription) {
    // Stripe does not have it. Nothing to project, and nothing that retrying
    // would fix — a 404 does not become a 200.
    billingAlert("unmatched_subscription", {
      stripeSubscriptionId: subscriptionId,
      organizationId,
    });
    if (eventId) await dataSource.stripeWebhookEvents.finish(eventId, "processed");
    return;
  }

  await dataSource.billing.applyProjection({
    organizationId,
    customerId: subscription.customerId,
    subscriptionId: subscription.id,
    itemId: subscription.itemId,
    priceId: subscription.priceId,
    interval: subscription.interval,
    status: subscription.status,
    quantity: subscription.quantity,
    currentPeriodStart: subscription.currentPeriodStart,
    currentPeriodEnd: subscription.currentPeriodEnd,
    cancelAtPeriodEnd: subscription.cancelAtPeriodEnd,
    trialStart: subscription.trialStart,
    trialEnd: subscription.trialEnd,
    // Only ever the self-service source from a webhook. An operator grant is
    // written by `grant_billing_trial`, and the projection coalesces so it
    // cannot be overwritten by a later event.
    trialGrantSource: subscription.trialStart ? "self_service" : null,
    stripeEventId: eventId,
  });

  // Purchased capacity below the number of locations actually in use is not
  // something Lia can fix on its own — deleting a location would be worse than
  // the discrepancy — so it is reported rather than acted on.
  const billable = await dataSource.billing.countBillableLocations({
    organizationId,
    userId: "00000000-0000-0000-0000-000000000000",
    role: "owner",
  });

  if (billable > subscription.quantity) {
    billingAlert("quantity_below_billable", {
      organizationId,
      stripeSubscriptionId: subscription.id,
      expected: subscription.quantity,
      actual: billable,
    });
  }
}
