/**
 * The rate card, as the marketing site renders it.
 *
 * The schedule itself — the bands, the annual discount, and the graduated
 * arithmetic — moved to `@/lib/pricing/schedule` when billing arrived, because
 * Stripe's catalog has to be built from the same numbers this page quotes. A
 * price on a page and a price on a card that come from two declarations will
 * eventually be two different numbers.
 *
 * What stays here is everything about *presentation*: how a figure is
 * written, what the cards say, and which counts the estimator offers. Those
 * have exactly one consumer, and Stripe has no opinion about any of them.
 *
 * The schedule is re-exported rather than hidden, so the many components and
 * tests that import from this module keep working unchanged.
 */

import {
  FIRST_LOCATION_MONTHLY,
  LISTED_LOCATION_LIMIT,
  LOWEST_LISTED_MONTHLY,
  MONTHS_CHARGED,
  SECOND_LOCATION_MONTHLY,
  annualSaving,
  bandCostRange,
  effectiveMonthly,
  type BillingPeriod,
  type PricingBand,
} from "@/lib/pricing/schedule";

export {
  ANNUAL_DISCOUNT_LABEL,
  ANNUAL_DISCOUNT_PERCENT,
  ANNUAL_MONTHS_BILLED,
  ANNUAL_MONTHS_FREE,
  FIRST_LOCATION_MONTHLY,
  LISTED_LOCATION_LIMIT,
  LOWEST_LISTED_MONTHLY,
  MONTHS_CHARGED,
  PRICING_BANDS,
  SECOND_LOCATION_MONTHLY,
  annualSaving,
  annualSavingTotal,
  annualTotal,
  annualTotalPaidMonthly,
  bandCostRange,
  effectiveMonthly,
  monthlyTotal,
} from "@/lib/pricing/schedule";

export type {
  BandCostRange,
  BillingPeriod,
  PricingBand,
} from "@/lib/pricing/schedule";

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

/* -------------------------------------------------------------------------- */
/* What annual billing works out at per month                                  */
/* -------------------------------------------------------------------------- */

/** `$59`, or `$49.17` — cents only where the arithmetic leaves them. */
export function formatMoney(amount: number): string {
  const exact = Number.isInteger(amount);
  return `$${amount.toLocaleString("en-US", {
    minimumFractionDigits: exact ? 0 : 2,
    maximumFractionDigits: exact ? 0 : 2,
  })}`;
}

/** What a location costs a month on this period — annual, spread back out. */
export function formatPerLocationMonthly(
  monthly: number,
  period: BillingPeriod,
): string {
  return period === "annual"
    ? formatMoney(effectiveMonthly(monthly))
    : formatMoney(monthly);
}

/* -------------------------------------------------------------------------- */
/* What a band costs                                                           */
/* -------------------------------------------------------------------------- */

/**
 * `$108 – $500`, or `$59` where a band holds exactly one group size.
 *
 * The single-location band is a range of one, and rendering it as "$59 – $59"
 * would read as a price that moves when it does not.
 */
export function formatBandCostRange(
  band: PricingBand,
  period: BillingPeriod,
): string {
  const range = bandCostRange(band);
  if (range === null) return "Custom";

  const months = MONTHS_CHARGED[period];
  const min = formatDollars(range.min * months);
  if (range.min === range.max) return min;

  // An en dash with hair spaces, not a hyphen: these are two figures with a
  // span between them, and a hyphen between "$108" and "$500" reads as one
  // hyphenated token at small sizes.
  return `${min} – ${formatDollars(range.max * months)}`;
}

/**
 * `$108 – $500 per month total` — the whole bill for a group in this band.
 *
 * The card leads with the per-location rate, which is the figure a reader
 * compares between tiers; this is the one they take to their finance team. It
 * is deliberately the smaller line, and it is the only place the graduated
 * total appears on the card, so the two figures cannot be mistaken for each
 * other.
 *
 * `null` where the band is quoted, and on the monthly face of a band that
 * holds a single group size — one location at $59 totals $59, and a second
 * line saying so is the headline again in a smaller font.
 */
export function formatBandTotalNote(
  band: PricingBand,
  period: BillingPeriod,
): string | null {
  const range = bandCostRange(band);
  if (range === null) return null;
  if (period === "monthly" && range.min === range.max) return null;

  return `${formatBandCostRange(band, period)} per ${PERIOD_UNIT[period]} total`;
}

/** How many locations a band covers, for the line under the range. */
export function formatBandSize(band: PricingBand): string {
  if (band.to === null) return `more than ${LISTED_LOCATION_LIMIT} locations`;
  if (band.from === band.to) {
    return band.from === 1 ? "one location" : `${band.from} locations`;
  }
  return `${band.from}–${band.to} locations`;
}

/**
 * The rate every location inside the band is charged at, spelled out.
 *
 * This is the number the range is built from, and showing it beside the range
 * is what keeps the range from looking arbitrary.
 */
export function formatBandRateNote(
  band: PricingBand,
  period: BillingPeriod,
): string {
  if (band.monthly === null) {
    return `Quoted to your portfolio above ${LISTED_LOCATION_LIMIT} locations.`;
  }

  return `${formatRate(band.monthly, period)} per ${PERIOD_UNIT[period]} for each location in this band.`;
}

/**
 * The three cards above the rate table.
 *
 * `price`, `priceNote`, and `savingNote` are functions of the billing period
 * because the toggle switches them in place. They read their figures from the
 * schedule rather than restating them, so the cards cannot contradict the
 * table.
 */
export interface PricingPlan {
  name: string;
  blurb: string;
  /** The headline figure, e.g. `$59` or `$590`. */
  price: (period: BillingPeriod) => string;
  /** The line under it, naming the unit the figure is quoted in. */
  priceNote: (period: BillingPeriod) => string;
  /**
   * What is actually charged, and when — the annual total on the annual face,
   * `null` on the monthly one where the headline figure already is the charge.
   * The headline is a per-month figure on both faces so the two are
   * comparable, which makes this line the one that says what leaves the bank.
   */
  billedNote: (period: BillingPeriod) => string | null;
  /** The annual discount in dollars, or `null` where the price is quoted. */
  savingNote: (period: BillingPeriod) => string | null;
  ctaLabel: string;
  ctaHref: string;
  featured?: boolean;
  /**
   * Whether this card offers the band picker. One card does — the group card,
   * where "how much would this actually cost us" is the question the reader
   * arrives with and the flat per-location rate above cannot answer.
   */
  bandPicker?: boolean;
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
    // The monthly phrasing is the label on a button that takes the offer, so
    // it stops at the offer itself: the button's own accessible name supplies
    // the verb, and "on annual billing" there would say annual twice.
    return period === "annual"
      ? `You save ${saved} a year`
      : `Save ${saved} a year`;
  };
}

export const PRICING_PLANS: readonly PricingPlan[] = [
  {
    name: "Single location",
    blurb: "For one hotel, restaurant, or clinic where every review counts.",
    price: (period) => formatPerLocationMonthly(FIRST_LOCATION_MONTHLY, period),
    priceNote: () => "per location, per month",
    billedNote: (period) =>
      period === "annual"
        ? `${formatRate(FIRST_LOCATION_MONTHLY, "annual")} per location, billed once a year`
        : null,
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
    blurb: "For groups where every location has its own rating to defend.",
    price: (period) =>
      formatPerLocationMonthly(SECOND_LOCATION_MONTHLY, period),
    priceNote: (period) =>
      `per location, per month, falling to ${formatPerLocationMonthly(
        LOWEST_LISTED_MONTHLY,
        period,
      )}`,
    billedNote: (period) =>
      period === "annual"
        ? `${formatRate(SECOND_LOCATION_MONTHLY, "annual")} per location, billed once a year`
        : null,
    // Per location, like the price above it: the group's own saving depends on
    // how many locations it has, and the estimator below answers that.
    savingNote: savingNoteFor(SECOND_LOCATION_MONTHLY),
    ctaLabel: "Get started",
    ctaHref: "/sign-up",
    featured: true,
    bandPicker: true,
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
    blurb: "For agencies and portfolios that need it shaped around them.",
    // Quoted either way, so the toggle has nothing to switch here.
    price: () => "Custom",
    priceNote: () =>
      `beyond ${LISTED_LOCATION_LIMIT} locations, quoted to your portfolio`,
    // Nothing is charged on a schedule that has not been agreed yet.
    billedNote: () => null,
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
