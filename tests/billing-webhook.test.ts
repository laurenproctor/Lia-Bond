import { beforeEach, describe, expect, it } from "vitest";
import { createDemoBillingRepository, createDemoStripeWebhookEventRepository } from "@/lib/data/demo/billing";
import { resetDemoStore } from "@/lib/data/demo/store";
import { createMockStripeGateway, type MockStripeGateway } from "@/lib/billing/mock-gateway";
import { processStripeEvent } from "@/lib/billing/webhook";
import { WebhookSignatureError } from "@/lib/billing/gateway";
import type { LiaDataSource } from "@/lib/data/types";

/**
 * The webhook, end to end, against the fake Stripe.
 *
 * These are the tests that justify the mock being a fake rather than a stub:
 * every case below moves state through a sequence, and the interesting ones —
 * duplicate delivery, out-of-order delivery, a retried failure — are about
 * what happens when the same sequence arrives wrong.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-08-21T12:00:00.000Z";

let gateway: MockStripeGateway;
let dataSource: LiaDataSource;

/** Only the two repositories the webhook path touches. */
function makeDataSource(): LiaDataSource {
  const billing = createDemoBillingRepository();
  const stripeWebhookEvents = createDemoStripeWebhookEventRepository();
  return { billing, stripeWebhookEvents } as unknown as LiaDataSource;
}

beforeEach(() => {
  resetDemoStore();
  gateway = createMockStripeGateway({ now: NOW });
  dataSource = makeDataSource();
});

/** Walk an organization to a live trialing subscription. */
async function startTrial(quantity = 3) {
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
    idempotencyKey: "checkout:test",
  });

  const { events } = gateway.completeCheckout(session.id);
  for (const event of events) {
    await processStripeEvent({ dataSource, gateway, event, now: NOW });
  }
  return { customerId: customer.id, events };
}

describe("the trial lifecycle", () => {
  it("grants a trialing subscription and closes trial eligibility", async () => {
    await startTrial();

    const row = await dataSource.billing.findByCustomerId("cus_mock0001");
    expect(row?.subscriptionStatus).toBe("trialing");
    expect(row?.trialEligible).toBe(false);
    expect(row?.purchasedLocationQuantity).toBe(3);
    expect(row?.billingInterval).toBe("year");
    expect(row?.trialEnd).toBe("2026-09-04T12:00:00.000Z");
  });

  it("converts to active and stamps the conversion when the first charge lands", async () => {
    await startTrial();
    const subscriptionId = [...gateway.state.subscriptions.keys()][0] as string;

    const { events } = gateway.advanceToTrialEnd(subscriptionId, "paid");
    for (const event of events) {
      await processStripeEvent({ dataSource, gateway, event, now: NOW });
    }

    const row = await dataSource.billing.findByCustomerId("cus_mock0001");
    expect(row?.subscriptionStatus).toBe("active");
    expect(row?.trialConvertedAt).not.toBeNull();
    expect(row?.lastPaidAt).not.toBeNull();
  });

  it("enters recovery, not read-only, when the first charge fails", async () => {
    await startTrial();
    const subscriptionId = [...gateway.state.subscriptions.keys()][0] as string;

    const { events } = gateway.advanceToTrialEnd(subscriptionId, "failed");
    for (const event of events) {
      await processStripeEvent({ dataSource, gateway, event, now: NOW });
    }

    const row = await dataSource.billing.findByCustomerId("cus_mock0001");
    expect(row?.subscriptionStatus).toBe("past_due");
    expect(row?.firstPaymentFailedAt).not.toBeNull();
    expect(row?.trialConvertedAt).toBeNull();
  });

  it("charges nothing and keeps eligibility spent when a trial is cancelled", async () => {
    await startTrial();
    const subscriptionId = [...gateway.state.subscriptions.keys()][0] as string;

    const { events } = gateway.cancel(subscriptionId, "now");
    for (const event of events) {
      await processStripeEvent({ dataSource, gateway, event, now: NOW });
    }

    const row = await dataSource.billing.findByCustomerId("cus_mock0001");
    expect(row?.subscriptionStatus).toBe("canceled");
    expect(row?.trialCanceledAt).not.toBeNull();
    expect(row?.trialConvertedAt).toBeNull();
    expect(row?.lastPaidAt).toBeNull();
    // The door stays shut.
    expect(row?.trialEligible).toBe(false);
  });

  it("records an immediate purchase as active with no trial at all", async () => {
    const customer = await gateway.ensureCustomer({
      organizationId: ORG,
      email: null,
      name: null,
    });
    await dataSource.billing.bindCustomer(ORG, customer.id);

    const session = await gateway.createCheckoutSession({
      organizationId: ORG,
      customerId: customer.id,
      period: "monthly",
      locationQuantity: 1,
      trialDays: null,
      successUrl: "https://lia.test/ok",
      cancelUrl: "https://lia.test/no",
      idempotencyKey: "checkout:immediate",
    });

    for (const event of gateway.completeCheckout(session.id).events) {
      await processStripeEvent({ dataSource, gateway, event, now: NOW });
    }

    const row = await dataSource.billing.findByCustomerId(customer.id);
    expect(row?.subscriptionStatus).toBe("active");
    expect(row?.trialStartedAt).toBeNull();
    // Never trialled, so a trial is still available later.
    expect(row?.trialEligible).toBe(true);
  });
});

describe("delivery that arrives wrong", () => {
  it("acknowledges a duplicate without processing it twice", async () => {
    const { events } = await startTrial();
    const first = events[1];
    if (!first) throw new Error("expected a subscription event");

    const outcome = await processStripeEvent({ dataSource, gateway, event: first, now: NOW });
    expect(outcome).toEqual({ kind: "ok", detail: "duplicate" });
  });

  /**
   * Out of order is not an edge case — Stripe makes no ordering guarantee.
   * The projection survives it because every handler re-reads the subscription
   * rather than believing the payload it arrived with.
   */
  it("converges when an update arrives after the delete that followed it", async () => {
    await startTrial();
    const subscriptionId = [...gateway.state.subscriptions.keys()][0] as string;

    const stale = gateway.emit("customer.subscription.updated", {
      objectId: subscriptionId,
      customerId: "cus_mock0001",
      subscriptionId,
      organizationIdHint: ORG,
    });

    const { events } = gateway.cancel(subscriptionId, "now");
    for (const event of events) {
      await processStripeEvent({ dataSource, gateway, event, now: NOW });
    }

    // The stale update lands last, and changes nothing.
    await processStripeEvent({ dataSource, gateway, event: stale, now: NOW });

    const row = await dataSource.billing.findByCustomerId("cus_mock0001");
    expect(row?.subscriptionStatus).toBe("canceled");
  });

  it("lets a failed event be retried and succeed", async () => {
    const customer = await gateway.ensureCustomer({
      organizationId: ORG,
      email: null,
      name: null,
    });
    // Deliberately not bound, so the first delivery cannot resolve a tenant.
    const event = gateway.emit("customer.subscription.updated", {
      customerId: customer.id,
      subscriptionId: "sub_missing",
      organizationIdHint: ORG,
    });

    const first = await processStripeEvent({ dataSource, gateway, event, now: NOW });
    expect(first).toEqual({ kind: "failed", category: "unmatched_customer" });

    // The binding lands, and Stripe retries.
    await dataSource.billing.bindCustomer(ORG, customer.id);
    const second = await processStripeEvent({ dataSource, gateway, event, now: NOW });
    expect(second.kind).toBe("ok");
  });
});

describe("refusals", () => {
  it("refuses a live event on a sandbox key without storing anything", async () => {
    const event = gateway.emit("customer.subscription.updated", { livemode: true });

    const outcome = await processStripeEvent({ dataSource, gateway, event, now: NOW });

    expect(outcome).toEqual({ kind: "failed", category: "mode_mismatch" });
    // Nothing was claimed: the mode check runs before the event is recorded.
    expect(await dataSource.stripeWebhookEvents.get(event.id)).toBeNull();
  });

  it("refuses an event whose metadata names a different organization", async () => {
    await startTrial();

    const forged = gateway.emit("customer.subscription.updated", {
      customerId: "cus_mock0001",
      subscriptionId: [...gateway.state.subscriptions.keys()][0] as string,
      organizationIdHint: "99999999-9999-4999-8999-999999999999",
    });

    const outcome = await processStripeEvent({ dataSource, gateway, event: forged, now: NOW });
    expect(outcome).toEqual({ kind: "failed", category: "organization_mismatch" });
  });

  it("acknowledges a verified event type it does not handle", async () => {
    const event = gateway.emit("payout.created", { customerId: "cus_mock0001" });

    const outcome = await processStripeEvent({ dataSource, gateway, event, now: NOW });

    expect(outcome).toEqual({ kind: "ok", detail: "ignored" });
    expect((await dataSource.stripeWebhookEvents.get(event.id))?.status).toBe("ignored");
  });

  it("rejects a payload whose signature does not verify", async () => {
    const body = JSON.stringify({ id: "evt_forged", type: "invoice.paid" });

    await expect(gateway.constructEvent(body, "mock_wrong")).rejects.toBeInstanceOf(
      WebhookSignatureError,
    );
    await expect(gateway.constructEvent(body, null)).rejects.toBeInstanceOf(
      WebhookSignatureError,
    );
  });

  it("accepts a payload signed correctly", async () => {
    const body = JSON.stringify({
      id: "evt_real",
      type: "invoice.paid",
      livemode: false,
    });

    const event = await gateway.constructEvent(body, gateway.signPayload(body));
    expect(event.id).toBe("evt_real");
    expect(event.type).toBe("invoice.paid");
  });
});
