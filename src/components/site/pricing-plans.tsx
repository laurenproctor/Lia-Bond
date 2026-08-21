"use client";

import { useId, useState } from "react";
import { PricingBandPicker } from "@/components/site/pricing-band-picker";
import { PricingTier } from "@/components/site/pricing-tier";
import type { BillingPeriod } from "@/lib/site/content/pricing";
import {
  ANNUAL_DISCOUNT_LABEL,
  ANNUAL_DISCOUNT_PERCENT,
  ANNUAL_MONTHS_BILLED,
  PRICING_PLANS,
} from "@/lib/site/content/pricing";

/**
 * The three cards and the switch that reprices them.
 *
 * Client, and one of two client components on the page: the cards themselves
 * stay presentational, so the state lives at the smallest node that owns both
 * the switch and the figures it changes.
 *
 * The reference design paired its switch with "save 20% on annual". The badge
 * here says what the discount actually is — two months free, so 17% — and
 * both the badge and the caption read it off `ANNUAL_MONTHS_BILLED` rather
 * than restating a number that could drift from the prices beside it.
 */
export function PricingPlans() {
  // Opens on annual: it is the plan we would rather sell, and it is also the
  // cheaper of the two, so leading with it is not a figure the reader has to
  // be talked into. The caption under the switch says on arrival that these
  // are yearly prices per month, so the lower number never reads as the
  // monthly charge.
  const [period, setPeriod] = useState<BillingPeriod>("annual");
  const annual = period === "annual";
  const labelId = useId();

  return (
    <>
      <div className="mb-[clamp(28px,4vw,40px)] flex flex-col items-center gap-2">
        <div className="flex items-center gap-3">
          {/* `aria-hidden` on the flanking words and the badge: the switch
              already carries the whole state in its own label, and a screen
              reader reading "monthly annual 2 months free switch, annual, on"
              is noise, not context. */}
          <span
            aria-hidden="true"
            className={`text-[14px] transition-colors ${
              annual ? "text-site-muted" : "font-semibold text-site-ink"
            }`}
          >
            Monthly
          </span>

          <button
            type="button"
            role="switch"
            aria-checked={annual}
            aria-labelledby={labelId}
            onClick={() => setPeriod(annual ? "monthly" : "annual")}
            className={`relative h-6.5 w-11.5 shrink-0 rounded-full transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-site-blue ${
              annual ? "bg-site-blue" : "bg-site-field"
            }`}
          >
            <span
              className={`absolute top-1 size-4.5 rounded-full bg-white shadow-[0_1px_3px_rgb(11_15_24_/_0.3)] transition-[left] ${
                annual ? "left-6" : "left-1"
              }`}
            />
          </button>

          <span
            aria-hidden="true"
            className={`text-[14px] transition-colors ${
              annual ? "font-semibold text-site-ink" : "text-site-muted"
            }`}
          >
            Annual
          </span>

          <span
            aria-hidden="true"
            className="rounded-[20px] bg-site-amber-tint px-2.5 py-1 text-[12px] font-semibold whitespace-nowrap text-site-amber-ink"
          >
            {ANNUAL_DISCOUNT_LABEL}
          </span>

          <span id={labelId} className="sr-only">
            Show annual prices — {ANNUAL_DISCOUNT_LABEL},{" "}
            {ANNUAL_DISCOUNT_PERCENT}% off
          </span>
        </div>

        <p
          className="max-w-[420px] text-center text-[13px] text-site-muted"
          // Polite, not assertive: the prices below change at the same moment
          // and a screen reader should finish the current line first.
          aria-live="polite"
        >
          {annual
            ? `Prices below are what a year works out at per month. You are charged for ${ANNUAL_MONTHS_BILLED} months, once — ${ANNUAL_DISCOUNT_LABEL}, ${ANNUAL_DISCOUNT_PERCENT}% off.`
            : `Billed monthly, cancel any time. Pay for the year up front instead and you are charged for ${ANNUAL_MONTHS_BILLED} months, not 12.`}
        </p>
      </div>

      <div className="grid grid-cols-1 items-stretch gap-6 lg:grid-cols-3">
        {PRICING_PLANS.map((plan) => (
          <PricingTier
            key={plan.name}
            name={plan.name}
            blurb={plan.blurb}
            price={plan.price(period)}
            priceNote={plan.priceNote(period)}
            savingNote={plan.savingNote(period)}
            billedNote={plan.billedNote(period)}
            // Only on the monthly face: on the annual one the saving is
            // already taken, and a control that switches to where you are is
            // a dead end wearing a button's clothes.
            onSavingNoteClick={annual ? undefined : () => setPeriod("annual")}
            ctaLabel={plan.ctaLabel}
            ctaHref={plan.ctaHref}
            // The group card prices itself: a per-location rate cannot answer
            // "what would this cost us", so that card swaps its fixed headline
            // for a band picker and shows the range for the size chosen.
            priceSlot={
              plan.bandPicker ? (
                <PricingBandPicker period={period} featured={plan.featured} />
              ) : null
            }
            features={plan.features}
            featured={plan.featured}
          />
        ))}
      </div>
    </>
  );
}
