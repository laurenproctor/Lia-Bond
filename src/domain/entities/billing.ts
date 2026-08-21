import { z } from "zod";
import {
  accessDispositionSchema,
  billingIntervalSchema,
  subscriptionStatusSchema,
  trialGrantSourceSchema,
  webhookErrorCategorySchema,
  webhookProcessingStatusSchema,
} from "@/domain/enums";
import { timestampSchema, timestampsSchema, uuidSchema } from "@/domain/primitives";
import { LISTED_LOCATION_LIMIT } from "@/lib/pricing/schedule";

/**
 * An organization's billing relationship with Stripe.
 *
 * A **projection**. Every Stripe-derived field here was copied from an object
 * re-retrieved from Stripe after a signed webhook said something changed, and
 * none of it is authoritative — which is why the entity carries no amount, no
 * invoice, and nothing resembling a payment method. Lia needs exactly enough
 * to answer "what may this organization do" and "what should the billing page
 * say"; everything else is a second copy of a fact Stripe already holds.
 *
 * Stripe ids are plain strings rather than branded types. They are opaque by
 * Stripe's own documentation — the prefixes are not guaranteed and the length
 * is capped at 255 — so a schema that validated their shape would be encoding
 * an assumption Stripe explicitly reserves the right to break.
 */
export const organizationBillingSchema = z
  .object({
    organizationId: uuidSchema,

    stripeCustomerId: z.string().min(1).max(255).nullable(),
    stripeSubscriptionId: z.string().min(1).max(255).nullable(),
    stripeSubscriptionItemId: z.string().min(1).max(255).nullable(),
    stripePriceId: z.string().min(1).max(255).nullable(),

    billingInterval: billingIntervalSchema.nullable(),
    subscriptionStatus: subscriptionStatusSchema.nullable(),
    purchasedLocationQuantity: z
      .number()
      .int()
      .min(1)
      .max(LISTED_LOCATION_LIMIT)
      .nullable(),

    currentPeriodStart: timestampSchema.nullable(),
    currentPeriodEnd: timestampSchema.nullable(),
    cancelAtPeriodEnd: z.boolean(),

    trialEligible: z.boolean(),
    trialStartedAt: timestampSchema.nullable(),
    trialEnd: timestampSchema.nullable(),
    trialConvertedAt: timestampSchema.nullable(),
    trialCanceledAt: timestampSchema.nullable(),
    trialGrantSource: trialGrantSourceSchema.nullable(),

    firstPaymentFailedAt: timestampSchema.nullable(),
    lastPaymentFailureAt: timestampSchema.nullable(),
    lastPaidAt: timestampSchema.nullable(),

    accessDisposition: accessDispositionSchema,
    accessDispositionExpiresAt: timestampSchema.nullable(),
    accessDispositionNote: z.string().nullable(),
  })
  .extend(timestampsSchema.shape);

export type OrganizationBilling = z.infer<typeof organizationBillingSchema>;

/**
 * One Stripe event, and how far Lia got processing it.
 *
 * Carries no request body and no provider message by design — see the column
 * comments in `20260821000100_billing.sql`.
 */
export const stripeWebhookEventSchema = z.object({
  stripeEventId: z.string().min(1).max(255),
  eventType: z.string().min(1).max(255),
  stripeObjectId: z.string().min(1).max(255).nullable(),
  livemode: z.boolean(),
  stripeCreatedAt: timestampSchema,
  status: webhookProcessingStatusSchema,
  attemptCount: z.number().int().min(0),
  errorCategory: webhookErrorCategorySchema.nullable(),
  receivedAt: timestampSchema,
  processedAt: timestampSchema.nullable(),
  updatedAt: timestampSchema,
});

export type StripeWebhookEvent = z.infer<typeof stripeWebhookEventSchema>;

/**
 * What the browser may send when starting Checkout.
 *
 * Two fields, and `.strict()` so a third is a *rejection* rather than a
 * silently ignored key. That distinction is the whole point: a payload
 * carrying `trialDays`, `priceId`, `organizationId`, or `trialEligible` is
 * either a bug or an attempt, and both deserve an error rather than a
 * success that quietly did something else.
 *
 * Every authoritative value — which price, which organization, which customer,
 * whether a trial applies and for how long — is resolved on the server from
 * the session and the billing projection. None of them appears here, and that
 * absence is the security property.
 */
export const startCheckoutInputSchema = z
  .object({
    interval: z.enum(["monthly", "annual"]),
    locationQuantity: z
      .number({ error: "Choose how many locations you are buying." })
      .int({ error: "Locations are whole numbers." })
      .min(1, { error: "You need at least one location." })
      .max(LISTED_LOCATION_LIMIT, {
        error: `Above ${LISTED_LOCATION_LIMIT} locations we quote to your portfolio — talk to us.`,
      }),
  })
  .strict();

export type StartCheckoutInput = z.infer<typeof startCheckoutInputSchema>;

/** Changing purchased capacity. Same posture: a quantity, and nothing else. */
export const changeCapacityInputSchema = z
  .object({
    locationQuantity: z
      .number()
      .int({ error: "Locations are whole numbers." })
      .min(1, { error: "You need at least one location." })
      .max(LISTED_LOCATION_LIMIT, {
        error: `Above ${LISTED_LOCATION_LIMIT} locations we quote to your portfolio — talk to us.`,
      }),
  })
  .strict();

export type ChangeCapacityInput = z.infer<typeof changeCapacityInputSchema>;

/**
 * A billing record that has never been written.
 *
 * Absence is a real, common state — every organization that predates billing
 * and every one that has not reached Checkout — and it needs the same shape as
 * a present row so that `resolveEntitlement` has one input type rather than a
 * nullable one. Absence fails *open*: `accessDisposition` is `standard` and
 * every Stripe field is null, which the entitlement function reads as
 * "unbilled", and what unbilled means is then decided by the enforcement mode
 * rather than by this constant.
 */
export function emptyBilling(organizationId: string, now: string): OrganizationBilling {
  return {
    organizationId,
    stripeCustomerId: null,
    stripeSubscriptionId: null,
    stripeSubscriptionItemId: null,
    stripePriceId: null,
    billingInterval: null,
    subscriptionStatus: null,
    purchasedLocationQuantity: null,
    currentPeriodStart: null,
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    trialEligible: true,
    trialStartedAt: null,
    trialEnd: null,
    trialConvertedAt: null,
    trialCanceledAt: null,
    trialGrantSource: null,
    firstPaymentFailedAt: null,
    lastPaymentFailureAt: null,
    lastPaidAt: null,
    accessDisposition: "standard",
    accessDispositionExpiresAt: null,
    accessDispositionNote: null,
    createdAt: now,
    updatedAt: now,
  };
}
