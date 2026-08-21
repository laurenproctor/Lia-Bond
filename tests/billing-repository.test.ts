import { beforeEach, describe, expect, it } from "vitest";
import { createDemoBillingRepository, createDemoStripeWebhookEventRepository } from "@/lib/data/demo/billing";
import { resetDemoStore } from "@/lib/data/demo/store";
import { DataError } from "@/lib/data/errors";
import type { ApplyBillingProjectionInput, OrganizationScope } from "@/lib/data/types";

/**
 * The invariants the database enforces with constraints, asserted against the
 * demo adapter that has no database to lean on.
 *
 * This file is the reason the duplication in `demo/billing.ts` is acceptable:
 * a fake that permitted what the real one refuses would make every test
 * passing against it worthless. `supabase/tests/billing-verification.sql`
 * asserts the same rules against real Postgres.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";

const scope: OrganizationScope = {
  organizationId: ORG,
  userId: "33333333-3333-4333-8333-333333333333",
  role: "owner",
};

function projection(
  overrides: Partial<ApplyBillingProjectionInput> = {},
): ApplyBillingProjectionInput {
  return {
    organizationId: ORG,
    customerId: "cus_1",
    subscriptionId: "sub_1",
    itemId: "si_1",
    priceId: "price_1",
    interval: "year",
    status: "trialing",
    quantity: 3,
    currentPeriodStart: "2026-08-21T12:00:00.000Z",
    currentPeriodEnd: "2026-09-04T12:00:00.000Z",
    cancelAtPeriodEnd: false,
    trialStart: "2026-08-21T12:00:00.000Z",
    trialEnd: "2026-09-04T12:00:00.000Z",
    trialGrantSource: "self_service",
    stripeEventId: "evt_1",
    ...overrides,
  };
}

beforeEach(() => {
  resetDemoStore();
});

describe("the billing projection", () => {
  it("returns nothing for an organization that has never reached billing", async () => {
    const repository = createDemoBillingRepository();
    expect(await repository.get(scope)).toBeNull();
  });

  it("records a trial and closes eligibility in the same write", async () => {
    const repository = createDemoBillingRepository();
    const row = await repository.applyProjection(projection());

    expect(row.subscriptionStatus).toBe("trialing");
    expect(row.trialStartedAt).toBe("2026-08-21T12:00:00.000Z");
    expect(row.trialEligible).toBe(false);
  });

  /**
   * The one-way door. Stripe delivers at least once, so a replay is not an
   * edge case — it is Tuesday. The dates a customer was told must survive it.
   */
  it("keeps the original trial dates when an event is replayed with different ones", async () => {
    const repository = createDemoBillingRepository();
    await repository.applyProjection(projection());

    const replayed = await repository.applyProjection(
      projection({
        trialStart: "2026-09-01T00:00:00.000Z",
        trialEnd: "2026-09-15T00:00:00.000Z",
        stripeEventId: "evt_2",
      }),
    );

    expect(replayed.trialStartedAt).toBe("2026-08-21T12:00:00.000Z");
    expect(replayed.trialEnd).toBe("2026-09-04T12:00:00.000Z");
  });

  it("never restores eligibility through cancellation", async () => {
    const repository = createDemoBillingRepository();
    await repository.applyProjection(projection());

    const canceled = await repository.applyProjection(
      projection({ status: "canceled", stripeEventId: "evt_3" }),
    );

    expect(canceled.trialEligible).toBe(false);
    expect(canceled.trialCanceledAt).not.toBeNull();
  });

  it("refuses a second live subscription rather than overwriting the first", async () => {
    const repository = createDemoBillingRepository();
    await repository.applyProjection(projection());

    await expect(
      repository.applyProjection(
        projection({ subscriptionId: "sub_2", stripeEventId: "evt_4" }),
      ),
    ).rejects.toBeInstanceOf(DataError);
  });

  it("allows a new subscription once the previous one is terminal", async () => {
    const repository = createDemoBillingRepository();
    await repository.applyProjection(projection());
    await repository.applyProjection(
      projection({ status: "canceled", stripeEventId: "evt_5" }),
    );

    const resubscribed = await repository.applyProjection(
      projection({
        subscriptionId: "sub_2",
        status: "active",
        trialStart: null,
        trialEnd: null,
        trialGrantSource: null,
        stripeEventId: "evt_6",
      }),
    );

    expect(resubscribed.stripeSubscriptionId).toBe("sub_2");
    // ...and the trial is still spent. A second subscription is not a second trial.
    expect(resubscribed.trialEligible).toBe(false);
    expect(resubscribed.trialStartedAt).toBe("2026-08-21T12:00:00.000Z");
  });
});

describe("customer binding", () => {
  it("is idempotent", async () => {
    const repository = createDemoBillingRepository();
    await repository.bindCustomer(ORG, "cus_a");
    const again = await repository.bindCustomer(ORG, "cus_a");
    expect(again.stripeCustomerId).toBe("cus_a");
  });

  it("refuses to rebind to a different customer", async () => {
    const repository = createDemoBillingRepository();
    await repository.bindCustomer(ORG, "cus_a");
    await expect(repository.bindCustomer(ORG, "cus_b")).rejects.toBeInstanceOf(DataError);
  });

  it("resolves the tenant by customer id and no other way", async () => {
    const repository = createDemoBillingRepository();
    await repository.bindCustomer(ORG, "cus_a");
    await repository.bindCustomer(OTHER_ORG, "cus_b");

    expect((await repository.findByCustomerId("cus_a"))?.organizationId).toBe(ORG);
    expect((await repository.findByCustomerId("cus_b"))?.organizationId).toBe(OTHER_ORG);
    expect(await repository.findByCustomerId("cus_missing")).toBeNull();
  });
});

describe("trial grants", () => {
  it("refuses to issue a self-service trial by hand", async () => {
    const repository = createDemoBillingRepository();
    await expect(
      repository.grantTrial({
        organizationId: ORG,
        grantSource: "self_service",
        actorUserId: null,
        note: null,
      }),
    ).rejects.toBeInstanceOf(DataError);
  });

  it("re-opens eligibility by clearing the start date, the only shape allowed", async () => {
    const repository = createDemoBillingRepository();
    await repository.applyProjection(projection());

    const granted = await repository.grantTrial({
      organizationId: ORG,
      grantSource: "operator",
      actorUserId: null,
      note: "Support goodwill",
    });

    expect(granted.trialEligible).toBe(true);
    expect(granted.trialStartedAt).toBeNull();
    expect(granted.trialEnd).toBeNull();
  });
});

describe("the Stripe event log", () => {
  const event = {
    stripeEventId: "evt_dedupe",
    eventType: "customer.subscription.updated",
    stripeObjectId: "sub_1",
    livemode: false,
    stripeCreatedAt: "2026-08-21T12:00:00.000Z",
  };

  it("claims an event once", async () => {
    const events = createDemoStripeWebhookEventRepository();
    expect(await events.claim(event)).toBe("claimed");
  });

  /** A concurrent duplicate must not both proceed. */
  it("refuses a second claim while the first is in flight", async () => {
    const events = createDemoStripeWebhookEventRepository();
    await events.claim(event);
    expect(await events.claim(event)).toBe("in_progress");
  });

  it("reports a finished event as already processed, so Stripe stops retrying", async () => {
    const events = createDemoStripeWebhookEventRepository();
    await events.claim(event);
    await events.finish(event.stripeEventId, "processed");
    expect(await events.claim(event)).toBe("already_processed");
  });

  it("lets a failed event be retried, and counts the attempts", async () => {
    const events = createDemoStripeWebhookEventRepository();
    await events.claim(event);
    await events.finish(event.stripeEventId, "failed", "stripe_api_error");

    expect(await events.claim(event)).toBe("claimed");
    expect((await events.get(event.stripeEventId))?.attemptCount).toBe(2);
  });

  it("clears the error category when a retry succeeds", async () => {
    const events = createDemoStripeWebhookEventRepository();
    await events.claim(event);
    await events.finish(event.stripeEventId, "failed", "database_error");
    await events.claim(event);
    await events.finish(event.stripeEventId, "processed");

    const stored = await events.get(event.stripeEventId);
    expect(stored?.status).toBe("processed");
    expect(stored?.errorCategory).toBeNull();
    expect(stored?.processedAt).not.toBeNull();
  });

  it("treats an unhandled type as a success, not a failure", async () => {
    const events = createDemoStripeWebhookEventRepository();
    await events.claim({ ...event, eventType: "payout.created" });
    await events.finish(event.stripeEventId, "ignored");

    const stored = await events.get(event.stripeEventId);
    expect(stored?.status).toBe("ignored");
    expect(stored?.errorCategory).toBeNull();
  });
});
