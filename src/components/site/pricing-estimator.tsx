"use client";

import Link from "next/link";
import { useId, useState } from "react";
import {
  ANNUAL_DISCOUNT_LABEL,
  ANNUAL_DISCOUNT_PERCENT,
  ANNUAL_MONTHS_BILLED,
  DEFAULT_ESTIMATE_LOCATIONS,
  LISTED_LOCATION_LIMIT,
  LOCATION_CHOICES,
  annualSavingTotal,
  annualTotal,
  annualTotalPaidMonthly,
  formatDollars,
  formatLocationChoice,
  monthlyTotal,
} from "@/lib/site/content/pricing";

/**
 * What a group of a given size actually pays, and what a year up front saves.
 *
 * The static worked example this replaces could only answer for one group
 * size. The discount is the point of the section, and the discount is a
 * dollar figure that depends entirely on how many locations you have — a
 * twelve-location group keeps four figures a year, a single site keeps two —
 * so the reader picks their own size and the bars redraw against it.
 *
 * Every figure comes from the same graduated schedule the table above renders,
 * so the estimate cannot quote a price the rate card does not support.
 */

/** The share of a year annual billing charges for — the blue part of the bar. */
const BILLED_SHARE = (ANNUAL_MONTHS_BILLED / 12) * 100;

export function PricingEstimator() {
  const [locations, setLocations] = useState<number>(
    DEFAULT_ESTIMATE_LOCATIONS,
  );
  const selectId = useId();

  const monthly = monthlyTotal(locations);
  const paidMonthly = annualTotalPaidMonthly(locations);
  const paidAnnually = annualTotal(locations);
  const saved = annualSavingTotal(locations);

  /**
   * All four totals are `null` together — they are the same figure scaled —
   * but narrowing them one at a time is what convinces the compiler, and the
   * quoted case above the listed range has its own answer either way.
   */
  const quoted =
    monthly === null ||
    paidMonthly === null ||
    paidAnnually === null ||
    saved === null;

  return (
    <div className="rounded-[18px] border border-site-border bg-white p-[clamp(20px,3vw,30px)]">
      <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
        <label
          htmlFor={selectId}
          className="text-[15px] font-semibold text-site-ink"
        >
          How many locations do you run?
        </label>
        <select
          id={selectId}
          value={locations}
          onChange={(event) => setLocations(Number(event.target.value))}
          className="w-full rounded-[10px] border border-site-border bg-white px-3.5 py-2.5 text-[14px] font-semibold text-site-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-site-blue sm:w-auto"
        >
          {LOCATION_CHOICES.map((choice) => (
            <option key={choice} value={choice}>
              {formatLocationChoice(choice)}
            </option>
          ))}
        </select>
      </div>

      {quoted ? (
        <p className="mt-5 text-[14px] leading-[1.6] text-site-body">
          Above {LISTED_LOCATION_LIMIT} locations the rate is quoted to your
          portfolio rather than listed, and annual billing is part of that
          conversation.{" "}
          <Link
            href="/contact"
            className="font-semibold text-site-blue underline underline-offset-2"
          >
            Talk to us
          </Link>{" "}
          and we will price it properly.
        </p>
      ) : (
        <>
          <p className="mt-4 text-[14px] leading-[1.6] text-site-body">
            That is{" "}
            <strong className="font-semibold text-site-ink">
              {formatDollars(monthly)} a month
            </strong>
            {/* The graduated explanation only describes a group. A single
                location has nothing after it, and the clause would be
                describing locations the reader does not have. */}
            {locations === 1
              ? ", the rate for a first location."
              : " — the first location at its own rate, and every location after it at the rate of the band it lands in."}
          </p>

          {/* The bars are the same two numbers the labels already carry, drawn
              to scale. They are `aria-hidden` and the figures beside them are
              real text, so nothing here is available only as a shape. */}
          <div className="mt-6 flex flex-col gap-4">
            <div>
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <span className="text-[13.5px] text-site-body">
                  Paying monthly, for a year
                </span>
                <span className="text-[15px] font-semibold text-site-ink tabular-nums">
                  {formatDollars(paidMonthly)}
                </span>
              </div>
              <div
                aria-hidden="true"
                className="h-3 rounded-[4px] bg-site-field"
              />
            </div>

            <div>
              <div className="mb-1.5 flex items-baseline justify-between gap-3">
                <span className="text-[13.5px] text-site-body">
                  Paying annually
                </span>
                {/* Ink, not the bar's blue: the mark beside it already
                    carries which series this is, and a figure wearing a
                    series colour reads as a different kind of number. */}
                <span className="text-[15px] font-semibold text-site-ink tabular-nums">
                  {formatDollars(paidAnnually)}
                </span>
              </div>
              {/* A 2px surface gap between the charged part and the part
                  annual billing does not charge for, so the two read as
                  separate quantities rather than one two-tone bar. */}
              <div aria-hidden="true" className="flex h-3 gap-0.5">
                <div
                  className="rounded-[4px] bg-site-blue"
                  style={{ width: `${BILLED_SHARE}%` }}
                />
                <div className="flex-1 rounded-[4px] border border-dashed border-site-field bg-site-blue-tint" />
              </div>
            </div>
          </div>

          <div className="mt-5 rounded-[12px] bg-site-blue-tint px-4 py-3.5">
            <p className="text-[15px] leading-[1.5] font-semibold text-site-blue">
              You save {formatDollars(saved)} a year by paying annually
            </p>
            <p className="mt-1 text-[13.5px] leading-[1.6] text-site-blue-ink">
              {ANNUAL_DISCOUNT_LABEL}, {ANNUAL_DISCOUNT_PERCENT}% off, on{" "}
              {locations === 1 ? "your location" : `all ${locations} locations`}
              . The dashed stretch above is the part annual billing does not
              charge you for.
            </p>
          </div>
        </>
      )}
    </div>
  );
}
