/**
 * Yelp URL validation and canonicalisation.
 *
 * Pure — no I/O, no server-only import — because three callers need it and one
 * of them is a client component: the provider validates what Yelp returned, the
 * capture action validates what a customer pasted, and the "Open in Yelp"
 * control validates once more before it renders an anchor. A URL that reached
 * the browser unvalidated would be an open redirect wearing a Yelp label.
 *
 * The host list is an explicit allowlist rather than a pattern. `^yelp\.` with
 * a wildcard suffix would admit `yelp.example`, which anybody can register, and
 * the whole point of this module is that the destination is Yelp. An unlisted
 * locale domain is refused and the caller falls back to
 * `canonicalYelpBusinessUrl`, which is built from the alias rather than trusted
 * from anywhere — so a customer on a locale Lia has not listed still gets a
 * working link, just a `.com` one.
 */

/**
 * Yelp's own consumer domains.
 *
 * Sourced from Yelp's international footer. Adding one is a one-line change
 * here and nowhere else; that is why every caller routes through this module
 * rather than testing `includes("yelp.com")` on its own.
 */
const YELP_HOSTS: ReadonlySet<string> = new Set([
  "yelp.com",
  "yelp.ca",
  "yelp.co.uk",
  "yelp.ie",
  "yelp.com.au",
  "yelp.co.nz",
  "yelp.at",
  "yelp.be",
  "yelp.ch",
  "yelp.cz",
  "yelp.de",
  "yelp.dk",
  "yelp.es",
  "yelp.fi",
  "yelp.fr",
  "yelp.it",
  "yelp.nl",
  "yelp.no",
  "yelp.pl",
  "yelp.pt",
  "yelp.se",
  "yelp.com.br",
  "yelp.com.mx",
  "yelp.com.sg",
  "yelp.com.tr",
  "yelp.com.hk",
  "yelp.com.ph",
  "yelp.co.jp",
]);

/** `www.` is the only subdomain accepted. Not `m.`, not a user-supplied one. */
function hostIsYelp(hostname: string): boolean {
  const host = hostname.toLowerCase();
  const bare = host.startsWith("www.") ? host.slice(4) : host;
  return YELP_HOSTS.has(bare);
}

/**
 * A Yelp URL, canonicalised, or null.
 *
 * Canonicalisation is what makes the review-URL branch of the deduplication
 * contract work: two people pasting the same review from different places
 * supply the same page with different tracking parameters, and a raw-string
 * comparison would treat them as two different reviews.
 *
 * What it does:
 *
 * - refuses any scheme but `https` (an `http://` Yelp link is a downgrade, and
 *   `javascript:` is the reason this function exists at all);
 * - refuses any host not on the allowlist;
 * - drops the query string and the fragment entirely, rather than filtering
 *   known trackers — an allowlist of harmless parameters is a list somebody has
 *   to maintain, and nothing Lia needs from a Yelp URL lives in the query;
 * - normalises the host to lowercase and strips a trailing slash;
 * - refuses anything with embedded credentials, which is the classic way to
 *   make a hostile URL read as a trusted one.
 *
 * Deliberately **not** normalised: path casing. Yelp review fragments are
 * case-sensitive identifiers, and lowercasing one would break the link this
 * function exists to keep working.
 */
export function normalizeYelpUrl(value: string): string | null {
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
  if (!hostIsYelp(url.hostname)) return null;

  const host = url.hostname.toLowerCase();
  const path = url.pathname.replace(/\/+$/, "");

  return `https://${host}${path}`;
}

/** Whether a string is a Yelp URL Lia is willing to send somebody to. */
export function isTrustedYelpUrl(value: string): boolean {
  return normalizeYelpUrl(value) !== null;
}

/**
 * Yelp's slug rule, as far as Lia relies on it.
 *
 * Enforced before the alias is interpolated into a URL rather than trusted from
 * the provider response: an alias carrying a `/` or a `?` would build a link
 * pointing somewhere other than the business page, and this is the one place
 * where provider data becomes a destination.
 */
const YELP_ALIAS_PATTERN = /^[a-z0-9][a-z0-9-]{0,199}$/;

export function isYelpAlias(value: string): boolean {
  return YELP_ALIAS_PATTERN.test(value);
}

/**
 * The listing's page, built from its alias.
 *
 * The fallback whenever no trusted URL was stored — a locale domain Lia has not
 * listed, a listing Yelp returned with no URL, or a review captured without
 * one. Always `.com`, because that is the domain the allowlist is anchored on
 * and Yelp redirects a visitor to their own locale anyway.
 */
export function canonicalYelpBusinessUrl(alias: string): string | null {
  if (!isYelpAlias(alias)) return null;
  return `https://www.yelp.com/biz/${alias}`;
}
