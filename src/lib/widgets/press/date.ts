/**
 * The date under a headline, as a stranger reads it.
 *
 * Absolute, always — unlike the review widget's relative phrasing, and the
 * difference is about what each date is *for*. "2 weeks ago" under a
 * testimonial says the praise is current, which is the only thing a reader
 * wants from it. A press date is part of the citation: somebody deciding
 * whether a piece of coverage is worth clicking wants to know it ran in
 * August, and "3 weeks ago" makes them do arithmetic to find out.
 *
 * `en-GB` rather than the visitor's locale: the widget is server-rendered once
 * and cached at the edge, so there is no per-visitor locale to honour, and a
 * day-month-year date is unambiguous to more readers than 03/04/2026 is.
 *
 * Returns an empty string on an unparseable value rather than throwing or
 * inventing a date. The card then draws no date line, which is a small loss;
 * a wrong one on somebody's homepage is not.
 */
export function widgetArticleDate(publishedAt: string): string {
  const parsed = Date.parse(publishedAt);
  if (Number.isNaN(parsed)) return "";

  return new Date(parsed).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
    timeZone: "UTC",
  });
}

/**
 * The machine-readable form, for the `<time datetime>` attribute.
 *
 * A date-only value rather than a full instant: the card shows a day, and a
 * `datetime` that claimed 14:32:07 would be asserting a precision the display
 * does not carry and that a provider's own timestamp often does not either.
 */
export function widgetArticleDateTime(publishedAt: string): string {
  const parsed = Date.parse(publishedAt);
  if (Number.isNaN(parsed)) return "";
  return new Date(parsed).toISOString().slice(0, 10);
}
