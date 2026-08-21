import "server-only";

import Stripe from "stripe";
import type { BillingInterval, SubscriptionStatus } from "@/domain";
import { billingIntervalSchema, subscriptionStatusSchema } from "@/domain/enums";
import { requireStripeSecretKey, requireStripeWebhookSecret, isStripeLiveMode } from "@/lib/env";
import { PRICE_LOOKUP_KEYS } from "@/lib/billing/catalog";
import {
  WebhookSignatureError,
  type CanonicalSubscription,
  type CheckoutSession,
  type CreateCheckoutSessionInput,
  type CreatePortalSessionInput,
  type EnsureCustomerInput,
  type PreviewQuantityChangeInput,
  type QuantityChangePreview,
  type StripeGateway,
  type UpdateQuantityInput,
  type VerifiedEvent,
} from "@/lib/billing/gateway";
import type { BillingPeriod } from "@/lib/pricing/schedule";

/**
 * The live Stripe implementation.
 *
 * The only module in the codebase that imports the Stripe SDK. Everything
 * else talks to `StripeGateway`, which is what keeps the version-specific
 * field paths below in one file — and there are two of them that have already
 * broken other people's integrations:
 *
 * - **The billing period is on the subscription item, not the subscription.**
 *   `2025-03-31.basil` removed `Subscription.current_period_start`/`_end`. Code
 *   that reads them compiles fine against a loose type and returns `undefined`
 *   at runtime, which projects as "no period" and reads on screen as a
 *   subscription that renews never.
 * - **`Invoice.subscription` is now `Invoice.parent.subscription_details
 *   .subscription`.** Same failure shape: an invoice event that cannot find
 *   its subscription resolves no tenant and fails every delivery.
 *
 * `normalizeSubscription` and `readEvent` are the only two places either path
 * appears.
 */

/**
 * Pinned deliberately, and pinned to what this SDK ships against.
 *
 * `stripe@22.5.0` sets `ApiVersion = '2026-07-29.dahlia'`, and the type below
 * is the SDK's own `LatestApiVersion`, so a version bump that moves the API
 * forward fails to compile here rather than silently sending a version the
 * installed types do not describe.
 *
 * The webhook endpoint registered in the Stripe Dashboard must be on this same
 * version. If it is not, events arrive shaped for a different one and the
 * field paths above are wrong again.
 */
export const STRIPE_API_VERSION: Stripe.LatestApiVersion = "2026-07-29.dahlia";

let client: Stripe | null = null;

function stripe(): Stripe {
  client ??= new Stripe(requireStripeSecretKey(), {
    apiVersion: STRIPE_API_VERSION,
    // Named so a Stripe support conversation can find Lia's requests, and so
    // the Dashboard's request log is legible.
    appInfo: { name: "Lia", url: "https://lia.bond" },
    // Two retries on a network failure. Every call Lia makes that changes
    // anything carries an idempotency key, so a retry cannot double an effect.
    maxNetworkRetries: 2,
  });
  return client;
}

/**
 * Price ids, resolved from lookup keys once per process.
 *
 * Lookup keys are Lia's own and identical across sandbox and live; price ids
 * are Stripe's and differ. Resolving at runtime rather than storing an id in
 * an environment variable means a mode is switched by changing one key, and a
 * missing price fails with the key's name rather than with a Stripe error
 * about an id nobody recognises.
 */
const priceIdCache = new Map<BillingPeriod, string>();

async function resolvePriceId(period: BillingPeriod): Promise<string> {
  const cached = priceIdCache.get(period);
  if (cached) return cached;

  const lookupKey = PRICE_LOOKUP_KEYS[period];
  const found = await stripe().prices.list({
    lookup_keys: [lookupKey],
    active: true,
    limit: 1,
  });

  const price = found.data[0];
  if (!price) {
    throw new Error(
      `No active Stripe price with lookup key "${lookupKey}". Run npm run stripe:catalog against this mode.`,
    );
  }

  priceIdCache.set(period, price.id);
  return price.id;
}

/** Stripe's id, or null — the SDK types every reference as `string | object`. */
function idOf(value: string | { id: string } | null | undefined): string | null {
  if (value === null || value === undefined) return null;
  return typeof value === "string" ? value : value.id;
}

function toIso(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined) return null;
  return new Date(seconds * 1000).toISOString();
}

/**
 * A Stripe subscription, flattened to what Lia projects.
 *
 * Throws rather than guessing when the shape is not what Lia sells. A
 * subscription with no items, or with several, is not something this product
 * can create — one product, one price, one quantity — so encountering one
 * means either a hand-edited subscription in the Dashboard or a bug, and both
 * need a person rather than a projection assembled from the first item that
 * happened to be returned.
 */
function normalizeSubscription(subscription: Stripe.Subscription): CanonicalSubscription {
  const items = subscription.items.data;
  const item = items[0];

  if (!item || items.length !== 1) {
    throw new Error(
      `Subscription ${subscription.id} has ${items.length} items; Lia sells exactly one.`,
    );
  }

  const customerId = idOf(subscription.customer);
  if (!customerId) {
    throw new Error(`Subscription ${subscription.id} has no customer.`);
  }

  // Parsed rather than compared, for the same reason `status` is below:
  // Stripe types `interval` as an open string union, so a `!==` check narrows
  // nothing and a cast would let `week` through into a projection that claims
  // to be annual.
  const rawInterval = item.price.recurring?.interval;
  const intervalParse = billingIntervalSchema.safeParse(rawInterval);
  if (!intervalParse.success) {
    throw new Error(
      `Subscription ${subscription.id} bills on an interval Lia does not sell: ${String(rawInterval)}.`,
    );
  }
  const interval: BillingInterval = intervalParse.data;

  // Not `subscription.status as SubscriptionStatus`: Stripe may add a status,
  // and a cast would let an unknown word through into the projection and out
  // to `resolveEntitlement`, which would fall off the end of its switch. The
  // parse turns that into a loud failure at the boundary.
  const status: SubscriptionStatus = subscriptionStatusSchema.parse(subscription.status);

  return {
    id: subscription.id,
    customerId,
    itemId: item.id,
    priceId: item.price.id,
    interval,
    status,
    quantity: item.quantity ?? 1,
    // The Basil move: both of these live on the item.
    currentPeriodStart: toIso(item.current_period_start),
    currentPeriodEnd: toIso(item.current_period_end),
    cancelAtPeriodEnd: subscription.cancel_at_period_end,
    trialStart: toIso(subscription.trial_start),
    trialEnd: toIso(subscription.trial_end),
    organizationIdHint: subscription.metadata?.["lia_organization_id"] ?? null,
  };
}

/**
 * The tenant and subscription an event concerns, across the shapes it can take.
 *
 * Every branch here is a different Stripe object with a different place to look
 * for the same two facts. Doing it once means the route dispatches on a type
 * and never digs through a payload.
 */
function readEvent(event: Stripe.Event): VerifiedEvent {
  const object = event.data.object as unknown as Record<string, unknown>;

  let customerId: string | null = null;
  let subscriptionId: string | null = null;
  let isFirstCharge = false;
  let organizationIdHint: string | null = null;

  if (event.type.startsWith("customer.subscription.")) {
    const subscription = event.data.object as Stripe.Subscription;
    customerId = idOf(subscription.customer);
    subscriptionId = subscription.id;
    organizationIdHint = subscription.metadata?.["lia_organization_id"] ?? null;
  } else if (event.type.startsWith("invoice.")) {
    const invoice = event.data.object as Stripe.Invoice;
    customerId = idOf(invoice.customer);
    // The second Basil move.
    subscriptionId = idOf(invoice.parent?.subscription_details?.subscription);
    // Whether this invoice is the subscription's *first*, which is what
    // separates "never converted" from "lapsed after a year of paying".
    //
    // Only the unambiguous half is decided here: `subscription_create` is
    // definitionally the first invoice. The other case — the cycle invoice
    // that ends a trial — cannot be told apart from an ordinary renewal by
    // looking at the invoice alone, because both carry `subscription_cycle`.
    // That one needs Lia's own projection (a trial that started and has not
    // converted), so the service layer decides it and this stays honest about
    // what the payload can support.
    isFirstCharge = invoice.billing_reason === "subscription_create";
    organizationIdHint =
      invoice.parent?.subscription_details?.metadata?.["lia_organization_id"] ?? null;
  } else if (event.type.startsWith("checkout.session.")) {
    const session = event.data.object as Stripe.Checkout.Session;
    customerId = idOf(session.customer);
    subscriptionId = idOf(session.subscription);
    organizationIdHint =
      session.metadata?.["lia_organization_id"] ?? session.client_reference_id ?? null;
  }

  return {
    id: event.id,
    type: event.type,
    livemode: event.livemode,
    createdAt: new Date(event.created * 1000).toISOString(),
    objectId: typeof object["id"] === "string" ? object["id"] : null,
    customerId,
    subscriptionId,
    isFirstCharge,
    organizationIdHint,
  };
}

export function createStripeGateway(): StripeGateway {
  return {
    async ensureCustomer(input: EnsureCustomerInput) {
      const customer = await stripe().customers.create(
        {
          email: input.email ?? undefined,
          name: input.name ?? undefined,
          // Correlation only. The webhook resolves tenants through
          // organization_billing, never through this.
          metadata: { lia_organization_id: input.organizationId },
        },
        // Keyed on the organization, so a double-submitted first Checkout
        // cannot leave two customers behind — which would be two billing
        // relationships for one tenant and a reconciliation problem forever.
        { idempotencyKey: `customer:${input.organizationId}:v1` },
      );
      return { id: customer.id };
    },

    async createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CheckoutSession> {
      const priceId = await resolvePriceId(input.period);

      const session = await stripe().checkout.sessions.create(
        {
          mode: "subscription",
          customer: input.customerId,
          // Surfaced in the Dashboard and on the session; correlation again.
          client_reference_id: input.organizationId,
          line_items: [{ price: priceId, quantity: input.locationQuantity }],
          subscription_data: {
            ...(input.trialDays === null ? {} : { trial_period_days: input.trialDays }),
            metadata: {
              lia_organization_id: input.organizationId,
              lia_trial_grant: input.trialDays === null ? "none" : "self_service",
            },
          },
          // Always, including for trials: a card-required trial is the whole
          // v1 design, and `if_required` would silently make it cardless.
          payment_method_collection: "always",
          billing_address_collection: "required",
          success_url: input.successUrl,
          cancel_url: input.cancelUrl,
        },
        { idempotencyKey: input.idempotencyKey },
      );

      if (!session.url) {
        throw new Error(`Stripe returned a Checkout Session with no URL (${session.id}).`);
      }

      return { id: session.id, url: session.url };
    },

    async createPortalSession(input: CreatePortalSessionInput) {
      const session = await stripe().billingPortal.sessions.create({
        customer: input.customerId,
        return_url: input.returnUrl,
      });
      return { url: session.url };
    },

    async retrieveSubscription(subscriptionId: string) {
      try {
        const subscription = await stripe().subscriptions.retrieve(subscriptionId);
        return normalizeSubscription(subscription);
      } catch (error) {
        if (error instanceof Stripe.errors.StripeInvalidRequestError
            && error.statusCode === 404) {
          return null;
        }
        throw error;
      }
    },

    async listSubscriptions(customerId: string) {
      const list = await stripe().subscriptions.list({
        customer: customerId,
        status: "all",
        limit: 10,
      });
      return list.data.map(normalizeSubscription);
    },

    async updateQuantity(input: UpdateQuantityInput) {
      const subscription = await stripe().subscriptions.update(
        input.subscriptionId,
        {
          items: [{ id: input.itemId, quantity: input.quantity }],
          // Prorations land on the next invoice rather than charging a card
          // today. A customer adding a restaurant on a Tuesday should not
          // discover an unexpected charge on the same Tuesday.
          proration_behavior: "create_prorations",
        },
        { idempotencyKey: input.idempotencyKey },
      );
      return normalizeSubscription(subscription);
    },

    async previewQuantityChange(
      input: PreviewQuantityChangeInput,
    ): Promise<QuantityChangePreview> {
      const subscription = await stripe().subscriptions.retrieve(input.subscriptionId);
      const current = normalizeSubscription(subscription);

      const preview = await stripe().invoices.createPreview({
        customer: current.customerId,
        subscription: input.subscriptionId,
        subscription_details: {
          items: [{ id: input.itemId, quantity: input.quantity }],
          proration_behavior: "create_prorations",
        },
      });

      const duringTrial = current.status === "trialing";

      return {
        // During a trial nothing is owed today; what the customer needs to see
        // is the revised figure for the charge that ends the trial.
        amountDueCents: duringTrial ? preview.total : preview.amount_due,
        chargedAt: duringTrial ? current.trialEnd : current.currentPeriodEnd,
        duringTrial,
      };
    },

    async constructEvent(rawBody: string, signature: string | null) {
      if (!signature) throw new WebhookSignatureError();

      try {
        // The async variant: it uses SubtleCrypto where available, which is
        // what makes this verifiable on a runtime without Node's crypto.
        const event = await stripe().webhooks.constructEventAsync(
          rawBody,
          signature,
          requireStripeWebhookSecret(),
        );
        return readEvent(event);
      } catch (error) {
        if (error instanceof Stripe.errors.StripeSignatureVerificationError) {
          // Deliberately not rethrown: the SDK's message quotes the header and
          // the payload length, and neither belongs in a log for a request
          // anybody on the internet can make.
          throw new WebhookSignatureError();
        }
        throw error;
      }
    },

    isLiveMode() {
      return isStripeLiveMode();
    },
  };
}
