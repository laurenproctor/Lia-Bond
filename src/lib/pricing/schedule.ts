/**
 * The published per-location price schedule.
 *
 * This module is the single source of truth for what Lia charges. Two
 * consumers read it and they must never disagree: the marketing rate card
 * under `src/lib/site/content/pricing.ts`, and the Stripe catalog built by
 * `src/lib/billing/catalog.ts`. Before billing existed the schedule lived
 * inside the site module; it moved here the day a second reader appeared,
 * because a price quoted on a page and a price charged to a card that come
 * from two declarations will eventually be two different numbers.
 *
 * Pricing is graduated, not flat: a location is charged at the rate of the
 * band it falls in, the way tax brackets work. An eleventh location does not
 * reprice the first ten. `monthlyTotal` is the only implementation of that
 * rule, so neither the page's worked example nor Stripe's tier table can
 * drift from the schedule above them.
 *
 * Annual figures are never stored either — they are the monthly rate times
 * `ANNUAL_MONTHS_BILLED`, computed at render and at catalog build. The annual
 * discount is that one constant and nothing else: every annual price, every
 * saving, the badge on the toggle, the percentage in the copy, and every
 * Stripe annual tier are derived from it, so there is no second figure that
 * can disagree with the first.
 *
 * Nothing here performs I/O or formats a string. Formatting lives with the
 * page that renders it; money arithmetic lives here.
 */

export interface PricingBand {
  /** Sentence-case row label, e.g. "Locations 2–10". */
  label: string;
  /** First location covered, 1-indexed and inclusive. */
  from: number;
  /** Last location covered, inclusive. `null` is the open-ended top band. */
  to: number | null;
  /** Whole dollars per location per month. `null` means quoted, not listed. */
  monthly: number | null;
}

/**
 * `as const satisfies` rather than a plain annotation: the tuple type is what
 * lets callers index the schedule under `noUncheckedIndexedAccess` without a
 * non-null assertion, while `satisfies` still checks every row against
 * `PricingBand`.
 */
export const PRICING_BANDS = [
  { label: "Location 1", from: 1, to: 1, monthly: 59 },
  { label: "Locations 2–10", from: 2, to: 10, monthly: 49 },
  { label: "Locations 11–25", from: 11, to: 25, monthly: 44 },
  { label: "Locations 26–50", from: 26, to: 50, monthly: 39 },
  { label: "Locations 51–100", from: 51, to: 100, monthly: 34 },
  { label: "101+", from: 101, to: null, monthly: null },
] as const satisfies readonly PricingBand[];

/** The rate a single location is charged at, before any volume above it. */
export const FIRST_LOCATION_MONTHLY = 59;

/** The rate the second location — the first discounted one — is charged at. */
export const SECOND_LOCATION_MONTHLY = 49;

/** The lowest listed rate, reached at 51 locations. */
export const LOWEST_LISTED_MONTHLY = 34;

/**
 * Locations above this are quoted rather than listed.
 *
 * Also the self-service ceiling Stripe cannot express. A tiered price must end
 * in an unbounded tier (`up_to: "inf"`), so Stripe would happily bill a
 * hundred-and-first location at the top band's rate. Lia refuses it instead —
 * in the Checkout action, in the capacity action, in the
 * `purchased_location_quantity` check constraint, and in the capacity trigger
 * on `locations`. See `src/lib/billing/catalog.ts`.
 */
export const LISTED_LOCATION_LIMIT = 100;

/** Months in a year, named because the annual arithmetic reads on both. */
const MONTHS_IN_YEAR = 12;

/**
 * The annual discount, expressed the way it is actually charged: a year costs
 * ten months at the monthly rate. Everything else about the discount — the
 * saving in dollars, the percentage, the badge copy, and every annual Stripe
 * tier — is derived from this, so moving the discount is a one-line change
 * and cannot leave a stale figure behind somewhere on the page or, worse, in
 * the catalog.
 */
export const ANNUAL_MONTHS_BILLED = 10;

/** The two months a year that annual billing does not charge for. */
export const ANNUAL_MONTHS_FREE = MONTHS_IN_YEAR - ANNUAL_MONTHS_BILLED;

/**
 * The discount as a whole percentage, for the copy that quotes one.
 *
 * Rounded, so it is a headline figure rather than an exact one. The exact
 * claim is `ANNUAL_DISCOUNT_LABEL` — two months free is true to the cent.
 */
export const ANNUAL_DISCOUNT_PERCENT = Math.round(
  (ANNUAL_MONTHS_FREE / MONTHS_IN_YEAR) * 100,
);

/** The badge beside the toggle, and the exact form of the claim. */
export const ANNUAL_DISCOUNT_LABEL = `${ANNUAL_MONTHS_FREE} months free`;

/** Which figure is being quoted. */
export type BillingPeriod = "monthly" | "annual";

/** The number of months a period is charged for in one go. */
export const MONTHS_CHARGED: Record<BillingPeriod, number> = {
  monthly: 1,
  annual: ANNUAL_MONTHS_BILLED,
};

/**
 * The blended monthly bill for `locations` locations, in whole dollars.
 *
 * Returns `null` above the listed range, where the price is quoted — a number
 * there would be an invented figure, and the caller has to say "custom"
 * either way.
 *
 * This function is also the specification Stripe's graduated tiers are tested
 * against: `tests/billing-catalog.test.ts` walks every count from 1 to
 * `LISTED_LOCATION_LIMIT` and asserts the tier arithmetic reproduces it
 * exactly.
 */
export function monthlyTotal(locations: number): number | null {
  if (locations < 1 || !Number.isInteger(locations)) return null;
  if (locations > LISTED_LOCATION_LIMIT) return null;

  return PRICING_BANDS.reduce((total, band) => {
    if (band.monthly === null || locations < band.from) return total;
    const last = band.to === null ? locations : Math.min(locations, band.to);
    return total + (last - band.from + 1) * band.monthly;
  }, 0);
}

/** A year of that group's bill, paid annually. `null` where it is quoted. */
export function annualTotal(locations: number): number | null {
  const monthly = monthlyTotal(locations);
  return monthly === null ? null : monthly * ANNUAL_MONTHS_BILLED;
}

/** A year of that group's bill, paid a month at a time — the comparison. */
export function annualTotalPaidMonthly(locations: number): number | null {
  const monthly = monthlyTotal(locations);
  return monthly === null ? null : monthly * MONTHS_IN_YEAR;
}

/** What the group keeps by paying for the year up front. */
export function annualSavingTotal(locations: number): number | null {
  const monthly = monthlyTotal(locations);
  return monthly === null ? null : monthly * ANNUAL_MONTHS_FREE;
}

/** A year of one location's rate saved — the per-location table column. */
export function annualSaving(monthly: number): number {
  return monthly * ANNUAL_MONTHS_FREE;
}

/**
 * A year's annual charge, divided back over the twelve months it covers.
 *
 * This is the figure the annual card leads with, and it is the honest way to
 * compare the two: $590 looks like more than $59 until you notice one buys a
 * month and the other buys a year. Dividing puts them in the same unit.
 *
 * Rarely a whole number — ten twelfths of $59 is $49.17 — so the formatter
 * keeps the cents rather than rounding. A rounded $49 would understate the
 * price by two dollars a year per location, which is exactly the kind of
 * small dishonesty a pricing page cannot afford.
 */
export function effectiveMonthly(monthly: number): number {
  return (monthly * ANNUAL_MONTHS_BILLED) / MONTHS_IN_YEAR;
}

/**
 * The cheapest and dearest bill a group sitting in this band can have.
 *
 * A range rather than a figure, and that is a property of graduated pricing
 * rather than vagueness: everyone in "locations 11–25" pays $44 for each
 * location in that band, but an eleven-location group and a twenty-five
 * location group are buying very different numbers of them. Quoting either
 * end alone would be wrong for everybody at the other.
 */
export interface BandCostRange {
  /** A group of exactly `band.from` locations. */
  min: number;
  /** A group of exactly `band.to` locations. */
  max: number;
}

/** `null` for the quoted band, which has no top and therefore no maximum. */
export function bandCostRange(band: PricingBand): BandCostRange | null {
  if (band.monthly === null || band.to === null) return null;

  const min = monthlyTotal(band.from);
  const max = monthlyTotal(band.to);
  if (min === null || max === null) return null;

  return { min, max };
}

/**
 * The location counts a picker offers.
 *
 * Shared by the marketing estimator and the in-app checkout picker, which is
 * why it sits with the schedule rather than with either screen. The billing
 * picker filters the quoted option out — you cannot buy a plan that has to be
 * quoted — but the list of *listed* sizes is one decision.
 *
 * Original note:
 *
 * Every count through a dozen, then the round numbers, then one past the
 * listed range so the quoted case is reachable from the same control rather
 * than being a dead end the reader has to guess at.
 */
export const LOCATION_CHOICES = [
  1,
  2,
  3,
  4,
  5,
  6,
  7,
  8,
  9,
  10,
  12,
  15,
  20,
  25,
  30,
  40,
  50,
  75,
  100,
  LISTED_LOCATION_LIMIT + 1,
] as const;

/** The estimator opens on a group, not a single site — the discount is bigger there. */
export const DEFAULT_ESTIMATE_LOCATIONS = 12;

/** `12 locations`, and `More than 100` for the quoted option. */
export function formatLocationChoice(locations: number): string {
  if (locations > LISTED_LOCATION_LIMIT) {
    return `More than ${LISTED_LOCATION_LIMIT} locations`;
  }
  return locations === 1 ? "1 location" : `${locations} locations`;
}

