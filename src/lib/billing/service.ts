import "server-only";

import {
  LIVE_SUBSCRIPTION_STATUSES,
  TRIAL_PERIOD_DAYS,
  changeCapacityInputSchema,
  emptyBilling,
  startCheckoutInputSchema,
  type OrganizationBilling,
} from "@/domain";
import { conflict, DataError, invalidInput, notFound } from "@/lib/data/errors";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import {
  MAX_SELF_SERVICE_LOCATIONS,
  chargeInCents,
  isSelfServiceQuantity,
} from "@/lib/billing/catalog";
import type { QuantityChangePreview, StripeGateway } from "@/lib/billing/gateway";
import { appOrigin } from "@/lib/env";

/**
 * Everything the product does with billing, above the gateway.
 *
 * Takes its collaborators rather than reaching for them — the shape
 * `src/lib/widgets/service.ts` uses — so the whole of this file is reachable
 * from a test with the mock gateway and the demo data source.
 *
 * ## The rule this file exists to keep
 *
 * Nothing authoritative is ever taken from the caller. The organization comes
 * from the verified `OrganizationScope`; the price comes from a lookup key in
 * the catalog; whether a trial applies comes from the stored projection; the
 * customer comes from the billing row. What a browser may send is a billing
 * period and a number of locations, and both are validated here before they
 * reach Stripe.
 *
 * Everything else — the Stripe customer id, the subscription id, the price id,
 * the trial length, the organization id — is either resolved on the server or
 * refused. `startCheckoutInputSchema` is `.strict()` so a payload carrying one
 * of them is rejected rather than silently ignored, which is the difference
 * between "we did not read that field" and "we noticed you sent it".
 */

export interface BillingContext {
  dataSource: LiaDataSource;
  scope: OrganizationScope;
  gateway: StripeGateway;
  /** ISO. Passed rather than read, so every branch is reachable in a test. */
  now: string;
}

/** The projection, or an unwritten one. Absence is a state, not an error. */
export async function loadBilling(
  context: BillingContext,
): Promise<OrganizationBilling> {
  const stored = await context.dataSource.billing.get(context.scope);
  return stored ?? emptyBilling(context.scope.organizationId, context.now);
}

/** Whether an organization already has a subscription Lia should not duplicate. */
function hasLiveSubscription(billing: OrganizationBilling): boolean {
  return (
    billing.subscriptionStatus !== null &&
    LIVE_SUBSCRIPTION_STATUSES.includes(billing.subscriptionStatus)
  );
}

export interface StartCheckoutResult {
  url: string;
  /** What the customer is committing to, echoed back for the audit entry. */
  period: "monthly" | "annual";
  locationQuantity: number;
  trialDays: number | null;
  chargeInCents: number;
}

/**
 * Create a Checkout Session, or refuse.
 *
 * The order of the checks is deliberate: cheap and local first, Stripe last.
 * The final guard is a live read from Stripe rather than the projection,
 * because there is a window between a customer completing Checkout and the
 * webhook that reports it in which the projection still says "no
 * subscription" — and that window is exactly when an impatient customer
 * presses the button again.
 */
export async function startCheckout(
  context: BillingContext,
  rawInput: unknown,
): Promise<StartCheckoutResult> {
  const input = startCheckoutInputSchema.parse(rawInput);

  // Restated here rather than trusted to the schema. The schema bounds the
  // number; this states *why* the bound exists, and it is the check that has
  // to hold for a quantity arriving from anywhere else too.
  if (!isSelfServiceQuantity(input.locationQuantity)) {
    throw invalidInput(
      `Choose between 1 and ${MAX_SELF_SERVICE_LOCATIONS} locations.`,
      {
        locationQuantity: `Choose between 1 and ${MAX_SELF_SERVICE_LOCATIONS} locations.`,
      },
    );
  }

  const billing = await loadBilling(context);

  if (hasLiveSubscription(billing)) {
    throw conflict(
      "This organization already has a subscription. Manage it from the billing page.",
    );
  }

  // A customer buying N locations must not immediately be over capacity.
  const billable = await context.dataSource.billing.countBillableLocations(context.scope);
  if (input.locationQuantity < billable) {
    const message = `This organization already has ${billable} active locations. Buy at least that many, or deactivate some first.`;
    throw invalidInput(message, { locationQuantity: message });
  }

  const customer = billing.stripeCustomerId
    ? { id: billing.stripeCustomerId }
    : await context.gateway.ensureCustomer({
        organizationId: context.scope.organizationId,
        email: null,
        name: null,
      });

  if (!billing.stripeCustomerId) {
    await context.dataSource.billing.bindCustomer(
      context.scope.organizationId,
      customer.id,
    );
  }

  // The window the projection cannot close. A completed Checkout whose webhook
  // has not landed yet looks exactly like no subscription at all from here.
  const live = await context.gateway.listSubscriptions(customer.id);
  if (live.some((subscription) => LIVE_SUBSCRIPTION_STATUSES.includes(subscription.status))) {
    throw conflict(
      "A subscription for this organization is already being set up. Refresh in a moment.",
    );
  }

  // **The trial decision, made on the server and nowhere else.**
  const trialDays = billing.trialEligible ? TRIAL_PERIOD_DAYS : null;

  const session = await context.gateway.createCheckoutSession({
    organizationId: context.scope.organizationId,
    customerId: customer.id,
    period: input.interval,
    locationQuantity: input.locationQuantity,
    trialDays,
    successUrl: `${appOrigin()}/settings/billing?checkout=complete`,
    cancelUrl: `${appOrigin()}/settings/billing?checkout=cancelled`,
    // A resubmitted form returns the same session rather than a second one.
    // Stripe holds the key for 24 hours, and every component of it is a value
    // the server resolved.
    idempotencyKey: [
      "checkout",
      context.scope.organizationId,
      input.interval,
      input.locationQuantity,
      trialDays ?? "none",
    ].join(":"),
  });

  return {
    url: session.url,
    period: input.interval,
    locationQuantity: input.locationQuantity,
    trialDays,
    chargeInCents: chargeInCents(input.interval, input.locationQuantity),
  };
}

/**
 * A hosted portal session for the organization's own customer.
 *
 * The customer id is read from the authenticated organization's row. There is
 * no parameter for it, which is what makes "a user cannot open another
 * organization's portal by changing request data" a property of the signature
 * rather than a check somebody has to remember.
 */
export async function openPortal(context: BillingContext): Promise<{ url: string }> {
  const billing = await loadBilling(context);

  if (!billing.stripeCustomerId) {
    throw notFound("Billing account");
  }

  return context.gateway.createPortalSession({
    customerId: billing.stripeCustomerId,
    returnUrl: `${appOrigin()}/settings/billing`,
  });
}

/** The guards a capacity change shares with its preview. */
async function requireCapacityChange(
  context: BillingContext,
  rawInput: unknown,
): Promise<{ billing: OrganizationBilling; quantity: number }> {
  const input = changeCapacityInputSchema.parse(rawInput);

  if (!isSelfServiceQuantity(input.locationQuantity)) {
    throw invalidInput(
      `Choose between 1 and ${MAX_SELF_SERVICE_LOCATIONS} locations.`,
      {
        locationQuantity: `Choose between 1 and ${MAX_SELF_SERVICE_LOCATIONS} locations.`,
      },
    );
  }

  const billing = await loadBilling(context);
  if (!billing.stripeSubscriptionId || !billing.stripeSubscriptionItemId) {
    throw notFound("Subscription");
  }

  const billable = await context.dataSource.billing.countBillableLocations(context.scope);
  if (input.locationQuantity < billable) {
    const message = `This organization has ${billable} active locations. Deactivate some before reducing capacity below that.`;
    throw invalidInput(message, { locationQuantity: message });
  }

  return { billing, quantity: input.locationQuantity };
}

/**
 * What a capacity change will cost, before anybody confirms it.
 *
 * Always called before `changeCapacity` from the interface. A customer
 * increasing capacity during a trial is not charged today and *is* charged
 * more when the trial ends, and that is a sentence they have to read before
 * agreeing to it rather than discover afterwards.
 */
export async function previewCapacityChange(
  context: BillingContext,
  rawInput: unknown,
): Promise<QuantityChangePreview & { quantity: number }> {
  const { billing, quantity } = await requireCapacityChange(context, rawInput);

  const preview = await context.gateway.previewQuantityChange({
    subscriptionId: billing.stripeSubscriptionId as string,
    itemId: billing.stripeSubscriptionItemId as string,
    quantity,
  });

  return { ...preview, quantity };
}

export interface CapacityChangeResult {
  quantity: number;
  previousQuantity: number | null;
  /**
   * True always, and the name is the point: what comes back from Stripe is not
   * written here. The projection lands from `customer.subscription.updated`,
   * so the screen shows a synchronising state until it does.
   *
   * That is what makes a Stripe success followed by a Lia failure a stale
   * projection rather than a divergence — there is no second write to fail.
   */
  synchronizing: true;
}

export async function changeCapacity(
  context: BillingContext,
  rawInput: unknown,
): Promise<CapacityChangeResult> {
  const { billing, quantity } = await requireCapacityChange(context, rawInput);

  if (billing.purchasedLocationQuantity === quantity) {
    throw invalidInput("That is already the purchased capacity.", {
      locationQuantity: "That is already the purchased capacity.",
    });
  }

  await context.gateway.updateQuantity({
    subscriptionId: billing.stripeSubscriptionId as string,
    itemId: billing.stripeSubscriptionItemId as string,
    quantity,
    idempotencyKey: [
      "capacity",
      context.scope.organizationId,
      billing.stripeSubscriptionId,
      quantity,
    ].join(":"),
  });

  return {
    quantity,
    previousQuantity: billing.purchasedLocationQuantity,
    synchronizing: true,
  };
}

/** Everything `/settings/billing` renders, in one read. */
export interface BillingView {
  billing: OrganizationBilling;
  billableLocations: number;
  /** Null until a subscription exists. */
  annualisedChargeInCents: number | null;
}

export async function loadBillingView(context: BillingContext): Promise<BillingView> {
  const [billing, billableLocations] = await Promise.all([
    loadBilling(context),
    context.dataSource.billing.countBillableLocations(context.scope),
  ]);

  const period = billing.billingInterval === "year" ? "annual" : "monthly";
  const quantity = billing.purchasedLocationQuantity;

  return {
    billing,
    billableLocations,
    annualisedChargeInCents:
      quantity === null || billing.billingInterval === null
        ? null
        : chargeInCents(period, quantity),
  };
}

/** Guard for the operator paths, so a misuse is a typed error not a silent write. */
export function assertOperatorGrantSource(source: string): void {
  if (source !== "operator" && source !== "sales") {
    throw new DataError(
      "invalid_input",
      "A self-service trial is granted by Checkout, not by an operator.",
    );
  }
}
