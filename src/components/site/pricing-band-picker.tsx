"use client";

import { useId, useState } from "react";
import type { BillingPeriod, PricingBand } from "@/lib/site/content/pricing";
import {
  ANNUAL_DISCOUNT_LABEL,
  LISTED_LOCATION_LIMIT,
  PRICING_BANDS,
  formatBandSize,
  formatBandTotalNote,
  formatPerLocationMonthly,
} from "@/lib/site/content/pricing";

/**
 * The band picker that sits inside the group card.
 *
 * The card leads with the **per-location rate** for the band chosen, because
 * that is the figure the three cards are compared on — $59 beside $49 beside
 * custom — and a total in the headline would put this card in a different unit
 * from its neighbours.
 *
 * Under it sits what a group in that band actually pays, as a **range**,
 * because the pricing is graduated: everyone in "locations 11–25" pays the
 * same rate for each location in that band, but an eleven-site group and a
 * twenty-five-site group buy very different numbers of them. The estimator
 * further down the page is still where an exact figure for an exact count
 * lives; this is the order-of-magnitude answer, in the box where the question
 * is asked.
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
   * The headline is a per-location, per-month figure on both faces. On the
   * annual one that is the year spread back over the twelve months it covers,
   * so the toggle changes the number without changing what it measures — and
   * the yearly charge is right underneath, so nothing is hidden by it.
   */
  const headline = quoted
    ? "Custom"
    : formatPerLocationMonthly(selected.monthly ?? 0, period);

  const total = quoted ? null : formatBandTotalNote(selected, period);

  const detail = quoted
    ? `Quoted to your portfolio above ${LISTED_LOCATION_LIMIT} locations.`
    : annual
      ? `For ${formatBandSize(selected)}, billed once a year — ${ANNUAL_DISCOUNT_LABEL} on every location.`
      : selected.from > 1
        ? // Why the total is a span and not a multiple of the rate above it:
          // the locations below this band are still charged at their own,
          // higher rate, and that is what the bottom of the range is made of.
          `For ${formatBandSize(selected)}. Locations below this band keep their own rate.`
        : `For ${formatBandSize(selected)}, billed monthly.`;

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
        {/* The figure matches the 42px headline on the cards either side, and
            `flex-wrap` lets the unit drop below it rather than the number
            itself breaking across two lines on a narrow column. */}
        <p className="flex flex-wrap items-baseline gap-x-2">
          <span
            className={`text-[clamp(32px,3.2vw,42px)] leading-[1.1] font-bold tracking-[-0.02em] whitespace-nowrap tabular-nums ${
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
              per location, per month
            </span>
          )}
        </p>

        {/* What the whole group pays — the figure the headline rate multiplies
            out to, graduated across the bands below this one. */}
        {total ? (
          <p
            className={`mt-1.5 text-[13px] font-semibold tabular-nums ${
              featured ? "text-white" : "text-site-ink"
            }`}
          >
            {total}
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
