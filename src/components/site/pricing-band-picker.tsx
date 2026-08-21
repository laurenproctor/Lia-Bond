"use client";

import { useId, useState } from "react";
import type { BillingPeriod, PricingBand } from "@/lib/site/content/pricing";
import {
  ANNUAL_DISCOUNT_LABEL,
  LISTED_LOCATION_LIMIT,
  PRICING_BANDS,
  formatBandCostRange,
  formatBandSize,
  formatPerLocationMonthly,
} from "@/lib/site/content/pricing";

/**
 * The band picker that sits inside the group card.
 *
 * The card's headline used to be `$49`, a per-location rate — true, and not an
 * answer to the question a multi-location reader actually has, which is what
 * their group costs. They had to scroll past the rate table to the estimator to
 * find out. This puts the answer in the box where the question is asked.
 *
 * It shows a **range**, because the pricing is graduated: everyone in
 * "locations 11–25" pays the same rate per location in that band, but an
 * eleven-site group and a twenty-five-site group buy very different numbers of
 * them. The rate underneath is what the range is built from, so the span reads
 * as arithmetic rather than as hedging. The estimator further down the page is
 * still where an exact figure for an exact count lives.
 *
 * State is local rather than lifted: nothing outside this card reacts to the
 * band, and the billing period it needs already arrives as a prop from the
 * toggle above.
 */
export function PricingBandPicker({
  period,
  featured = false,
}: {
  /** The period the card is showing, so the range matches the price beside it. */
  period: BillingPeriod;
  /** Whether this sits on the dark featured surface. */
  featured?: boolean;
}) {
  // Opens on the group band rather than a single location: this is the card
  // for groups, and a reader who wanted one site is reading the card to its
  // left. `PRICING_BANDS[1]` is "locations 2–10".
  const [selected, setSelected] = useState<PricingBand>(
    () => PRICING_BANDS[1] ?? PRICING_BANDS[0],
  );
  const selectId = useId();

  const quoted = selected.monthly === null;
  const annual = period === "annual";

  /**
   * The two faces show different kinds of number on purpose.
   *
   * Monthly leads with what the whole group pays, because that is the question
   * a group card is asked. Annual leads with what one location works out at
   * per month, because $5,440 beside $544 reads as ten times the price until
   * you notice one buys a year — and the yearly charge is right underneath so
   * nothing is hidden by the comparison.
   */
  const groupRange = formatBandCostRange(selected, period);
  const perLocation = annual && !quoted;

  const headline =
    perLocation && selected.monthly !== null
      ? formatPerLocationMonthly(selected.monthly, "annual")
      : groupRange;

  const charge =
    perLocation && !quoted
      ? `${groupRange} a year for ${formatBandSize(selected)}`
      : null;

  const detail = quoted
    ? `Quoted to your portfolio above ${LISTED_LOCATION_LIMIT} locations.`
    : annual
      ? `Billed once a year — ${ANNUAL_DISCOUNT_LABEL} on every location.`
      : `For ${formatBandSize(selected)}, at ${formatPerLocationMonthly(
          selected.monthly ?? 0,
          "monthly",
        )} for each location in this band.`;

  return (
    <div className="mb-5">
      <label
        htmlFor={selectId}
        className={`mb-1.5 block text-[12.5px] font-semibold ${
          featured ? "text-site-muted-dark" : "text-site-muted"
        }`}
      >
        How many locations?
      </label>

      <select
        id={selectId}
        value={selected.label}
        onChange={(event) => {
          const next = PRICING_BANDS.find(
            (band) => band.label === event.target.value,
          );
          if (next) setSelected(next);
        }}
        className={`w-full rounded-[10px] border px-3.5 py-2.5 text-[14px] font-semibold focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-site-blue ${
          featured
            ? // The dark card needs a surface of its own for the control:
              // transparent over ink renders the native menu unreadably in
              // several browsers, and the border has to lift off the card.
              "border-[#3a4454] bg-[#161b26] text-white"
            : "border-site-border bg-white text-site-ink"
        }`}
      >
        {PRICING_BANDS.map((band) => (
          <option key={band.label} value={band.label}>
            {band.label}
          </option>
        ))}
      </select>

      {/* Polite, and scoped to the lines that actually change: the reader has
          just used the select, so the browser has already announced the
          option — what it has not said is what that costs. */}
      <div aria-live="polite" className="mt-4">
        {/* `flex-wrap` with the figure held on one line: a range is roughly
            twice the width of the single price this replaced, and it does not
            fit a card column at the old 42px. The figure shrinks and the unit
            drops below it rather than the number itself breaking across two
            lines. */}
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span
            className={`text-[clamp(22px,2.2vw,28px)] leading-[1.15] font-bold tracking-[-0.02em] whitespace-nowrap tabular-nums ${
              featured ? "text-white" : "text-site-ink"
            }`}
          >
            {headline}
          </span>
          {quoted ? null : (
            <span
              className={`text-[13px] whitespace-nowrap ${
                featured ? "text-site-muted-dark" : "text-site-muted"
              }`}
            >
              {perLocation ? "per location, per month" : "per month"}
            </span>
          )}
        </p>

        {/* What actually leaves the bank, on the face where the headline is a
            per-month figure and the charge is not. */}
        {charge ? (
          <p
            className={`mt-1.5 text-[13px] font-semibold ${
              featured ? "text-white" : "text-site-ink"
            }`}
          >
            {charge}
          </p>
        ) : null}

        <p
          className={`mt-1.5 text-[12.5px] leading-[1.5] ${
            featured ? "text-site-muted-dark" : "text-site-muted"
          }`}
        >
          {detail}
        </p>
      </div>
    </div>
  );
}
