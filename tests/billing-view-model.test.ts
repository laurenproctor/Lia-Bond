import { describe, expect, it } from "vitest";
import { ENTITLEMENT_REASONS } from "@/domain/enums";
import { emptyBilling, type EntitlementReason, type OrganizationBilling } from "@/domain";
import {
  billingBannerView,
  billingHeadline,
  billingStatusView,
  trialCountdownLabel,
  trialCountdownTone,
} from "@/lib/view-models/billing";
import type { Entitlement } from "@/lib/billing/entitlement";

/**
 * The copy rules, asserted rather than reviewed.
 *
 * Three of these are commitments rather than preferences — automatic renewal
 * is always disclosed, no trial state invents urgency early, and no payment
 * warning names a deadline Lia cannot know — and each is the kind of thing
 * that erodes one careless edit at a time unless a test holds it.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-08-21T12:00:00.000Z";

function billing(overrides: Partial<OrganizationBilling> = {}): OrganizationBilling {
  return { ...emptyBilling(ORG, NOW), ...overrides };
}

function entitlement(reason: EntitlementReason, overrides: Partial<Entitlement> = {}): Entitlement {
  return {
    access: "full",
    reason,
    paidThrough: null,
    trialDaysRemaining: null,
    firstChargeAt: null,
    billingRoutesAvailable: true,
    ...overrides,
  };
}

describe("every state renders", () => {
  it("has a badge for every reason the entitlement function can produce", () => {
    for (const reason of ENTITLEMENT_REASONS) {
      const view = billingStatusView(entitlement(reason));
      expect(view.label, reason).toBeTruthy();
      expect(view.tone, reason).toBeTruthy();
    }
  });

  it("has a headline for every reason, and never an empty one", () => {
    for (const reason of ENTITLEMENT_REASONS) {
      const text = billingHeadline(entitlement(reason), billing(), 59_000);
      expect(text.length, reason).toBeGreaterThan(20);
    }
  });

  it("decides a banner, or deliberately none, for every reason", () => {
    for (const reason of ENTITLEMENT_REASONS) {
      // Must not throw; null is a valid, meaningful answer.
      expect(() => billingBannerView(entitlement(reason), billing())).not.toThrow();
    }
  });
});

describe("automatic renewal is always disclosed", () => {
  it("says so in the trial headline", () => {
    const text = billingHeadline(
      entitlement("trialing", { trialDaysRemaining: 7 }),
      billing({ trialEnd: "2026-09-04T12:00:00.000Z" }),
      59_000,
    );
    expect(text).toMatch(/automatically/i);
    expect(text).toContain("September 4, 2026");
    expect(text).toContain("$590");
    expect(text).toMatch(/cancel any time/i);
  });

  it("says so in the trial banner", () => {
    const view = billingBannerView(
      entitlement("trialing", { trialDaysRemaining: 3 }),
      billing({ trialEnd: "2026-09-04T12:00:00.000Z" }),
    );
    expect(view?.message).toMatch(/automatically/i);
  });

  it("says so for an active subscription too", () => {
    const text = billingHeadline(
      entitlement("active"),
      billing({ currentPeriodEnd: "2027-01-15T00:00:00.000Z" }),
      108_000,
    );
    expect(text).toMatch(/renews automatically/i);
    expect(text).toContain("$1,080");
  });
});

describe("restraint", () => {
  it("stays quiet for the first week of a trial", () => {
    for (const days of [14, 10, 8]) {
      expect(
        billingBannerView(entitlement("trialing", { trialDaysRemaining: days }), billing()),
        `${days} days`,
      ).toBeNull();
    }
  });

  it("speaks up at a week, without alarm", () => {
    const view = billingBannerView(
      entitlement("trialing", { trialDaysRemaining: 7 }),
      billing({ trialEnd: "2026-08-28T12:00:00.000Z" }),
    );
    expect(view?.tone).toBe("info");
  });

  it("raises the tone only on the last day", () => {
    expect(trialCountdownTone(7)).toBe("purple");
    expect(trialCountdownTone(3)).toBe("purple");
    expect(trialCountdownTone(1)).toBe("amber");
    expect(trialCountdownTone(0)).toBe("amber");
  });

  it("counts in whole days and never renders a clock", () => {
    expect(trialCountdownLabel(7)).toBe("7 days left");
    expect(trialCountdownLabel(1)).toBe("1 day left");
    expect(trialCountdownLabel(0)).toBe("Ends today");
    expect(trialCountdownLabel(null)).toBeNull();
  });

  it("says nothing at all when a subscription is healthy", () => {
    expect(billingBannerView(entitlement("active"), billing())).toBeNull();
    expect(billingBannerView(entitlement("complimentary"), billing())).toBeNull();
    // Cancelled but paid through: a statement for the billing page, not a
    // banner following somebody around the product.
    expect(billingBannerView(entitlement("canceled_paid_through"), billing())).toBeNull();
  });
});

describe("payment problems", () => {
  /**
   * Lia does not know Stripe's retry schedule, so it must not imply one. A
   * date invented here would contradict the one Stripe is actually acting on.
   */
  it("names no cut-off date for a failed payment", () => {
    const text = billingHeadline(entitlement("payment_past_due"), billing(), 59_000);
    expect(text).not.toMatch(/\b\d{1,2} (January|February|March|April|May|June|July|August|September|October|November|December)\b/);
    expect(text).not.toMatch(/within \d+ days/i);
    expect(text).toMatch(/update your payment method/i);
  });

  it("says the product still works while a card is being retried", () => {
    const text = billingHeadline(entitlement("payment_past_due"), billing(), null);
    expect(text).toMatch(/keeps working/i);
  });

  it("promises the data is intact in every terminal state", () => {
    for (const reason of [
      "trial_canceled",
      "trial_expired",
      "subscription_canceled",
    ] as const) {
      expect(billingHeadline(entitlement(reason), billing(), null)).toMatch(
        /still here/i,
      );
    }
  });

  it("tells a cancelled trial it was not charged", () => {
    expect(billingHeadline(entitlement("trial_canceled"), billing(), null)).toMatch(
      /nothing was charged/i,
    );
    expect(billingHeadline(entitlement("trial_expired"), billing(), null)).toMatch(
      /nothing was charged/i,
    );
  });
});

describe("read-only messaging", () => {
  it("leads with the data being safe, not with the money", () => {
    const view = billingBannerView(entitlement("subscription_canceled"), billing());
    expect(view?.tone).toBe("danger");
    expect(view?.message).toMatch(/data is all still here/i);
  });

  it("invites rather than warns while enforcement is off", () => {
    const view = billingBannerView(entitlement("unbilled_not_enforced"), billing());
    expect(view?.tone).toBe("info");
    expect(view?.message).toMatch(/14-day free trial/i);
  });
});
