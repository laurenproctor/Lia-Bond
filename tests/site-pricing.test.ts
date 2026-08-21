import { describe, expect, it } from "vitest";
import type { PricingBand } from "@/lib/site/content/pricing";
import {
  ANNUAL_DISCOUNT_LABEL,
  ANNUAL_DISCOUNT_PERCENT,
  ANNUAL_MONTHS_BILLED,
  ANNUAL_MONTHS_FREE,
  DEFAULT_ESTIMATE_LOCATIONS,
  FIRST_LOCATION_MONTHLY,
  LISTED_LOCATION_LIMIT,
  LOCATION_CHOICES,
  LOWEST_LISTED_MONTHLY,
  PRICING_BANDS,
  PRICING_PLANS,
  SECOND_LOCATION_MONTHLY,
  annualSavingTotal,
  annualTotal,
  bandCostRange,
  annualTotalPaidMonthly,
  formatAnnualRate,
  formatBandCostRange,
  formatBandRateNote,
  formatBandSaving,
  formatBandSize,
  formatDollars,
  formatLocationChoice,
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
    // Nothing listed to discount, so no saving is invented for the quoted row.
    expect(formatBandSaving(TOP_BAND)).toBeNull();
  });

  it("prices the annual column at ten months, not twelve", () => {
    expect(formatAnnualRate(bandAt(0))).toBe("$590");
    expect(formatAnnualRate(bandAt(1))).toBe("$490");
    expect(formatAnnualRate(bandAt(2))).toBe("$440");
    expect(formatAnnualRate(bandAt(3))).toBe("$390");
    expect(formatAnnualRate(bandAt(4))).toBe("$340");
  });

  it("saves two months of the band's rate on every listed row", () => {
    expect(formatBandSaving(bandAt(0))).toBe("$118");
    expect(formatBandSaving(bandAt(1))).toBe("$98");
    expect(formatBandSaving(bandAt(2))).toBe("$88");
    expect(formatBandSaving(bandAt(3))).toBe("$78");
    expect(formatBandSaving(bandAt(4))).toBe("$68");
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
 * The toggle reprices the cards, so both faces of every card are asserted
 * here. The failure this guards against is an annual figure that is not the
 * agreed discount off twelve months — a deeper discount than the business
 * signed off, or a surcharge, depending on which way it slipped.
 */
describe("pricing plans", () => {
  const plan = (name: string) => {
    const found = PRICING_PLANS.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no pricing plan named ${name}`);
    return found;
  };

  it("leads with a per-month figure on both faces, so they compare", () => {
    // The annual face shows what a year works out at per month — $590 beside
    // $59 reads as ten times the price until you notice one buys a year.
    expect(plan("Single location").price("monthly")).toBe("$59");
    expect(plan("Single location").price("annual")).toBe("$49.17");

    expect(plan("Growth").price("monthly")).toBe("$49");
    expect(plan("Growth").price("annual")).toBe("$40.83");
  });

  it("keeps the cents rather than rounding the monthly equivalent", () => {
    // Ten twelfths of $59 is $49.166…; a rounded "$49" would understate the
    // price by two dollars a year on every location.
    expect(plan("Single location").price("annual")).not.toBe("$49");
  });

  it("names the actual charge under the per-month headline", () => {
    // The headline is a comparison; this line is what leaves the bank.
    expect(plan("Single location").billedNote("annual")).toBe(
      "$590 per location, billed once a year",
    );
    expect(plan("Growth").billedNote("annual")).toBe(
      "$490 per location, billed once a year",
    );
  });

  it("has no separate charge line on the monthly face", () => {
    // There the headline already is the charge, and repeating it would read
    // as two different numbers.
    expect(plan("Single location").billedNote("monthly")).toBeNull();
    expect(plan("Growth").billedNote("monthly")).toBeNull();
    expect(plan("Brand").billedNote("annual")).toBeNull();
  });

  it("quotes the brand card in both periods", () => {
    expect(plan("Brand").price("monthly")).toBe("Custom");
    expect(plan("Brand").price("annual")).toBe("Custom");
  });

  it("names the unit each figure is quoted in", () => {
    expect(plan("Single location").priceNote("monthly")).toBe(
      "per location, per month",
    );
    expect(plan("Single location").priceNote("annual")).toBe(
      "per location, per month",
    );
    // The floor is quoted in the same unit as the headline beside it.
    expect(plan("Growth").priceNote("monthly")).toContain("falling to $34");
    expect(plan("Growth").priceNote("annual")).toContain("falling to $28.33");
  });

  it("names the annual saving on both faces of a listed card", () => {
    expect(plan("Single location").savingNote("monthly")).toBe(
      "Save $118 a year",
    );
    expect(plan("Single location").savingNote("annual")).toBe(
      "You save $118 a year",
    );
    expect(plan("Growth").savingNote("annual")).toBe("You save $98 a year");
  });

  it("promises no saving on the card that has no listed rate", () => {
    expect(plan("Brand").savingNote("monthly")).toBeNull();
    expect(plan("Brand").savingNote("annual")).toBeNull();
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

/**
 * The annual discount is one constant, and these assert that every figure the
 * page quotes is that constant applied — not a second number typed into the
 * copy that could drift away from the prices under it.
 */
describe("the annual discount", () => {
  it("charges ten months for a year, leaving two free", () => {
    expect(ANNUAL_MONTHS_BILLED).toBe(10);
    expect(ANNUAL_MONTHS_FREE).toBe(2);
    expect(ANNUAL_MONTHS_BILLED + ANNUAL_MONTHS_FREE).toBe(12);
  });

  it("quotes a percentage that matches the months it is derived from", () => {
    expect(ANNUAL_DISCOUNT_PERCENT).toBe(Math.round((2 / 12) * 100));
    expect(ANNUAL_DISCOUNT_LABEL).toBe("2 months free");
  });

  it("bills a year at ten months of the blended monthly total", () => {
    expect(annualTotal(1)).toBe(590);
    // 12 locations: $588 a month, ten months of it.
    expect(annualTotal(DEFAULT_ESTIMATE_LOCATIONS)).toBe(5880);
    expect(annualTotalPaidMonthly(DEFAULT_ESTIMATE_LOCATIONS)).toBe(7056);
    expect(annualSavingTotal(DEFAULT_ESTIMATE_LOCATIONS)).toBe(1176);
  });

  it("saves exactly the gap between paying monthly and paying annually", () => {
    [1, 2, 10, 11, 25, 50, 100].forEach((locations) => {
      const paidMonthly = annualTotalPaidMonthly(locations);
      const paidAnnually = annualTotal(locations);
      const saved = annualSavingTotal(locations);

      expect(paidMonthly).not.toBeNull();
      expect(paidAnnually).not.toBeNull();
      expect(saved).not.toBeNull();
      expect((paidMonthly ?? 0) - (paidAnnually ?? 0)).toBe(saved);
      // A discount, in every direction it could have slipped.
      expect(paidAnnually ?? 0).toBeLessThan(paidMonthly ?? 0);
      expect(saved ?? 0).toBeGreaterThan(0);
    });
  });

  it("scales the saving with the size of the group", () => {
    expect(annualSavingTotal(20) ?? 0).toBeGreaterThan(
      annualSavingTotal(2) ?? 0,
    );
  });

  it("quotes rather than discounts above the listed range", () => {
    const beyond = LISTED_LOCATION_LIMIT + 1;
    expect(annualTotal(beyond)).toBeNull();
    expect(annualTotalPaidMonthly(beyond)).toBeNull();
    expect(annualSavingTotal(beyond)).toBeNull();
  });
});

/**
 * The estimator's dropdown. Its options are the only way a reader reaches the
 * quoted case from that control, so the list has to run past the listed range
 * rather than stopping at it.
 */
describe("estimator location choices", () => {
  it("starts at one location and only ever climbs", () => {
    expect(LOCATION_CHOICES.at(0)).toBe(1);
    LOCATION_CHOICES.reduce((previous, choice) => {
      expect(choice).toBeGreaterThan(previous);
      return choice;
    }, 0);
  });

  it("offers a count past the listed range so the quote is reachable", () => {
    expect(LOCATION_CHOICES.at(-1)).toBe(LISTED_LOCATION_LIMIT + 1);
    expect(LOCATION_CHOICES).toContain(LISTED_LOCATION_LIMIT);
  });

  it("opens on a choice it actually offers, and a priced one", () => {
    expect(LOCATION_CHOICES).toContain(DEFAULT_ESTIMATE_LOCATIONS);
    expect(monthlyTotal(DEFAULT_ESTIMATE_LOCATIONS)).not.toBeNull();
  });

  it("labels one location in the singular and the quote by its bound", () => {
    expect(formatLocationChoice(1)).toBe("1 location");
    expect(formatLocationChoice(12)).toBe("12 locations");
    expect(formatLocationChoice(LISTED_LOCATION_LIMIT)).toBe("100 locations");
    expect(formatLocationChoice(LISTED_LOCATION_LIMIT + 1)).toBe(
      "More than 100 locations",
    );
  });
});

/**
 * What the picker inside the group card shows.
 *
 * The range is the card's only price, so it has to be exactly the schedule's
 * own arithmetic: the bottom of a band is a group of `from` locations and the
 * top is a group of `to`, both priced graduated. A range that quoted the
 * band's rate times its size instead would overcharge every band above the
 * first, because it would forget the cheaper locations underneath.
 */
describe("bandCostRange", () => {
  it("prices the ends of each band as real groups of that size", () => {
    // 2 locations = 59 + 49; 10 = 59 + 9 × 49.
    expect(bandCostRange(bandAt(1))).toEqual({ min: 108, max: 500 });
    // 11 = 500 + 44; 25 = 500 + 15 × 44.
    expect(bandCostRange(bandAt(2))).toEqual({ min: 544, max: 1160 });
    // 26 = 1160 + 39; 50 = 1160 + 25 × 39.
    expect(bandCostRange(bandAt(3))).toEqual({ min: 1199, max: 2135 });
    // 51 = 2135 + 34; 100 = 2135 + 50 × 34.
    expect(bandCostRange(bandAt(4))).toEqual({ min: 2169, max: 3835 });
  });

  it("agrees with monthlyTotal at both ends of every listed band", () => {
    PRICING_BANDS.forEach((band) => {
      const range = bandCostRange(band);
      if (range === null) return;
      expect(range.min).toBe(monthlyTotal(band.from));
      expect(range.max).toBe(monthlyTotal(band.to as number));
    });
  });

  it("collapses to a single figure where the band holds one group size", () => {
    expect(bandCostRange(bandAt(0))).toEqual({ min: 59, max: 59 });
  });

  it("has no range for the quoted band, which has no top", () => {
    expect(bandCostRange(TOP_BAND)).toBeNull();
  });

  it("never overlaps the band below it", () => {
    // The cheapest group in a band must cost more than the dearest group in
    // the one beneath, or the ranges would read as alternatives rather than
    // as a ladder.
    const listed = PRICING_BANDS.map(bandCostRange).filter(
      (range): range is NonNullable<typeof range> => range !== null,
    );

    listed.reduce((previous, range) => {
      expect(range.min).toBeGreaterThan(previous.max);
      return range;
    });
  });
});

describe("formatBandCostRange", () => {
  it("renders a span for a band covering several group sizes", () => {
    expect(formatBandCostRange(bandAt(1), "monthly")).toBe("$108 – $500");
  });

  it("renders one figure where both ends are the same group", () => {
    // "$59 – $59" would read as a price that moves when it does not.
    expect(formatBandCostRange(bandAt(0), "monthly")).toBe("$59");
  });

  it("scales the whole range to the annual charge", () => {
    // Ten months billed, so both ends are ten times the monthly figure.
    expect(formatBandCostRange(bandAt(1), "annual")).toBe("$1,080 – $5,000");
    expect(formatBandCostRange(bandAt(0), "annual")).toBe("$590");
  });

  it("quotes rather than invents a range above the listed limit", () => {
    expect(formatBandCostRange(TOP_BAND, "monthly")).toBe("Custom");
    expect(formatBandCostRange(TOP_BAND, "annual")).toBe("Custom");
  });
});

describe("formatBandSize and formatBandRateNote", () => {
  it("describes the size a band covers", () => {
    expect(formatBandSize(bandAt(0))).toBe("one location");
    expect(formatBandSize(bandAt(1))).toBe("2–10 locations");
    expect(formatBandSize(TOP_BAND)).toBe(
      `more than ${LISTED_LOCATION_LIMIT} locations`,
    );
  });

  it("names the rate the range is built from", () => {
    expect(formatBandRateNote(bandAt(1), "monthly")).toBe(
      "$49 per month for each location in this band.",
    );
    expect(formatBandRateNote(bandAt(1), "annual")).toBe(
      "$490 per year for each location in this band.",
    );
  });

  it("says the quoted band is quoted rather than naming a rate", () => {
    expect(formatBandRateNote(TOP_BAND, "monthly")).toContain("Quoted");
  });
});
