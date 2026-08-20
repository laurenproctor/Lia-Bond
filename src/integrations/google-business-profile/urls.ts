/**
 * Google URL validation.
 *
 * The Yelp equivalent (`src/yelp/urls.ts`) exists because three callers need
 * it and one of them is a client component. This one exists for a narrower and
 * sharper reason: the website review widget renders an anchor into a page on
 * somebody else's domain, under a label that says "Read on Google". A stored
 * string that turned out not to be a Google URL would make Lia the thing that
 * put a hostile link on a restaurant's homepage.
 *
 * Pure — no I/O, no `server-only` — because the configuration screen's preview
 * and the public renderer both validate, and one of them runs in a browser.
 *
 * **Google gives Lia no per-review permalink.** `normalizeReview` in
 * `reviews.ts` records that and stores `sourceUrl: null` for every imported
 * review rather than fabricating a deep link. So the destination this module
 * validates is the *location's* Google profile — the `mapsUri` captured when
 * the listing was mapped — which is where "Read on Google" honestly leads: to
 * the place the review is published, not to the review's own anchor, which
 * does not exist to link to.
 */

/**
 * Google's own hosts, as an explicit allowlist.
 *
 * A pattern like `/google\./` would admit `google.evil.example`, which anybody
 * can register, and the entire purpose of this module is that the destination
 * is Google. Country domains are listed because `mapsUri` comes back localised
 * — a UK listing yields `google.co.uk`.
 */
const GOOGLE_HOSTS: ReadonlySet<string> = new Set([
  "google.com",
  "google.ca",
  "google.co.uk",
  "google.ie",
  "google.com.au",
  "google.co.nz",
  "google.de",
  "google.fr",
  "google.es",
  "google.it",
  "google.nl",
  "google.be",
  "google.ch",
  "google.at",
  "google.se",
  "google.no",
  "google.dk",
  "google.fi",
  "google.pt",
  "google.pl",
  "google.com.br",
  "google.com.mx",
  "google.co.jp",
  "google.com.sg",
  "google.com.hk",
  "google.co.in",
  // Maps' own hosts. `maps.google.com` arrives as a `www`-less subdomain and
  // is handled by the subdomain rule below; these two are separate registrable
  // domains and would not be.
  "goo.gl",
  "maps.app.goo.gl",
]);

/**
 * `maps.` and `www.` are the only subdomains accepted.
 *
 * Not an arbitrary one: `mapsUri` uses both, and admitting anything to the
 * left of a Google domain would defeat the allowlist — Google's own
 * user-content hosts are not places to send somebody who was told they were
 * going to a review page.
 */
function hostIsGoogle(hostname: string): boolean {
  const host = hostname.toLowerCase();
  if (GOOGLE_HOSTS.has(host)) return true;

  for (const prefix of ["www.", "maps."]) {
    if (host.startsWith(prefix) && GOOGLE_HOSTS.has(host.slice(prefix.length))) {
      return true;
    }
  }
  return false;
}

/**
 * A Google URL Lia is willing to send a stranger to, or null.
 *
 * - `https` only. An `http://` Google link is a downgrade, and `javascript:`
 *   is the reason this function exists at all.
 * - No embedded credentials, the classic way to make a hostile URL read as a
 *   trusted one.
 * - The query string is **kept**, unlike the Yelp equivalent which drops it.
 *   A Google Maps profile URL carries its identity in the query (`?cid=…`),
 *   so stripping it would turn a link to one restaurant into a link to Google
 *   Maps' front page. The fragment is dropped, which carries nothing here.
 */
export function normalizeGoogleUrl(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2048) return null;

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    return null;
  }

  if (url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (!hostIsGoogle(url.hostname)) return null;

  url.hash = "";
  return url.toString();
}

/** Whether a stored string is a Google destination Lia will render as a link. */
export function isTrustedGoogleUrl(value: string): boolean {
  return normalizeGoogleUrl(value) !== null;
}
