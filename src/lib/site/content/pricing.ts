/**
 * The published per-location price schedule.
 *
 * Pricing is graduated, not flat: a location is charged at the rate of the
 * band it falls in, the way tax brackets work. An eleventh location does not
 * reprice the first ten. `monthlyTotal` is the only implementation of that
 * rule, so the page's worked example cannot drift from the table above it.
 *
 * Annual figures are never stored — they are twelve times the monthly rate,
 * computed at render. There is no annual discount, so a second source of
 * truth here would only be a way for the two columns to disagree.
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

/** Which figure the cards are showing. */
export type BillingPeriod = "monthly" | "annual";

/** The number of months a period is billed in one go. */
const MONTHS: Record<BillingPeriod, number> = { monthly: 1, annual: 12 };

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
 * A monthly rate rendered for the period on screen: `$59` monthly, `$708`
 * annual. Annual is twelve months at the same rate — there is no annual
 * discount, and nothing in the interface should imply one.
 */
export function formatRate(monthly: number, period: BillingPeriod): string {
  return formatDollars(monthly * MONTHS[period]);
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

/** `$708` — twelve months at the band's rate, or "Custom". */
export function formatAnnualRate(band: PricingBand): string {
  return formatBandRate(band, "annual");
}

/**
 * The three cards above the rate table.
 *
 * `price` and `priceNote` are functions of the billing period because the
 * toggle switches them in place. They read their figures from the constants
 * above rather than restating them, so the cards cannot contradict the table.
 */
export interface PricingPlan {
  name: string;
  blurb: string;
  /** The headline figure, e.g. `$59` or `$708`. */
  price: (period: BillingPeriod) => string;
  /** The line under it, naming the unit the figure is quoted in. */
  priceNote: (period: BillingPeriod) => string;
  ctaLabel: string;
  ctaHref: string;
  featured?: boolean;
  features: readonly string[];
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
