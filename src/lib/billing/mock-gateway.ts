import { createHash } from "node:crypto";
import { STRIPE_INTERVAL } from "@/lib/billing/catalog";
import {
  WebhookSignatureError,
  type CanonicalSubscription,
  type CreateCheckoutSessionInput,
  type CreatePortalSessionInput,
  type EnsureCustomerInput,
  type PreviewQuantityChangeInput,
  type QuantityChangePreview,
  type StripeGateway,
  type UpdateQuantityInput,
  type VerifiedEvent,
} from "@/lib/billing/gateway";
import { chargeInCents } from "@/lib/billing/catalog";
import type { BillingPeriod } from "@/lib/pricing/schedule";

/**
 * A deterministic Stripe, in memory.
 *
 * Implements the same nine methods the live gateway does, so every layer above
 * it — the service, the actions, the webhook route — runs unchanged against
 * this in CI and on a laptop with no Stripe account. That is what keeps
 * `STRIPE_SECRET_KEY` out of the test environment, which was a requirement
 * rather than a convenience.
 *
 * It is a **fake**, not a stub: it holds state, and the state moves the way
 * Stripe's does. Creating a session and completing it produces a subscription;
 * a trial subscription that is advanced past its trial end becomes `active`
 * or `past_due` depending on whether the payment is told to succeed. That is
 * what makes it useful for the cases worth testing — out-of-order events,
 * duplicate deliveries, a trial that converts, a first payment that fails —
 * none of which a stub returning canned values can reach.
 *
 * The test hooks (`completeCheckout`, `advanceClock`, `cancel`, `emit`) are
 * deliberately not on `StripeGateway`. Production code cannot call them
 * because production code cannot see them: it holds the interface, and the
 * interface has no way to move time.
 */

/** Signatures are real HMAC-shaped work, so the reject path is exercised. */
function sign(rawBody: string, secret: string): string {
  return `mock_${createHash("sha256").update(`${rawBody}.${secret}`).digest("hex")}`;
}

interface MockSubscription extends CanonicalSubscription {
  organizationId: string;
  period: BillingPeriod;
}

interface MockSession {
  id: string;
  organizationId: string;
  customerId: string;
  period: BillingPeriod;
  quantity: number;
  trialDays: number | null;
  completed: boolean;
}

export interface MockGatewayOptions {
  /** The secret `constructEvent` verifies against. */
  webhookSecret?: string;
  livemode?: boolean;
  /** Fixed clock. Every timestamp the fake produces derives from this. */
  now?: string;
}

export interface MockStripeGateway extends StripeGateway {
  /** Everything the fake currently holds, for assertions. */
  readonly state: {
    customers: Map<string, { organizationId: string }>;
    subscriptions: Map<string, MockSubscription>;
    sessions: Map<string, MockSession>;
    portalSessions: string[];
  };
  /** Sign a payload the way this gateway will accept it. */
  signPayload(rawBody: string): string;
  /** The customer completes Checkout. Returns the events Stripe would send. */
  completeCheckout(sessionId: string): { events: VerifiedEvent[] };
  /** Move a trialing subscription past its trial end. */
  advanceToTrialEnd(subscriptionId: string, outcome: "paid" | "failed"): {
    events: VerifiedEvent[];
  };
  /** Cancel, immediately or at period end. */
  cancel(subscriptionId: string, when: "now" | "period_end"): { events: VerifiedEvent[] };
  /** Build an arbitrary verified event, for the route's dispatch tests. */
  emit(type: string, overrides?: Partial<VerifiedEvent>): VerifiedEvent;
}

export function createMockStripeGateway(
  options: MockGatewayOptions = {},
): MockStripeGateway {
  const secret = options.webhookSecret ?? "whsec_mock";
  const livemode = options.livemode ?? false;
  const now = options.now ?? "2026-08-21T12:00:00.000Z";

  const customers = new Map<string, { organizationId: string }>();
  const subscriptions = new Map<string, MockSubscription>();
  const sessions = new Map<string, MockSession>();
  const portalSessions: string[] = [];

  let counter = 0;
  const nextId = (prefix: string) => `${prefix}_mock${(counter += 1).toString().padStart(4, "0")}`;

  const plusDays = (iso: string, days: number) => {
    const date = new Date(iso);
    date.setUTCDate(date.getUTCDate() + days);
    return date.toISOString();
  };

  const plusPeriod = (iso: string, period: BillingPeriod) => {
    const date = new Date(iso);
    if (period === "annual") date.setUTCFullYear(date.getUTCFullYear() + 1);
    else date.setUTCMonth(date.getUTCMonth() + 1);
    return date.toISOString();
  };

  let eventCounter = 0;
  function makeEvent(type: string, overrides: Partial<VerifiedEvent> = {}): VerifiedEvent {
    eventCounter += 1;
    return {
      id: `evt_mock${eventCounter.toString().padStart(4, "0")}`,
      type,
      livemode,
      createdAt: now,
      objectId: null,
      customerId: null,
      subscriptionId: null,
      isFirstCharge: false,
      organizationIdHint: null,
      ...overrides,
    };
  }

  function eventsFor(subscription: MockSubscription, type: string, extra: Partial<VerifiedEvent> = {}) {
    return makeEvent(type, {
      objectId: subscription.id,
      customerId: subscription.customerId,
      subscriptionId: subscription.id,
      organizationIdHint: subscription.organizationId,
      ...extra,
    });
  }

  function canonical(subscription: MockSubscription): CanonicalSubscription {
    // A copy, so a caller mutating what it got back cannot reach into the
    // fake's state — the same isolation a network boundary gives for free.
    return { ...subscription };
  }

  return {
    state: { customers, subscriptions, sessions, portalSessions },

    signPayload(rawBody: string) {
      return sign(rawBody, secret);
    },

    async ensureCustomer(input: EnsureCustomerInput) {
      for (const [id, record] of customers) {
        if (record.organizationId === input.organizationId) return { id };
      }
      const id = nextId("cus");
      customers.set(id, { organizationId: input.organizationId });
      return { id };
    },

    async createCheckoutSession(input: CreateCheckoutSessionInput) {
      // Stripe returns the same session for a repeated idempotency key, and so
      // does this — the duplicate-submission test depends on it.
      for (const session of sessions.values()) {
        if (
          session.organizationId === input.organizationId &&
          session.period === input.period &&
          session.quantity === input.locationQuantity &&
          session.trialDays === input.trialDays &&
          !session.completed
        ) {
          return { id: session.id, url: `https://checkout.stripe.test/${session.id}` };
        }
      }

      const id = nextId("cs");
      sessions.set(id, {
        id,
        organizationId: input.organizationId,
        customerId: input.customerId,
        period: input.period,
        quantity: input.locationQuantity,
        trialDays: input.trialDays,
        completed: false,
      });
      return { id, url: `https://checkout.stripe.test/${id}` };
    },

    async createPortalSession(input: CreatePortalSessionInput) {
      portalSessions.push(input.customerId);
      return { url: `https://portal.stripe.test/${input.customerId}` };
    },

    async retrieveSubscription(subscriptionId: string) {
      const found = subscriptions.get(subscriptionId);
      return found ? canonical(found) : null;
    },

    async listSubscriptions(customerId: string) {
      return [...subscriptions.values()]
        .filter((subscription) => subscription.customerId === customerId)
        .map(canonical);
    },

    async updateQuantity(input: UpdateQuantityInput) {
      const subscription = subscriptions.get(input.subscriptionId);
      if (!subscription) throw new Error(`No such subscription: ${input.subscriptionId}`);
      subscription.quantity = input.quantity;
      return canonical(subscription);
    },

    async previewQuantityChange(
      input: PreviewQuantityChangeInput,
    ): Promise<QuantityChangePreview> {
      const subscription = subscriptions.get(input.subscriptionId);
      if (!subscription) throw new Error(`No such subscription: ${input.subscriptionId}`);

      const duringTrial = subscription.status === "trialing";
      return {
        amountDueCents: chargeInCents(subscription.period, input.quantity),
        chargedAt: duringTrial ? subscription.trialEnd : subscription.currentPeriodEnd,
        duringTrial,
      };
    },

    async constructEvent(rawBody: string, signature: string | null) {
      if (!signature || signature !== sign(rawBody, secret)) {
        throw new WebhookSignatureError();
      }
      const parsed = JSON.parse(rawBody) as VerifiedEvent;
      return { ...makeEvent(parsed.type), ...parsed };
    },

    isLiveMode() {
      return livemode;
    },

    completeCheckout(sessionId: string) {
      const session = sessions.get(sessionId);
      if (!session) throw new Error(`No such session: ${sessionId}`);
      if (session.completed) throw new Error(`Session already completed: ${sessionId}`);
      session.completed = true;

      const trialing = session.trialDays !== null;
      const trialEnd = trialing ? plusDays(now, session.trialDays as number) : null;

      const subscription: MockSubscription = {
        id: nextId("sub"),
        customerId: session.customerId,
        itemId: nextId("si"),
        priceId: `price_mock_${session.period}`,
        interval: STRIPE_INTERVAL[session.period],
        status: trialing ? "trialing" : "active",
        quantity: session.quantity,
        currentPeriodStart: now,
        currentPeriodEnd: trialing ? trialEnd : plusPeriod(now, session.period),
        cancelAtPeriodEnd: false,
        trialStart: trialing ? now : null,
        trialEnd,
        organizationIdHint: session.organizationId,
        organizationId: session.organizationId,
        period: session.period,
      };
      subscriptions.set(subscription.id, subscription);

      const events = [
        makeEvent("checkout.session.completed", {
          objectId: session.id,
          customerId: session.customerId,
          subscriptionId: subscription.id,
          organizationIdHint: session.organizationId,
        }),
        eventsFor(subscription, "customer.subscription.created"),
      ];

      // An immediate purchase pays at once; a trial does not.
      if (!trialing) {
        events.push(
          eventsFor(subscription, "invoice.paid", { isFirstCharge: true }),
        );
      }

      return { events };
    },

    advanceToTrialEnd(subscriptionId: string, outcome: "paid" | "failed") {
      const subscription = subscriptions.get(subscriptionId);
      if (!subscription) throw new Error(`No such subscription: ${subscriptionId}`);
      if (subscription.status !== "trialing") {
        throw new Error(`Subscription ${subscriptionId} is not trialing`);
      }

      subscription.status = outcome === "paid" ? "active" : "past_due";
      subscription.currentPeriodStart = subscription.trialEnd;
      subscription.currentPeriodEnd = plusPeriod(
        subscription.trialEnd ?? now,
        subscription.period,
      );

      return {
        events: [
          eventsFor(subscription, "customer.subscription.updated"),
          eventsFor(
            subscription,
            outcome === "paid" ? "invoice.paid" : "invoice.payment_failed",
          ),
        ],
      };
    },

    cancel(subscriptionId: string, when: "now" | "period_end") {
      const subscription = subscriptions.get(subscriptionId);
      if (!subscription) throw new Error(`No such subscription: ${subscriptionId}`);

      if (when === "period_end") {
        subscription.cancelAtPeriodEnd = true;
        return { events: [eventsFor(subscription, "customer.subscription.updated")] };
      }

      // What it was cancelled *from* is not carried on the event, deliberately.
      // Whether this was a cancelled trial or a cancelled paid plan is decided
      // from Lia's own projection (trial_started_at with no trial_converted_at),
      // because that is the record that survives Stripe re-reading the
      // subscription as plainly `canceled`.
      subscription.status = "canceled";
      subscription.cancelAtPeriodEnd = false;

      return {
        events: [
          eventsFor(subscription, "customer.subscription.updated"),
          eventsFor(subscription, "customer.subscription.deleted"),
        ],
      };
    },

    emit(type: string, overrides: Partial<VerifiedEvent> = {}) {
      return makeEvent(type, overrides);
    },
  };
}
