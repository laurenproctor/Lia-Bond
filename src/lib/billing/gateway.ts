import type { BillingInterval, SubscriptionStatus } from "@/domain";
import type { BillingPeriod } from "@/lib/pricing/schedule";

/**
 * The whole of Lia's Stripe surface, as an interface.
 *
 * Nine methods. Everything the product does with Stripe passes through one of
 * them, and no module outside `src/lib/billing/` imports the Stripe SDK at all.
 * Three things follow from that, and each is worth more than the indirection
 * costs:
 *
 * 1. **CI needs no Stripe credentials.** `mock-gateway.ts` implements this
 *    interface deterministically, so the entire lifecycle — checkout, trial,
 *    conversion, payment failure, cancellation, capacity change — is reachable
 *    in a unit test with no network and no key.
 *
 * 2. **The API-version traps live in one file.** Stripe's Basil release moved
 *    `current_period_start`/`_end` off the subscription and onto its items, and
 *    moved `invoice.subscription` to
 *    `invoice.parent.subscription_details.subscription`. Both are handled once,
 *    in `stripe-gateway.ts`, and `CanonicalSubscription` below is flat. The
 *    next version that moves a field breaks one file rather than twelve.
 *
 * 3. **Stripe's types stop at the boundary.** Nothing downstream can
 *    accidentally depend on a field Lia has not decided to project, which is
 *    what keeps the projection small on purpose rather than by discipline.
 *
 * ## What is deliberately absent
 *
 * No method returns a payment method, a card, an invoice line, or an amount
 * that is not being shown to a customer before they confirm something. Lia has
 * no use for any of it. The hosted portal is where cards are touched, and it
 * is Stripe's page.
 */

/**
 * A Stripe subscription, flattened to what Lia projects.
 *
 * `currentPeriodStart`/`End` and `quantity` come from the subscription *item*,
 * not the subscription — see the module comment. Presenting them at the top
 * level here is not a convenience: it is the point, because it means no caller
 * has to know that, and no caller can get it wrong.
 */
export interface CanonicalSubscription {
  id: string;
  customerId: string;
  itemId: string;
  priceId: string;
  interval: BillingInterval;
  status: SubscriptionStatus;
  quantity: number;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  cancelAtPeriodEnd: boolean;
  trialStart: string | null;
  trialEnd: string | null;
  /**
   * `metadata.lia_organization_id`, as Stripe holds it.
   *
   * **Correlation, never authorization.** The webhook resolves the tenant by
   * looking up `stripe_customer_id` in `organization_billing`; this value is
   * compared against that answer, and a mismatch is refused and alerted. It
   * exists so a human reading the Stripe Dashboard can tell whose subscription
   * they are looking at, and so that a mismatch is *detectable* — not so that
   * anything can be decided from it.
   */
  organizationIdHint: string | null;
}

/** A verified Stripe event, reduced to what the route dispatches on. */
export interface VerifiedEvent {
  id: string;
  type: string;
  livemode: boolean;
  createdAt: string;
  /** The subscription, invoice, or session the event concerns. */
  objectId: string | null;
  /**
   * The Stripe customer this event is about, where the payload carries one.
   *
   * The single field the tenant lookup runs on, which is why it is lifted out
   * of the payload here rather than dug out per event type at three different
   * call sites.
   */
  customerId: string | null;
  /** The subscription this event concerns, resolved across event shapes. */
  subscriptionId: string | null;
  /** Whether an invoice event is the first charge of a subscription. */
  isFirstCharge: boolean;
  /** `metadata.lia_organization_id` where the payload carries it. */
  organizationIdHint: string | null;
}

export interface EnsureCustomerInput {
  organizationId: string;
  email: string | null;
  name: string | null;
}

export interface CreateCheckoutSessionInput {
  organizationId: string;
  customerId: string;
  period: BillingPeriod;
  locationQuantity: number;
  /**
   * Days of trial, or null for immediate billing.
   *
   * Resolved on the server from the billing projection. It is a parameter of
   * this method and never of anything a browser can reach.
   */
  trialDays: number | null;
  successUrl: string;
  cancelUrl: string;
  /**
   * Makes a resubmitted form return the *same* session rather than a second
   * one. Stripe holds an idempotency key for 24 hours.
   */
  idempotencyKey: string;
}

export interface CheckoutSession {
  id: string;
  url: string;
}

export interface CreatePortalSessionInput {
  customerId: string;
  returnUrl: string;
}

export interface UpdateQuantityInput {
  subscriptionId: string;
  itemId: string;
  quantity: number;
  idempotencyKey: string;
}

export interface PreviewQuantityChangeInput {
  subscriptionId: string;
  itemId: string;
  quantity: number;
}

/**
 * What a quantity change will actually cost, before anybody confirms it.
 *
 * `amountDueCents` is what the next invoice comes to; `chargedAt` is when. On
 * a trialing subscription nothing is owed today and `chargedAt` is the trial's
 * end — which is exactly the sentence the confirmation dialog has to be able
 * to say, and the reason this returns both rather than a single figure.
 */
export interface QuantityChangePreview {
  amountDueCents: number;
  chargedAt: string | null;
  /** True when the subscription is still trialing, so nothing is owed now. */
  duringTrial: boolean;
}

export interface StripeGateway {
  /** Reuses the organization's customer, or creates one idempotently. */
  ensureCustomer(input: EnsureCustomerInput): Promise<{ id: string }>;

  createCheckoutSession(input: CreateCheckoutSessionInput): Promise<CheckoutSession>;

  createPortalSession(input: CreatePortalSessionInput): Promise<{ url: string }>;

  /**
   * The canonical subscription, re-read from Stripe.
   *
   * Called on every subscription-bearing webhook rather than trusting the
   * event's own payload, and that is what makes out-of-order delivery
   * harmless: an event says *what changed*, and this says *what is true*. A
   * `customer.subscription.updated` that arrives after the `deleted` that
   * followed it still projects the deleted state, because both re-read.
   */
  retrieveSubscription(subscriptionId: string): Promise<CanonicalSubscription | null>;

  /**
   * Every subscription on a customer, in any status.
   *
   * The guard that closes the window between a completed Checkout and the
   * webhook that reports it — the projection still says "no subscription", and
   * this does not.
   */
  listSubscriptions(customerId: string): Promise<CanonicalSubscription[]>;

  updateQuantity(input: UpdateQuantityInput): Promise<CanonicalSubscription>;

  previewQuantityChange(
    input: PreviewQuantityChangeInput,
  ): Promise<QuantityChangePreview>;

  /**
   * Verifies a webhook signature and returns the event, or throws.
   *
   * Takes the **raw** body. A parsed-and-restringified body is a different
   * sequence of bytes and will not verify, which is why the route reads
   * `request.text()` before anything else touches it.
   */
  constructEvent(rawBody: string, signature: string | null): Promise<VerifiedEvent>;

  /** Whether this gateway is talking to live Stripe. Compared against events. */
  isLiveMode(): boolean;
}

/** Thrown when a signature does not verify. Carries no payload, ever. */
export class WebhookSignatureError extends Error {
  constructor() {
    super("The Stripe signature on this request did not verify.");
    this.name = "WebhookSignatureError";
  }
}
