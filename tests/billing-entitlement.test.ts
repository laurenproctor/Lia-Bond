import { describe, expect, it } from "vitest";
import { emptyBilling, type OrganizationBilling } from "@/domain";
import {
  isEnforced,
  resolveEntitlement,
  type BillingEnforcementMode,
} from "@/lib/billing/entitlement";
import { SUBSCRIPTION_STATUSES } from "@/domain/enums";

/**
 * The entitlement matrix, asserted row by row.
 *
 * Two properties matter more than any individual row and are asserted
 * separately at the bottom: that billing routes are reachable in every state,
 * and that no state this function can produce is capable of describing data
 * loss. Those are the promises the rest of the feature is built on.
 */

const ORG = "11111111-1111-4111-8111-111111111111";
const NOW = "2026-08-21T12:00:00.000Z";

function billing(overrides: Partial<OrganizationBilling> = {}): OrganizationBilling {
  return { ...emptyBilling(ORG, NOW), ...overrides };
}

/** Enforcement on, so the natural entitlement is what comes back unchanged. */
function enforced(overrides: Partial<OrganizationBilling> = {}) {
  return resolveEntitlement({
    billing: billing(overrides),
    enforcement: "on",
    allowlist: [],
    now: NOW,
  });
}

describe("the entitlement matrix", () => {
  it("gives a trialing organization full access, a countdown, and a charge date", () => {
    const result = enforced({
      subscriptionStatus: "trialing",
      trialStartedAt: "2026-08-14T12:00:00.000Z",
      trialEnd: "2026-08-28T12:00:00.000Z",
      trialGrantSource: "self_service",
      trialEligible: false,
    });

    expect(result.access).toBe("full");
    expect(result.reason).toBe("trialing");
    expect(result.trialDaysRemaining).toBe(7);
    expect(result.firstChargeAt).toBe("2026-08-28T12:00:00.000Z");
  });

  it("gives an active subscription full paid access", () => {
    const result = enforced({ subscriptionStatus: "active" });
    expect(result.access).toBe("full");
    expect(result.reason).toBe("active");
  });

  /**
   * The single most consequential row. A declined card must not stop a
   * restaurant answering a one-star review while somebody finds a new card.
   */
  it("keeps a past_due organization working, with a warning", () => {
    const result = enforced({ subscriptionStatus: "past_due" });
    expect(result.access).toBe("full_with_warning");
    expect(result.reason).toBe("payment_past_due");
  });

  it("keeps an incomplete setup working, with a warning", () => {
    const result = enforced({ subscriptionStatus: "incomplete" });
    expect(result.access).toBe("full_with_warning");
    expect(result.reason).toBe("billing_setup_incomplete");
  });

  it("drops an expired setup to read-only", () => {
    expect(enforced({ subscriptionStatus: "incomplete_expired" }).access).toBe(
      "read_only",
    );
  });

  it("drops an unpaid subscription to read-only", () => {
    const result = enforced({ subscriptionStatus: "unpaid" });
    expect(result.access).toBe("read_only");
    expect(result.reason).toBe("payment_unpaid");
  });

  it("drops a paused subscription to read-only", () => {
    expect(enforced({ subscriptionStatus: "paused" }).reason).toBe(
      "subscription_paused",
    );
  });
});

describe("cancellation", () => {
  it("distinguishes a trial cancelled early from one left to expire", () => {
    const cancelledEarly = enforced({
      subscriptionStatus: "canceled",
      trialStartedAt: "2026-08-14T12:00:00.000Z",
      trialEnd: "2026-08-28T12:00:00.000Z",
      trialCanceledAt: "2026-08-20T12:00:00.000Z",
      trialEligible: false,
      trialGrantSource: "self_service",
    });
    expect(cancelledEarly.reason).toBe("trial_canceled");
    expect(cancelledEarly.access).toBe("read_only");

    const expired = enforced({
      subscriptionStatus: "canceled",
      trialStartedAt: "2026-08-01T12:00:00.000Z",
      trialEnd: "2026-08-15T12:00:00.000Z",
      trialEligible: false,
      trialGrantSource: "self_service",
    });
    expect(expired.reason).toBe("trial_expired");
  });

  it("charges nothing and promises nothing when a trial is cancelled", () => {
    const result = enforced({
      subscriptionStatus: "canceled",
      trialStartedAt: "2026-08-14T12:00:00.000Z",
      trialEnd: "2026-08-28T12:00:00.000Z",
      trialCanceledAt: "2026-08-20T12:00:00.000Z",
      trialEligible: false,
      trialGrantSource: "self_service",
    });
    expect(result.paidThrough).toBeNull();
  });

  /** A paid year does not evaporate because somebody cancelled in month two. */
  it("keeps access through a period already paid for", () => {
    const result = enforced({
      subscriptionStatus: "canceled",
      trialStartedAt: "2026-01-01T00:00:00.000Z",
      trialEnd: "2026-01-15T00:00:00.000Z",
      trialConvertedAt: "2026-01-15T00:00:00.000Z",
      trialEligible: false,
      trialGrantSource: "self_service",
      currentPeriodEnd: "2027-01-15T00:00:00.000Z",
    });
    expect(result.access).toBe("full");
    expect(result.reason).toBe("canceled_paid_through");
    expect(result.paidThrough).toBe("2027-01-15T00:00:00.000Z");
  });

  it("becomes read-only once that period has ended", () => {
    const result = enforced({
      subscriptionStatus: "canceled",
      trialStartedAt: "2025-01-01T00:00:00.000Z",
      trialEnd: "2025-01-15T00:00:00.000Z",
      trialConvertedAt: "2025-01-15T00:00:00.000Z",
      trialEligible: false,
      trialGrantSource: "self_service",
      currentPeriodEnd: "2026-01-15T00:00:00.000Z",
    });
    expect(result.access).toBe("read_only");
    expect(result.reason).toBe("subscription_canceled");
  });

  /** A scheduled cancellation is a statement, not a punishment. */
  it("changes nothing while a cancellation is merely scheduled", () => {
    const result = enforced({
      subscriptionStatus: "active",
      cancelAtPeriodEnd: true,
      currentPeriodEnd: "2027-01-15T00:00:00.000Z",
    });
    expect(result.access).toBe("full");
    expect(result.reason).toBe("active");
  });
});

describe("access dispositions", () => {
  it("grants full access to an internal organization with no subscription", () => {
    const result = enforced({ accessDisposition: "internal" });
    expect(result.access).toBe("full");
    expect(result.reason).toBe("complimentary");
  });

  it("outranks a cancelled subscription", () => {
    const result = enforced({
      accessDisposition: "internal",
      subscriptionStatus: "canceled",
      currentPeriodEnd: "2020-01-01T00:00:00.000Z",
    });
    expect(result.access).toBe("full");
  });

  it("stops meaning anything once the grant has expired", () => {
    const result = enforced({
      accessDisposition: "grandfathered",
      accessDispositionExpiresAt: "2026-08-01T00:00:00.000Z",
    });
    expect(result.access).toBe("read_only");
    expect(result.reason).toBe("no_subscription");
  });

  it("still applies on its final day", () => {
    const result = enforced({
      accessDisposition: "grandfathered",
      accessDispositionExpiresAt: "2026-08-21T18:00:00.000Z",
    });
    expect(result.access).toBe("full");
    expect(result.paidThrough).toBe("2026-08-21T18:00:00.000Z");
  });
});

describe("the enforcement rollout", () => {
  it("admits nobody while off, and everybody while on", () => {
    expect(isEnforced(ORG, "off", [ORG])).toBe(false);
    expect(isEnforced(ORG, "on", [])).toBe(true);
  });

  it("admits only the named organizations while allowlisting", () => {
    expect(isEnforced(ORG, "allowlist", [ORG])).toBe(true);
    expect(isEnforced(ORG, "allowlist", ["other"])).toBe(false);
  });

  it("leaves an unbilled organization working, and says so without alarm", () => {
    const result = resolveEntitlement({
      billing: billing(),
      enforcement: "off",
      allowlist: [],
      now: NOW,
    });
    expect(result.access).toBe("full");
    expect(result.reason).toBe("unbilled_not_enforced");
  });

  it("blocks the same organization once enforcement is switched on", () => {
    expect(enforced().access).toBe("read_only");
    expect(enforced().reason).toBe("no_subscription");
  });

  /**
   * The kill switch, stated as a property: for every Stripe status, turning
   * enforcement off restores full access, and it does so without the function
   * needing to know anything had been blocked.
   */
  it("restores full access for every Stripe status when switched off", () => {
    for (const status of SUBSCRIPTION_STATUSES) {
      const result = resolveEntitlement({
        billing: billing({
          subscriptionStatus: status,
          trialStartedAt: "2026-08-01T00:00:00.000Z",
          trialEnd: "2026-08-15T00:00:00.000Z",
          trialEligible: false,
          trialGrantSource: "self_service",
        }),
        enforcement: "off",
        allowlist: [],
        now: NOW,
      });
      expect(result.access, `${status} while unenforced`).not.toBe("read_only");
    }
  });

  it("keeps telling the truth about a payment problem while unenforced", () => {
    const result = resolveEntitlement({
      billing: billing({ subscriptionStatus: "past_due" }),
      enforcement: "off",
      allowlist: [],
      now: NOW,
    });
    expect(result.access).toBe("full_with_warning");
    expect(result.reason).toBe("payment_past_due");
  });
});

describe("promises the rest of the feature depends on", () => {
  const modes: BillingEnforcementMode[] = ["off", "allowlist", "on"];

  it("never makes billing routes unreachable, in any state", () => {
    for (const status of [...SUBSCRIPTION_STATUSES, null]) {
      for (const mode of modes) {
        const result = resolveEntitlement({
          billing: billing({ subscriptionStatus: status }),
          enforcement: mode,
          allowlist: [ORG],
          now: NOW,
        });
        expect(result.billingRoutesAvailable, `${status} / ${mode}`).toBe(true);
      }
    }
  });

  it("never produces an access level worse than read-only", () => {
    for (const status of [...SUBSCRIPTION_STATUSES, null]) {
      const result = resolveEntitlement({
        billing: billing({ subscriptionStatus: status }),
        enforcement: "on",
        allowlist: [],
        now: NOW,
      });
      expect(["full", "full_with_warning", "read_only"]).toContain(result.access);
    }
  });

  it("returns a defined answer for every Stripe status", () => {
    for (const status of SUBSCRIPTION_STATUSES) {
      const result = enforced({ subscriptionStatus: status });
      expect(result.reason, `${status} should map to a reason`).toBeTruthy();
    }
  });

  it("counts a trial's last hours as a day rather than as none", () => {
    const result = enforced({
      subscriptionStatus: "trialing",
      trialStartedAt: "2026-08-07T12:00:00.000Z",
      trialEnd: "2026-08-21T20:00:00.000Z",
      trialEligible: false,
      trialGrantSource: "self_service",
    });
    expect(result.trialDaysRemaining).toBe(1);
  });

  it("floors an overdue trial countdown at zero rather than going negative", () => {
    const result = enforced({
      subscriptionStatus: "trialing",
      trialStartedAt: "2026-08-01T12:00:00.000Z",
      trialEnd: "2026-08-15T12:00:00.000Z",
      trialEligible: false,
      trialGrantSource: "self_service",
    });
    expect(result.trialDaysRemaining).toBe(0);
  });
});
