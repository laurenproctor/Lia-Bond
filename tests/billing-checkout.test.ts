import { beforeEach, describe, expect, it, vi } from "vitest";
import { createDemoBillingRepository, createDemoStripeWebhookEventRepository } from "@/lib/data/demo/billing";
import { resetDemoStore } from "@/lib/data/demo/store";
import { DataError } from "@/lib/data/errors";
import { createMockStripeGateway, type MockStripeGateway } from "@/lib/billing/mock-gateway";
import { changeCapacity, openPortal, startCheckout } from "@/lib/billing/service";
import { processStripeEvent } from "@/lib/billing/webhook";
import { REQUIRES_PAID_ACCESS, requiresPaidAccess, PERMISSIONS } from "@/lib/auth/permissions";
import type { BillingContext } from "@/lib/billing/service";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";

vi.mock("@/lib/env", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/env")>();
  return { ...actual, appOrigin: () => "https://lia.test" };
});

/**
 * The Checkout guard chain, and what it refuses.
 *
 * Every test here is about something a caller might send or a state the
 * organization might be in — never about Stripe's behaviour, which
 * `billing-webhook.test.ts` covers.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const OTHER_ORG = "22222222-2222-4222-8222-222222222222";
const NOW = "2026-08-21T12:00:00.000Z";

const scope: OrganizationScope = {
  organizationId: ORG,
  userId: "33333333-3333-4333-8333-333333333333",
  role: "owner",
};

let gateway: MockStripeGateway;
let dataSource: LiaDataSource;
let context: BillingContext;

/** Only the repositories the billing service touches. */
function makeDataSource(billableLocations: number): LiaDataSource {
  const billing = createDemoBillingRepository();
  return {
    billing: {
      ...billing,
      countBillableLocations: async () => billableLocations,
    },
    stripeWebhookEvents: createDemoStripeWebhookEventRepository(),
  } as unknown as LiaDataSource;
}

function makeContext(billableLocations = 0): BillingContext {
  dataSource = makeDataSource(billableLocations);
  return { dataSource, scope, gateway, now: NOW };
}

beforeEach(() => {
  resetDemoStore();
  gateway = createMockStripeGateway({ now: NOW });
  context = makeContext();
});

describe("what a browser may send", () => {
  it("accepts a period and a location count, and nothing else", async () => {
    const result = await startCheckout(context, { interval: "annual", locationQuantity: 3 });
    expect(result.url).toContain("https://checkout.stripe.test/");
    expect(result.locationQuantity).toBe(3);
  });

  /**
   * The `.strict()` schema. A payload carrying an authoritative value is
   * rejected rather than silently ignored, which is the difference between
   * "we did not read that field" and "we noticed you sent it".
   */
  it.each([
    ["trialDays", { trialDays: 365 }],
    ["trialEligible", { trialEligible: true }],
    ["priceId", { priceId: "price_forged" }],
    ["organizationId", { organizationId: OTHER_ORG }],
    ["customerId", { customerId: "cus_someone_else" }],
    ["subscriptionId", { subscriptionId: "sub_forged" }],
    ["amount", { amount: 1 }],
  ])("refuses a payload carrying %s", async (_label, extra) => {
    await expect(
      startCheckout(context, { interval: "annual", locationQuantity: 2, ...extra }),
    ).rejects.toThrow();
  });

  it.each([0, -1, 1.5, 101, 1000, Number.NaN])(
    "refuses a location quantity of %s",
    async (quantity) => {
      await expect(
        startCheckout(context, { interval: "annual", locationQuantity: quantity }),
      ).rejects.toThrow();
    },
  );

  it("refuses a billing period that is not one Lia sells", async () => {
    await expect(
      startCheckout(context, { interval: "weekly", locationQuantity: 1 }),
    ).rejects.toThrow();
  });
});

describe("the trial decision", () => {
  it("offers fourteen days to an eligible organization", async () => {
    const result = await startCheckout(context, { interval: "annual", locationQuantity: 1 });
    expect(result.trialDays).toBe(14);
  });

  /** The server decides, and the projection is what it reads. */
  it("offers no trial once one has been used", async () => {
    // Burn the trial through the real path.
    const first = await startCheckout(context, { interval: "annual", locationQuantity: 1 });
    expect(first.trialDays).toBe(14);

    const sessionId = [...gateway.state.sessions.keys()][0] as string;
    for (const event of gateway.completeCheckout(sessionId).events) {
      await processStripeEvent({ dataSource, gateway, event, now: NOW });
    }
    const subscriptionId = [...gateway.state.subscriptions.keys()][0] as string;
    for (const event of gateway.cancel(subscriptionId, "now").events) {
      await processStripeEvent({ dataSource, gateway, event, now: NOW });
    }

    // Cancelling did not restore eligibility, so the second purchase is
    // immediate billing.
    const second = await startCheckout(context, { interval: "annual", locationQuantity: 1 });
    expect(second.trialDays).toBeNull();
  });
});

describe("duplicate and concurrent purchase", () => {
  it("returns the same session for a resubmitted form", async () => {
    const first = await startCheckout(context, { interval: "annual", locationQuantity: 2 });
    const second = await startCheckout(context, { interval: "annual", locationQuantity: 2 });

    expect(second.url).toBe(first.url);
    expect(gateway.state.sessions.size).toBe(1);
  });

  it("refuses a second subscription once one is live", async () => {
    await startCheckout(context, { interval: "annual", locationQuantity: 1 });
    const sessionId = [...gateway.state.sessions.keys()][0] as string;
    for (const event of gateway.completeCheckout(sessionId).events) {
      await processStripeEvent({ dataSource, gateway, event, now: NOW });
    }

    await expect(
      startCheckout(context, { interval: "monthly", locationQuantity: 1 }),
    ).rejects.toBeInstanceOf(DataError);
  });

  /**
   * The window the projection cannot close: Checkout completed, webhook not
   * yet landed. The projection still says "no subscription", and this is
   * exactly when an impatient customer presses the button again.
   */
  it("refuses when Stripe has a subscription the projection has not seen", async () => {
    await startCheckout(context, { interval: "annual", locationQuantity: 1 });
    const sessionId = [...gateway.state.sessions.keys()][0] as string;
    gateway.completeCheckout(sessionId); // events deliberately not delivered

    await expect(
      startCheckout(context, { interval: "annual", locationQuantity: 1 }),
    ).rejects.toBeInstanceOf(DataError);
  });
});

describe("capacity at purchase", () => {
  it("refuses buying fewer locations than the organization already runs", async () => {
    const withFive = makeContext(5);
    await expect(
      startCheckout(withFive, { interval: "annual", locationQuantity: 3 }),
    ).rejects.toBeInstanceOf(DataError);
  });

  it("allows buying exactly as many as it runs", async () => {
    const withThree = makeContext(3);
    const result = await startCheckout(withThree, {
      interval: "annual",
      locationQuantity: 3,
    });
    expect(result.locationQuantity).toBe(3);
  });

  it("refuses reducing capacity below the billable count", async () => {
    await startCheckout(context, { interval: "annual", locationQuantity: 5 });
    const sessionId = [...gateway.state.sessions.keys()][0] as string;
    for (const event of gateway.completeCheckout(sessionId).events) {
      await processStripeEvent({ dataSource, gateway, event, now: NOW });
    }

    const busy: BillingContext = {
      ...context,
      dataSource: {
        ...dataSource,
        billing: { ...dataSource.billing, countBillableLocations: async () => 4 },
      } as unknown as LiaDataSource,
    };

    await expect(changeCapacity(busy, { locationQuantity: 2 })).rejects.toBeInstanceOf(
      DataError,
    );
    // ...and allows a reduction that still covers them.
    await expect(changeCapacity(busy, { locationQuantity: 4 })).resolves.toMatchObject({
      quantity: 4,
      synchronizing: true,
    });
  });
});

describe("the customer portal", () => {
  it("refuses to open one for an organization with no Stripe customer", async () => {
    await expect(openPortal(context)).rejects.toBeInstanceOf(DataError);
  });

  /**
   * The customer id is read from the authenticated organization's row and has
   * no parameter, so "a user cannot open another organization's portal by
   * changing request data" is a property of the signature.
   */
  it("opens the portal for the organization's own customer only", async () => {
    await startCheckout(context, { interval: "annual", locationQuantity: 1 });
    const { url } = await openPortal(context);

    const ours = (await dataSource.billing.get(scope))?.stripeCustomerId;
    expect(url).toContain(ours as string);
    expect(gateway.state.portalSessions).toEqual([ours]);
  });
});

describe("which actions survive a lapsed subscription", () => {
  it("decides for every permission, with no default", () => {
    for (const permission of PERMISSIONS) {
      expect(REQUIRES_PAID_ACCESS[permission], permission).toBeTypeOf("boolean");
    }
  });

  /**
   * The five exceptions, pinned. Each is something a person must be able to do
   * while their card is declined — three of them especially then.
   */
  it("keeps the emergency, consent, security, setup, and billing paths open", () => {
    expect(requiresPaidAccess("response.retract")).toBe(false);
    expect(requiresPaidAccess("integration.disconnect")).toBe(false);
    expect(requiresPaidAccess("organization.manage_members")).toBe(false);
    expect(requiresPaidAccess("onboarding.manage")).toBe(false);
    expect(requiresPaidAccess("billing.manage")).toBe(false);
  });

  it("gates ordinary product work", () => {
    expect(requiresPaidAccess("response.generate")).toBe(true);
    expect(requiresPaidAccess("response.publish")).toBe(true);
    expect(requiresPaidAccess("automation_rule.manage")).toBe(true);
    expect(requiresPaidAccess("location.create")).toBe(true);
    expect(requiresPaidAccess("monitoring.poll_now")).toBe(true);
  });
});
