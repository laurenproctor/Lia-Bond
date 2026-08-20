/**
 * The published per-location price schedule.
 *
 * Pricing is graduated, not flat: a location is charged at the rate of the
 * band it falls in, the way tax brackets work. An eleventh location does not
 * reprice the first ten. `monthlyTotal` is the only implementation of that
 * rule, so the page's worked example cannot drift from the table above it.
 *
 * Annual figures are never stored either — they are the monthly rate times
 * `ANNUAL_MONTHS_BILLED`, computed at render. The annual discount is that one
 * constant and nothing else: every annual price, every saving, the badge on
 * the toggle, and the percentage in the copy are derived from it, so there is
 * no second figure that can disagree with the first.
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

/** Locations above this are quoted rather than listed. */
export const LISTED_LOCATION_LIMIT = 100;

/** Months in a year, named because the annual arithmetic reads on both. */
const MONTHS_IN_YEAR = 12;

/**
 * The annual discount, expressed the way it is actually charged: a year costs
 * ten months at the monthly rate. Everything else about the discount — the
 * saving in dollars, the percentage, the badge copy — is derived from this,
 * so moving the discount is a one-line change and cannot leave a stale figure
 * behind somewhere on the page.
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

/**
 * The blended monthly bill for `locations` locations, in whole dollars.
 *
 * Returns `null` above the listed range, where the price is quoted — a number
 * there would be an invented figure, and the caller has to say "custom"
 * either way.
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

/** Which figure the cards are showing. */
export type BillingPeriod = "monthly" | "annual";

/** The number of months a period is charged for in one go. */
const MONTHS_CHARGED: Record<BillingPeriod, number> = {
  monthly: 1,
  annual: ANNUAL_MONTHS_BILLED,
};

/** The unit a rate is quoted in, for the line under a headline figure. */
export const PERIOD_UNIT: Record<BillingPeriod, string> = {
  monthly: "month",
  annual: "year",
};

/** The suffix a rate carries in the table, e.g. `$59` + `/mo`. */
export const PERIOD_SUFFIX: Record<BillingPeriod, string> = {
  monthly: "/mo",
  annual: "/yr",
};

/** The other one — what the toggle switches to. */
export function otherPeriod(period: BillingPeriod): BillingPeriod {
  return period === "monthly" ? "annual" : "monthly";
}

/** `$1,096` — thousands separated, for the blended totals. */
export function formatDollars(amount: number): string {
  return `$${amount.toLocaleString("en-US")}`;
}

/**
 * A monthly rate rendered for the period on screen: `$59` monthly, `$590`
 * annual. The annual figure is ten months at the same rate, not twelve — the
 * discount lives in `ANNUAL_MONTHS_BILLED` and nowhere else.
 */
export function formatRate(monthly: number, period: BillingPeriod): string {
  return formatDollars(monthly * MONTHS_CHARGED[period]);
}

/** A band's rate for the period, or "Custom" where it is quoted. */
export function formatBandRate(
  band: PricingBand,
  period: BillingPeriod,
): string {
  return band.monthly === null ? "Custom" : formatRate(band.monthly, period);
}

/** `$59` — a listed rate, or "Custom" for a quoted band. */
export function formatMonthlyRate(band: PricingBand): string {
  return formatBandRate(band, "monthly");
}

/** `$590` — ten months at the band's rate, or "Custom". */
export function formatAnnualRate(band: PricingBand): string {
  return formatBandRate(band, "annual");
}

/**
 * `$118` — a year of that band's discount, or `null` where the band is quoted
 * and there is no listed rate to take two months off.
 */
export function formatBandSaving(band: PricingBand): string | null {
  return band.monthly === null
    ? null
    : formatDollars(annualSaving(band.monthly));
}

/**
 * The location counts the estimator offers.
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

/**
 * The three cards above the rate table.
 *
 * `price`, `priceNote`, and `savingNote` are functions of the billing period
 * because the toggle switches them in place. They read their figures from the
 * constants above rather than restating them, so the cards cannot contradict
 * the table.
 */
export interface PricingPlan {
  name: string;
  blurb: string;
  /** The headline figure, e.g. `$59` or `$590`. */
  price: (period: BillingPeriod) => string;
  /** The line under it, naming the unit the figure is quoted in. */
  priceNote: (period: BillingPeriod) => string;
  /** The annual discount in dollars, or `null` where the price is quoted. */
  savingNote: (period: BillingPeriod) => string | null;
  ctaLabel: string;
  ctaHref: string;
  featured?: boolean;
  features: readonly string[];
}

/**
 * The saving line under a card's price.
 *
 * Two phrasings, because on the monthly face it is an offer and on the annual
 * face it is a figure the reader has already taken.
 */
function savingNoteFor(monthly: number) {
  return (period: BillingPeriod): string => {
    const saved = formatDollars(annualSaving(monthly));
    return period === "annual"
      ? `You save ${saved} a year`
      : `Save ${saved} a year on annual billing`;
  };
}

export const PRICING_PLANS: readonly PricingPlan[] = [
  {
    name: "Single location",
    blurb: "For independent hotels, restaurants, and clinics.",
    price: (period) => formatRate(FIRST_LOCATION_MONTHLY, period),
    priceNote: (period) =>
      `per ${PERIOD_UNIT[period]} · ${formatRate(
        FIRST_LOCATION_MONTHLY,
        otherPeriod(period),
      )} a ${PERIOD_UNIT[otherPeriod(period)]}`,
    savingNote: savingNoteFor(FIRST_LOCATION_MONTHLY),
    ctaLabel: "Get started",
    ctaHref: "/sign-up",
    features: [
      "Google review monitoring",
      "AI-assisted response drafts",
      "Human review on sensitive replies",
      "Weekly reputation report",
    ],
  },
  {
    name: "Growth",
    blurb: "For multi-location brands and groups.",
    price: (period) => formatRate(SECOND_LOCATION_MONTHLY, period),
    priceNote: (period) =>
      `per ${PERIOD_UNIT[period]} for each location after the first, falling to ${formatRate(
        LOWEST_LISTED_MONTHLY,
        period,
      )}`,
    // Per location, like the price above it: the group's own saving depends on
    // how many locations it has, and the estimator below answers that.
    savingNote: savingNoteFor(SECOND_LOCATION_MONTHLY),
    ctaLabel: "Get started",
    ctaHref: "/sign-up",
    featured: true,
    features: [
      "Everything in single location",
      "All review platforms connected",
      "Brand voice and escalation rules",
      "Monthly insights summary",
      "Priority support",
    ],
  },
  {
    name: "Brand",
    blurb: "For agencies and large multi-brand groups.",
    // Quoted either way, so the toggle has nothing to switch here.
    price: () => "Custom",
    priceNote: () =>
      `beyond ${LISTED_LOCATION_LIMIT} locations, quoted to your portfolio`,
    // No listed rate to take two months off, so no dollar figure is invented.
    savingNote: () => null,
    ctaLabel: "Talk to us",
    ctaHref: "/contact",
    features: [
      "Everything in growth",
      "Dedicated reputation strategist",
      "Custom workflows and approvals",
      "SSO and role-based access",
    ],
  },
] as const;
