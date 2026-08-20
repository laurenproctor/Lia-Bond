import {
  ANNUAL_DISCOUNT_LABEL,
  ANNUAL_MONTHS_BILLED,
  PRICING_BANDS,
  formatAnnualRate,
  formatBandSaving,
  formatMonthlyRate,
} from "@/lib/site/content/pricing";

/**
 * The per-location rate card.
 *
 * A real `<table>` rather than a grid of divs: four columns of figures with
 * two header axes is exactly what a table is for, and it is what a screen
 * reader needs to say "locations 11–25, monthly rate per location, $44"
 * instead of reading eight loose numbers in a row.
 *
 * The reference layout put a monthly/annual switch above the cards. That
 * switch exists on the cards themselves; here both columns stay on the page
 * side by side, because the last column — what annual billing saves — only
 * means anything with the two rates it is the difference between.
 *
 * Sizing is tuned so all four columns fit a 390px phone rather than leaving
 * the saving off the right edge behind a scroll with no affordance. The
 * `overflow-x-auto` remains as the floor for very narrow or zoomed viewports.
 */

const CELL = "px-2.5 py-3.5 sm:px-5";

const HEAD =
  "text-[11px] font-semibold tracking-[0.06em] text-site-muted uppercase sm:text-[12.5px] sm:tracking-[0.08em]";

export function PricingBands() {
  return (
    <div className="overflow-x-auto rounded-[18px] border border-site-border bg-white">
      <table className="w-full border-collapse text-left">
        <caption className="sr-only">
          Monthly rate, annual rate, and the annual saving per location, by
          location band. Annual billing charges {ANNUAL_MONTHS_BILLED} months a
          year, so it is {ANNUAL_DISCOUNT_LABEL}.
        </caption>
        <thead>
          <tr className="border-b border-site-border">
            <th scope="col" className={`${CELL} ${HEAD}`}>
              Location band
            </th>
            <th scope="col" className={`${CELL} ${HEAD} text-right`}>
              Monthly
              {/* The qualifier is the same for every rate column and already
                  sits in the caption and the intro copy, so on a phone it is
                  dropped rather than allowed to push a column off-screen. */}
              <span className="hidden sm:inline">, per location</span>
            </th>
            <th scope="col" className={`${CELL} ${HEAD} text-right`}>
              Annual
              <span className="hidden sm:inline">, per location</span>
            </th>
            <th scope="col" className={`${CELL} ${HEAD} text-right`}>
              You save
              <span className="hidden sm:inline">, per year</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {PRICING_BANDS.map((band) => {
            const saving = formatBandSaving(band);

            return (
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
                  className={`${CELL} text-right text-[13px] whitespace-nowrap text-site-ink tabular-nums sm:text-[14px]`}
                >
                  {formatAnnualRate(band)}
                  {band.monthly === null ? null : (
                    <span className="text-site-muted">/yr</span>
                  )}
                </td>
                <td
                  className={`${CELL} text-right text-[13px] whitespace-nowrap tabular-nums sm:text-[14px]`}
                >
                  {saving === null ? (
                    <span className="text-site-muted">
                      {/* An em dash alone reads as "dash" or as nothing at
                          all; the quoted band has no listed saving, and the
                          row should say so rather than leave a gap. */}
                      <span aria-hidden="true">—</span>
                      <span className="sr-only">Quoted</span>
                    </span>
                  ) : (
                    <span className="font-semibold text-site-blue">
                      {saving}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
