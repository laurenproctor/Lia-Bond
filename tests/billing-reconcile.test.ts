import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoBillingRepository, createDemoStripeWebhookEventRepository } from "@/lib/data/demo/billing";
import { resetDemoStore } from "@/lib/data/demo/store";
import { createMockStripeGateway, type MockStripeGateway } from "@/lib/billing/mock-gateway";
import { reconcileBilling } from "@/lib/billing/reconcile";
import { processStripeEvent } from "@/lib/billing/webhook";
import type { LiaDataSource } from "@/lib/data/types";

/**
 * Reconciliation, and — more importantly — what it refuses to do.
 *
 * The repair half is easy to get right and easy to test. The half worth
 * pinning is the restraint: a scheduled job with write access to a payment
 * processor and to trial eligibility is one bug away from cancelling a paying
 * customer or handing out a second free trial, so the tests that matter here
 * assert absence.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-08-21T12:00:00.000Z";

let gateway: MockStripeGateway;
let dataSource: LiaDataSource;

function makeDataSource(billable = 0): LiaDataSource {
  const billing = createDemoBillingRepository();
  return {
    billing: { ...billing, countBillableLocations: async () => billable },
    stripeWebhookEvents: createDemoStripeWebhookEventRepository(),
  } as unknown as LiaDataSource;
}

async function subscribe(quantity = 3) {
  const customer = await gateway.ensureCustomer({
    organizationId: ORG,
    email: null,
    name: null,
  });
  await dataSource.billing.bindCustomer(ORG, customer.id);

  const session = await gateway.createCheckoutSession({
    organizationId: ORG,
    customerId: customer.id,
    period: "annual",
    locationQuantity: quantity,
    trialDays: 14,
    successUrl: "https://lia.test/ok",
    cancelUrl: "https://lia.test/no",
    idempotencyKey: "checkout:reconcile",
  });

  for (const event of gateway.completeCheckout(session.id).events) {
    await processStripeEvent({ dataSource, gateway, event, now: NOW });
  }
  return customer.id;
}

beforeEach(() => {
  resetDemoStore();
  gateway = createMockStripeGateway({ now: NOW });
  dataSource = makeDataSource();
});

describe("repair", () => {
  it("does nothing when the projection already agrees with Stripe", async () => {
    await subscribe();
    const outcome = await reconcileBilling({ dataSource, gateway, limit: 50 });

    expect(outcome.examined).toBe(1);
    expect(outcome.repaired).toBe(0);
    expect(outcome.reported).toBe(0);
  });

  /**
   * The case this job exists for: Stripe moved and the webhook never landed —
   * a disabled endpoint, an incident, or three days of retries that ran out.
   */
  it("corrects a projection left stale by a webhook that never arrived", async () => {
    await subscribe();
    const subscriptionId = [...gateway.state.subscriptions.keys()][0] as string;

    // Stripe changes; the events are deliberately dropped on the floor.
    gateway.advanceToTrialEnd(subscriptionId, "paid");
    expect((await dataSource.billing.findByCustomerId("cus_mock0001"))?.subscriptionStatus)
      .toBe("trialing");

    const outcome = await reconcileBilling({ dataSource, gateway, limit: 50 });

    expect(outcome.repaired).toBe(1);
    expect((await dataSource.billing.findByCustomerId("cus_mock0001"))?.subscriptionStatus)
      .toBe("active");
  });

  it("corrects a quantity changed outside Lia", async () => {
    await subscribe(3);
    const subscriptionId = [...gateway.state.subscriptions.keys()][0] as string;
    const itemId = gateway.state.subscriptions.get(subscriptionId)?.itemId as string;

    await gateway.updateQuantity({
      subscriptionId,
      itemId,
      quantity: 7,
      idempotencyKey: "k",
    });

    await reconcileBilling({ dataSource, gateway, limit: 50 });

    expect(
      (await dataSource.billing.findByCustomerId("cus_mock0001"))
        ?.purchasedLocationQuantity,
    ).toBe(7);
  });
});

describe("restraint", () => {
  /**
   * Stripe has no opinion about whether an organization has used its one
   * self-service trial. A job that "repaired" eligibility from Stripe's view
   * would be the one way a spent trial could come back.
   */
  it("never restores trial eligibility, whatever Stripe says", async () => {
    await subscribe();
    const before = await dataSource.billing.findByCustomerId("cus_mock0001");
    expect(before?.trialEligible).toBe(false);

    const subscriptionId = [...gateway.state.subscriptions.keys()][0] as string;
    gateway.cancel(subscriptionId, "now");

    await reconcileBilling({ dataSource, gateway, limit: 50 });

    const after = await dataSource.billing.findByCustomerId("cus_mock0001");
    expect(after?.trialEligible).toBe(false);
    expect(after?.trialStartedAt).toBe(before?.trialStartedAt);
    expect(after?.trialEnd).toBe(before?.trialEnd);
  });

  it("never mutates anything in Stripe", async () => {
    await subscribe();
    const before = structuredClone([...gateway.state.subscriptions.values()]);

    await reconcileBilling({ dataSource, gateway, limit: 50 });

    expect([...gateway.state.subscriptions.values()]).toEqual(before);
    expect(gateway.state.portalSessions).toEqual([]);
  });

  it("reports capacity below the billable count rather than changing either", async () => {
    dataSource = makeDataSource(9);
    await subscribe(3);

    const outcome = await reconcileBilling({ dataSource, gateway, limit: 50 });

    expect(outcome.reported).toBeGreaterThanOrEqual(1);
    // The purchased quantity is untouched: raising it would charge somebody
    // more than they agreed to.
    expect(
      (await dataSource.billing.findByCustomerId("cus_mock0001"))
        ?.purchasedLocationQuantity,
    ).toBe(3);
  });

  it("reports rather than repairs when Stripe has no subscription at all", async () => {
    await subscribe();
    // Stripe forgets it; Lia still has the id.
    gateway.state.subscriptions.clear();

    const outcome = await reconcileBilling({ dataSource, gateway, limit: 50 });

    expect(outcome.reported).toBe(1);
    expect(outcome.repaired).toBe(0);
    expect((await dataSource.billing.findByCustomerId("cus_mock0001"))
      ?.stripeSubscriptionId).not.toBeNull();
  });
});

describe("robustness", () => {
  it("keeps sweeping when one organization's Stripe call fails", async () => {
    await subscribe();

    const failing = {
      ...gateway,
      listSubscriptions: vi.fn(async () => {
        throw new Error("Stripe is having a day");
      }),
    } as unknown as MockStripeGateway;

    const outcome = await reconcileBilling({
      dataSource,
      gateway: failing,
      limit: 50,
    });

    expect(outcome.examined).toBe(1);
    expect(outcome.reported).toBe(1);
  });

  it("ignores organizations that never reached Stripe", async () => {
    const outcome = await reconcileBilling({ dataSource, gateway, limit: 50 });
    expect(outcome.examined).toBe(0);
  });
});
