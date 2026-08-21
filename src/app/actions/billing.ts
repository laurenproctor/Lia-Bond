"use server";

import { revalidatePath } from "next/cache";
import { authorize } from "@/lib/actions/guard";
import { runAction, type ActionResult } from "@/lib/actions/result";
import { recordAuditEvent } from "@/lib/audit/record";
import { getStripeGateway } from "@/lib/billing/registry";
import {
  changeCapacity,
  openPortal,
  previewCapacityChange,
  startCheckout,
  type CapacityChangeResult,
  type StartCheckoutResult,
} from "@/lib/billing/service";
import type { QuantityChangePreview } from "@/lib/billing/gateway";

/**
 * Billing server actions.
 *
 * Every one goes through `authorize("billing.manage")`, and none of them is
 * the only check: the service re-derives the organization from the verified
 * scope, resolves the Stripe customer from the billing row rather than from
 * anything a caller sent, and the repositories are organization-scoped by
 * type. Underneath all of that, `20260821000500` grants no session any write
 * on `organization_billing` at all.
 *
 * `billing.manage` is marked as **not** requiring paid access, so these four
 * keep working when everything else has gone read-only. An organization that
 * cannot reach its own billing cannot fix the thing blocking it.
 *
 * ## What these actions deliberately do not do
 *
 * None of them writes a billing row. Checkout returns a URL and the browser
 * leaves; capacity changes call Stripe and stop. The projection lands from
 * `customer.subscription.updated`, which is what keeps a Stripe success
 * followed by a Lia failure a *stale projection* rather than a divergence —
 * there is no second write to fail. Both screens show a synchronising state
 * until the webhook has landed, and neither treats a redirect as evidence of
 * anything.
 */

const BILLING_PATH = "/settings/billing";

/**
 * Start Checkout and hand back the Stripe URL.
 *
 * Returns the URL rather than redirecting, because `redirect()` inside a
 * server action throws a control-flow exception that `runAction` would catch
 * and report as a failure. The caller navigates.
 */
export async function startBillingCheckoutAction(
  input: unknown,
): Promise<ActionResult<StartCheckoutResult>> {
  return runAction("billing.checkout", async () => {
    const context = await authorize("billing.manage");

    const result = await startCheckout(
      {
        dataSource: context.dataSource,
        scope: context.scope,
        gateway: getStripeGateway(),
        now: new Date().toISOString(),
      },
      input,
    );

    // Recorded before the customer has paid anything, and named accordingly:
    // this is the record that an offer was made and taken up, which is the
    // only durable evidence of *what was shown* if somebody later disputes
    // what they agreed to. Metadata carries the quantity, the interval, the
    // trial length, and the amount in cents — no card, no customer name.
    await recordAuditEvent(context, {
      eventType: "billing.checkout_started",
      entityType: "organization_billing",
      entityId: context.organization.id,
      previousState: null,
      newState: null,
      metadata: {
        billingPeriod: result.period,
        locationQuantity: result.locationQuantity,
        trialOffered: result.trialDays !== null,
        trialDays: result.trialDays,
        chargeInCents: result.chargeInCents,
      },
    });

    revalidatePath(BILLING_PATH);
    return result;
  });
}

/**
 * Open Stripe's hosted customer portal.
 *
 * Audited because everything that happens inside the portal is invisible to
 * Lia until a webhook arrives. This entry is the only thing that ties a
 * subscription change some minutes later back to whoever went looking for it.
 */
export async function openBillingPortalAction(): Promise<ActionResult<{ url: string }>> {
  return runAction("billing.portal", async () => {
    const context = await authorize("billing.manage");

    const result = await openPortal({
      dataSource: context.dataSource,
      scope: context.scope,
      gateway: getStripeGateway(),
      now: new Date().toISOString(),
    });

    await recordAuditEvent(context, {
      eventType: "billing.portal_opened",
      entityType: "organization_billing",
      entityId: context.organization.id,
      previousState: null,
      newState: null,
      metadata: {},
    });

    return result;
  });
}

/**
 * What a capacity change will cost, before anybody agrees to it.
 *
 * Not audited: nothing changed, and an audit trail that records every time
 * somebody moved a number picker is a trail nobody can read. The confirmation
 * that follows is what gets recorded.
 */
export async function previewCapacityChangeAction(
  input: unknown,
): Promise<ActionResult<QuantityChangePreview & { quantity: number }>> {
  return runAction("billing.capacity_preview", async () => {
    const context = await authorize("billing.manage");

    return previewCapacityChange(
      {
        dataSource: context.dataSource,
        scope: context.scope,
        gateway: getStripeGateway(),
        now: new Date().toISOString(),
      },
      input,
    );
  });
}

/**
 * Change purchased location capacity.
 *
 * No audit entry here, and that is deliberate rather than an omission:
 * `billing.capacity_changed` is written by
 * `apply_stripe_billing_projection` when the webhook lands, from the *actual*
 * before and after quantities. Recording it here as well would put two entries
 * in the trail for one change — and the one written here would be a claim
 * about what Lia asked for, not about what Stripe did.
 */
export async function changeBillingCapacityAction(
  input: unknown,
): Promise<ActionResult<CapacityChangeResult>> {
  return runAction("billing.capacity_change", async () => {
    const context = await authorize("billing.manage");

    const result = await changeCapacity(
      {
        dataSource: context.dataSource,
        scope: context.scope,
        gateway: getStripeGateway(),
        now: new Date().toISOString(),
      },
      input,
    );

    revalidatePath(BILLING_PATH);
    return result;
  });
}
