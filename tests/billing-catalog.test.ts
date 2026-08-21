import { describe, expect, it } from "vitest";
import {
  MAX_SELF_SERVICE_LOCATIONS,
  PRICE_LOOKUP_KEYS,
  STRIPE_INTERVAL,
  BILLING_PERIOD,
  chargeInCents,
  firstChargeDate,
  formatCents,
  isSelfServiceQuantity,
  tiersFor,
} from "@/lib/billing/catalog";
import {
  ANNUAL_MONTHS_BILLED,
  LISTED_LOCATION_LIMIT,
  PRICING_BANDS,
  annualTotal,
  monthlyTotal,
} from "@/lib/pricing/schedule";
import { TRIAL_PERIOD_DAYS } from "@/domain/enums";

/**
 * The catalog is the one place where a mistake charges a real card the wrong
 * amount, so this file asserts the arithmetic twice over rather than once.
 *
 * `chargeInCents` walks Stripe's tier table the way Stripe walks it.
 * `monthlyTotal`/`annualTotal` walk the published band schedule the way the
 * pricing page does. They are separate implementations of the same commercial
 * rule, and the first test below compares them at *every* group size the
 * schedule lists. That is the assertion that would have caught the volume-vs-
 * graduated confusion this feature started from.
 */

describe("Stripe tiers reproduce the published rate card", () => {
  it("agrees with the pricing page at every listed group size, monthly", () => {
    for (let locations = 1; locations <= LISTED_LOCATION_LIMIT; locations += 1) {
      const published = monthlyTotal(locations);
      expect(published, `${locations} locations should be listed`).not.toBeNull();
      expect(
        chargeInCents("monthly", locations),
        `${locations} locations, monthly`,
      ).toBe((published as number) * 100);
    }
  });

  it("agrees with the pricing page at every listed group size, annual", () => {
    for (let locations = 1; locations <= LISTED_LOCATION_LIMIT; locations += 1) {
      const published = annualTotal(locations);
      expect(
        chargeInCents("annual", locations),
        `${locations} locations, annual`,
      ).toBe((published as number) * 100);
    }
  });

  /**
   * The figures from the runbook's verification step, written out as literals
   * rather than derived. A test that only compares two implementations passes
   * happily when both are wrong in the same direction; these are the numbers a
   * person checked against the Stripe Dashboard by eye.
   */
  it("charges the amounts the runbook tells an operator to verify", () => {
    expect(chargeInCents("monthly", 1)).toBe(5_900);
    expect(chargeInCents("annual", 1)).toBe(59_000);

    expect(chargeInCents("monthly", 2)).toBe(10_800);
    expect(chargeInCents("annual", 2)).toBe(108_000);

    expect(chargeInCents("monthly", 3)).toBe(15_700);
    expect(chargeInCents("annual", 3)).toBe(157_000);

    expect(chargeInCents("monthly", 10)).toBe(50_000);
    expect(chargeInCents("annual", 10)).toBe(500_000);

    expect(chargeInCents("monthly", 100)).toBe(383_500);
    expect(chargeInCents("annual", 100)).toBe(3_835_000);
  });

  it("does not reprice the locations below a band boundary", () => {
    // The eleventh location costs the 11–25 rate; the first ten keep theirs.
    const ten = chargeInCents("monthly", 10);
    const eleven = chargeInCents("monthly", 11);
    expect(eleven - ten).toBe(4_400);
  });

  it("prices a year at ten months of the monthly charge, exactly", () => {
    for (const locations of [1, 2, 7, 25, 51, 100]) {
      expect(chargeInCents("annual", locations)).toBe(
        chargeInCents("monthly", locations) * ANNUAL_MONTHS_BILLED,
      );
    }
  });

  it("leaves no fractional cent anywhere in the schedule", () => {
    for (const period of ["monthly", "annual"] as const) {
      for (const tier of tiersFor(period)) {
        expect(Number.isInteger(tier.unitAmount)).toBe(true);
      }
    }
  });
});

describe("the tier table Stripe is given", () => {
  it("ends in the unbounded tier Stripe requires", () => {
    for (const period of ["monthly", "annual"] as const) {
      const tiers = tiersFor(period);
      expect(tiers.at(-1)?.upTo).toBe("inf");
      // ...and only the last one is unbounded.
      expect(tiers.slice(0, -1).every((tier) => tier.upTo !== "inf")).toBe(true);
    }
  });

  it("has one tier per published band, in ascending order", () => {
    const tiers = tiersFor("monthly");
    expect(tiers).toHaveLength(PRICING_BANDS.length);

    const ceilings = tiers
      .slice(0, -1)
      .map((tier) => tier.upTo as number);
    expect([...ceilings].sort((a, b) => a - b)).toEqual(ceilings);
  });

  it("never raises the rate as the group grows", () => {
    const amounts = tiersFor("monthly").map((tier) => tier.unitAmount);
    for (let i = 1; i < amounts.length; i += 1) {
      expect(amounts[i]).toBeLessThanOrEqual(amounts[i - 1] as number);
    }
  });
});

describe("the self-service ceiling", () => {
  it("stops where the published schedule stops listing a rate", () => {
    expect(MAX_SELF_SERVICE_LOCATIONS).toBe(LISTED_LOCATION_LIMIT);
    expect(isSelfServiceQuantity(LISTED_LOCATION_LIMIT)).toBe(true);
    expect(isSelfServiceQuantity(LISTED_LOCATION_LIMIT + 1)).toBe(false);
  });

  it("refuses quantities that are not a whole number of locations", () => {
    for (const quantity of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(isSelfServiceQuantity(quantity), `${quantity}`).toBe(false);
    }
  });

  /**
   * Stripe's own tier table would price a 101st location perfectly happily —
   * that is what the mandatory `inf` tier means. The refusal is Lia's, and it
   * has to be, which is what this test is really pinning: the catalog can
   * compute a figure above the ceiling, and `isSelfServiceQuantity` still says
   * no. If somebody ever "fixes" the first half, the second half is what stops
   * a sale nobody agreed to.
   */
  it("can price above the ceiling but still refuses to sell there", () => {
    expect(chargeInCents("monthly", 101)).toBeGreaterThan(
      chargeInCents("monthly", 100),
    );
    expect(isSelfServiceQuantity(101)).toBe(false);
  });
});

describe("interval vocabulary", () => {
  it("round-trips between Lia's words and Stripe's", () => {
    expect(STRIPE_INTERVAL.monthly).toBe("month");
    expect(STRIPE_INTERVAL.annual).toBe("year");
    expect(BILLING_PERIOD[STRIPE_INTERVAL.monthly]).toBe("monthly");
    expect(BILLING_PERIOD[STRIPE_INTERVAL.annual]).toBe("annual");
  });

  it("keeps the lookup keys stable and distinct", () => {
    expect(PRICE_LOOKUP_KEYS.monthly).toBe("lia_location_monthly_v1");
    expect(PRICE_LOOKUP_KEYS.annual).toBe("lia_location_annual_v1");
    expect(PRICE_LOOKUP_KEYS.monthly).not.toBe(PRICE_LOOKUP_KEYS.annual);
  });
});

describe("the first charge date quoted before a card is handed over", () => {
  it("lands exactly fourteen days after the trial starts", () => {
    const start = new Date("2026-08-21T09:30:00.000Z");
    expect(firstChargeDate(start, TRIAL_PERIOD_DAYS).toISOString()).toBe(
      "2026-09-04T09:30:00.000Z",
    );
  });

  it("crosses a month boundary without losing a day", () => {
    const start = new Date("2026-01-25T00:00:00.000Z");
    expect(firstChargeDate(start, TRIAL_PERIOD_DAYS).toISOString()).toBe(
      "2026-02-08T00:00:00.000Z",
    );
  });

  /**
   * The trial ends on a wall-clock date the customer was told, and a US
   * daylight-saving transition falls inside a fourteen-day window twice a
   * year. UTC arithmetic is what keeps the promised date the delivered one.
   */
  it("is unaffected by a daylight-saving transition", () => {
    const start = new Date("2026-02-28T12:00:00.000Z");
    expect(firstChargeDate(start, TRIAL_PERIOD_DAYS).toISOString()).toBe(
      "2026-03-14T12:00:00.000Z",
    );
  });
});

describe("formatCents", () => {
  it("writes whole dollars without cents and separates thousands", () => {
    expect(formatCents(59_000)).toBe("$590");
    expect(formatCents(108_000)).toBe("$1,080");
    expect(formatCents(3_835_000)).toBe("$38,350");
  });

  it("keeps cents where the arithmetic leaves them", () => {
    expect(formatCents(1_050)).toBe("$10.50");
  });
});
