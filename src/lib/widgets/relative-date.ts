/**
 * The date under a reviewer's name, as a stranger reads it.
 *
 * Its own function rather than `formatRelativeLong` from `@/lib/format`, for
 * two reasons that are both about audience. That helper is built for Lia's own
 * queues: it is deliberately minute-accurate, it tops out at months, and it
 * resolves "now" through `resolveDataSourceKind()` — a server-only import that
 * has no business inside a document served to the public web.
 *
 * A restaurant guest reading a testimonial wants none of that precision.
 * "14 days ago" is how a machine says "2 weeks ago", and a review from 2023
 * should say 2023 rather than "31 months ago", which reads as a bug.
 *
 * `now` is injected rather than read, so the same review renders identically
 * in a test, in the in-app preview, and on the customer's page.
 */

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;

/** Past this, a relative phrase is less useful than the year. */
const ABSOLUTE_THRESHOLD_DAYS = 365;

export function widgetReviewDate(publishedAt: string, now: number): string {
  const published = Date.parse(publishedAt);
  if (Number.isNaN(published)) return "";

  const delta = now - published;

  // A review dated in the future is a clock disagreement, not a prediction.
  // "today" is the least surprising thing to show a stranger.
  if (delta < 0) return "today";

  if (delta < HOUR) return "today";
  if (delta < DAY) {
    const hours = Math.floor(delta / HOUR);
    return hours <= 1 ? "today" : `${hours} hours ago`;
  }

  const days = Math.floor(delta / DAY);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days} days ago`;

  if (days < ABSOLUTE_THRESHOLD_DAYS) {
    const weeks = Math.floor(delta / WEEK);
    if (weeks < 5) return weeks === 1 ? "1 week ago" : `${weeks} weeks ago`;

    const months = Math.max(1, Math.round(days / 30.44));
    return months === 1 ? "1 month ago" : `${months} months ago`;
  }

  // `en-GB` rather than the visitor's locale: the widget is server-rendered
  // once and cached, so there is no per-visitor locale to honour, and a
  // day-month-year date is unambiguous to more readers than 03/04/2026 is.
  return new Date(published).toLocaleDateString("en-GB", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });
}
