import {
  PRICING_BANDS,
  formatAnnualRate,
  formatMonthlyRate,
} from "@/lib/site/content/pricing";

/**
 * The per-location rate card.
 *
 * A real `<table>` rather than a grid of divs: three columns of figures with
 * two header axes is exactly what a table is for, and it is what a screen
 * reader needs to say "locations 11–25, monthly rate per location, $44"
 * instead of reading six loose numbers in a row.
 *
 * The reference layout put a monthly/annual switch above the cards. There is
 * no annual discount to reveal, so a toggle would hide half the schedule to
 * show the same prices twice. Both columns stay on the page instead.
 *
 * Sizing is tuned so all three columns fit a 390px phone rather than leaving
 * the annual rate off the right edge behind a scroll with no affordance. The
 * `overflow-x-auto` remains as the floor for very narrow or zoomed viewports.
 */

const CELL = "px-3.5 py-3.5 sm:px-6";

export function PricingBands() {
  return (
    <div className="overflow-x-auto rounded-[18px] border border-site-border bg-white">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">
          Monthly and annual rate per location, by location band.
        </caption>
        <thead>
          <tr className="border-b border-site-border">
            <th
              scope="col"
              className={`${CELL} text-[11px] font-semibold tracking-[0.06em] text-site-muted uppercase sm:text-[12.5px] sm:tracking-[0.08em]`}
            >
              Location band
            </th>
            <th
              scope="col"
              className={`${CELL} text-right text-[11px] font-semibold tracking-[0.06em] text-site-muted uppercase sm:text-[12.5px] sm:tracking-[0.08em]`}
            >
              Monthly
              {/* The qualifier is the same for both rate columns and already
                  sits in the caption and the intro copy, so on a phone it is
                  dropped rather than allowed to push the column off-screen. */}
              <span className="hidden sm:inline">, per location</span>
            </th>
            <th
              scope="col"
              className={`${CELL} text-right text-[11px] font-semibold tracking-[0.06em] text-site-muted uppercase sm:text-[12.5px] sm:tracking-[0.08em]`}
            >
              Annual
              <span className="hidden sm:inline">, per location</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {PRICING_BANDS.map((band) => (
            <tr
              key={band.label}
              className="border-b border-site-border last:border-b-0"
            >
              <th
                scope="row"
                className={`${CELL} text-[13px] font-semibold whitespace-nowrap text-site-ink sm:text-[14px]`}
              >
                {band.label}
              </th>
              <td
                className={`${CELL} text-right text-[13px] whitespace-nowrap text-site-body tabular-nums sm:text-[14px]`}
              >
                {formatMonthlyRate(band)}
                {band.monthly === null ? null : (
                  <span className="text-site-muted">/mo</span>
                )}
              </td>
              <td
                className={`${CELL} text-right text-[13px] whitespace-nowrap text-site-body tabular-nums sm:text-[14px]`}
              >
                {formatAnnualRate(band)}
                {band.monthly === null ? null : (
                  <span className="text-site-muted">/yr</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
