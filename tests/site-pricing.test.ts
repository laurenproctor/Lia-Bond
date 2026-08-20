import { describe, expect, it } from "vitest";
import type { PricingBand } from "@/lib/site/content/pricing";
import {
  FIRST_LOCATION_MONTHLY,
  LISTED_LOCATION_LIMIT,
  LOWEST_LISTED_MONTHLY,
  PRICING_BANDS,
  PRICING_PLANS,
  SECOND_LOCATION_MONTHLY,
  formatAnnualRate,
  formatDollars,
  formatMonthlyRate,
  monthlyTotal,
} from "@/lib/site/content/pricing";

/**
 * The published rate card is a marketing claim people are billed against, so
 * the schedule's shape is asserted here rather than trusted to review: no gap
 * or overlap between bands, rates that only ever fall, and a graduated total
 * that never reprices the locations below a boundary.
 */

/** Indexing by position, with a failure that names the missing row. */
function bandAt(index: number): PricingBand {
  const band = PRICING_BANDS[index];
  if (!band) throw new Error(`no pricing band at index ${index}`);
  return band;
}

/** `monthlyTotal` for a count the schedule is expected to list. */
function listedTotal(locations: number): number {
  const total = monthlyTotal(locations);
  if (total === null) throw new Error(`${locations} locations are not listed`);
  return total;
}

const TOP_BAND = bandAt(PRICING_BANDS.length - 1);

describe("pricing bands", () => {
  it("covers every location from one upward without gaps or overlap", () => {
    expect(bandAt(0).from).toBe(1);

    PRICING_BANDS.slice(1).forEach((band, index) => {
      const previous = bandAt(index);
      expect(previous.to).not.toBeNull();
      expect(band.from).toBe((previous.to ?? 0) + 1);
    });

    expect(TOP_BAND.to).toBeNull();
  });

  it("never raises the rate as the group grows", () => {
    const listed = PRICING_BANDS.flatMap((band) =>
      band.monthly === null ? [] : [band.monthly],
    );

    listed.reduce((previous, rate) => {
      expect(rate).toBeLessThan(previous);
      return rate;
    }, Number.POSITIVE_INFINITY);

    expect(listed.at(0)).toBe(FIRST_LOCATION_MONTHLY);
    expect(listed.at(1)).toBe(SECOND_LOCATION_MONTHLY);
    expect(listed.at(-1)).toBe(LOWEST_LISTED_MONTHLY);
  });

  it("quotes rather than lists the top band", () => {
    expect(TOP_BAND.monthly).toBeNull();
    expect(TOP_BAND.from).toBe(LISTED_LOCATION_LIMIT + 1);
    expect(formatMonthlyRate(TOP_BAND)).toBe("Custom");
    expect(formatAnnualRate(TOP_BAND)).toBe("Custom");
  });

  it("prices the annual column at exactly twelve months", () => {
    expect(formatAnnualRate(bandAt(0))).toBe("$708");
    expect(formatAnnualRate(bandAt(1))).toBe("$588");
    expect(formatAnnualRate(bandAt(2))).toBe("$528");
    expect(formatAnnualRate(bandAt(3))).toBe("$468");
    expect(formatAnnualRate(bandAt(4))).toBe("$408");
  });

  it("labels each band with the range it actually covers", () => {
    expect(bandAt(0).label).toBe("Location 1");
    expect(bandAt(1).label).toBe("Locations 2–10");
    expect(bandAt(2).label).toBe("Locations 11–25");
    expect(bandAt(3).label).toBe("Locations 26–50");
    expect(bandAt(4).label).toBe("Locations 51–100");
    expect(TOP_BAND.label).toBe("101+");
  });
});

describe("monthlyTotal", () => {
  it("charges one location the first-location rate", () => {
    expect(listedTotal(1)).toBe(59);
  });

  it("adds each further location at its own band's rate", () => {
    // 59 + 49
    expect(listedTotal(2)).toBe(108);
    // 59 + 9 × 49
    expect(listedTotal(10)).toBe(500);
    // 59 + 9 × 49 + 2 × 44 — the worked example on the page.
    expect(listedTotal(12)).toBe(588);
  });

  it("does not reprice the locations below a band boundary", () => {
    // An eleventh location costs its own band's rate and nothing more; if the
    // whole group repriced to $44 the difference would be far larger.
    expect(listedTotal(11) - listedTotal(10)).toBe(44);
    expect(listedTotal(26) - listedTotal(25)).toBe(39);
    expect(listedTotal(51) - listedTotal(50)).toBe(34);
  });

  it("stays cheaper per location the more locations there are", () => {
    const perLocation = [1, 10, 25, 50, 100].map(
      (count) => listedTotal(count) / count,
    );

    perLocation.reduce((previous, rate) => {
      expect(rate).toBeLessThan(previous);
      return rate;
    }, Number.POSITIVE_INFINITY);
  });

  it("quotes anything above the listed range", () => {
    expect(monthlyTotal(LISTED_LOCATION_LIMIT)).not.toBeNull();
    expect(monthlyTotal(LISTED_LOCATION_LIMIT + 1)).toBeNull();
  });

  it("rejects counts that are not whole locations", () => {
    expect(monthlyTotal(0)).toBeNull();
    expect(monthlyTotal(-3)).toBeNull();
    expect(monthlyTotal(2.5)).toBeNull();
  });
});

describe("formatDollars", () => {
  it("separates thousands", () => {
    expect(formatDollars(588)).toBe("$588");
    expect(formatDollars(listedTotal(100))).toBe("$3,835");
  });
});

/**
 * The toggle repriced the cards, so both faces of every card are asserted
 * here. The failure this guards against is an annual figure that is not
 * twelve times the monthly one — a discount the business never agreed to,
 * or a surcharge, depending on which way it slipped.
 */
describe("pricing plans", () => {
  const plan = (name: string) => {
    const found = PRICING_PLANS.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no pricing plan named ${name}`);
    return found;
  };

  it("shows the first-location rate on the single-location card", () => {
    expect(plan("Single location").price("monthly")).toBe("$59");
    expect(plan("Single location").price("annual")).toBe("$708");
  });

  it("shows the second-band rate on the growth card", () => {
    expect(plan("Growth").price("monthly")).toBe("$49");
    expect(plan("Growth").price("annual")).toBe("$588");
  });

  it("quotes the brand card in both periods", () => {
    expect(plan("Brand").price("monthly")).toBe("Custom");
    expect(plan("Brand").price("annual")).toBe("Custom");
  });

  it("names the unit each figure is quoted in", () => {
    expect(plan("Single location").priceNote("monthly")).toBe(
      "per month · $708 a year",
    );
    expect(plan("Single location").priceNote("annual")).toBe(
      "per year · $59 a month",
    );
    expect(plan("Growth").priceNote("monthly")).toContain("falling to $34");
    expect(plan("Growth").priceNote("annual")).toContain("falling to $408");
  });

  it("prices every card against a band on the published table", () => {
    const listed = PRICING_BANDS.flatMap((band) =>
      band.monthly === null ? [] : [formatDollars(band.monthly)],
    );

    PRICING_PLANS.forEach((candidate) => {
      const monthly = candidate.price("monthly");
      if (monthly === "Custom") return;
      expect(listed).toContain(monthly);
    });
  });

  it("marks exactly one card as the featured one", () => {
    expect(
      PRICING_PLANS.filter((candidate) => candidate.featured),
    ).toHaveLength(1);
  });
});
