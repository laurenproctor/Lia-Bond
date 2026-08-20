import { MAX_WIDGET_DOMAINS, widgetDomainSchema } from "@/domain";

/**
 * Approved website domains, and the header that enforces them.
 *
 * The enforcement is `Content-Security-Policy: frame-ancestors`, sent on the
 * widget document itself. That is a real control rather than a courtesy: the
 * *visitor's browser* refuses to paint the frame, so it holds even though the
 * embed is a public URL anybody can fetch with curl.
 *
 * What it is not is a secrecy mechanism, and the interface has to say so. A
 * widget's content is on a public website by definition; restricting domains
 * stops somebody framing *your* widget on *their* page, which matters for
 * attribution and for a competitor lifting your testimonials wholesale. It
 * does not make the review private, and a settings screen that implied
 * otherwise would be selling a guarantee the web cannot give.
 *
 * `Referer` is deliberately not consulted. It is absent under
 * `no-referrer`, absent on many privacy configurations, and trivially forged
 * by anything that is not a browser — so a server-side check on it would
 * refuse legitimate visitors while stopping nobody who meant harm.
 * `X-Frame-Options` is likewise not sent: it cannot express a list, and its
 * `ALLOW-FROM` form was removed from every current browser.
 */

/**
 * Whatever somebody typed, reduced to a hostname this module can enforce.
 *
 * People paste what they have to hand — a full URL from the address bar, a
 * host with a trailing slash, a value with `https://` on the front. All of
 * those name the same site, so all of them are accepted and normalised rather
 * than rejected with a format lecture.
 *
 * Returns null when there is nothing enforceable in the value:
 *
 * - a bare label with no dot (`localhost`, `intranet`) — a customer's public
 *   site always has a dot, and admitting one would be a `frame-ancestors`
 *   source that matches nothing they own;
 * - an IP address, for the same reason;
 * - a wildcard anywhere but the leading label, which CSP cannot express;
 * - a port, a path, a query, or credentials — none of which `frame-ancestors`
 *   matches on in the way somebody typing them expects.
 */
export function normalizeWidgetDomain(value: string): string | null {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 300) return null;

  // Strip a scheme and anything after the authority. Done by hand rather than
  // with `new URL()` because the common input here is a bare hostname, which
  // `new URL()` refuses outright.
  let host = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  host = host.split("/")[0] ?? "";
  host = host.split("?")[0] ?? "";
  host = host.split("#")[0] ?? "";

  // Credentials and ports: both are how a hostile value is made to read as a
  // trusted one, and neither survives into a `frame-ancestors` source anyway.
  if (host.includes("@")) return null;
  if (host.includes(":")) return null;

  host = host.replace(/\.+$/, "");

  // An IPv4 literal has no relationship to a customer's website and would make
  // the allowlist look like it covered something it does not.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;

  const parsed = widgetDomainSchema.safeParse(host);
  return parsed.success ? parsed.data : null;
}

/**
 * A typed list, normalised, de-duplicated, and capped.
 *
 * De-duplication matters more than it looks: `example.com` and
 * `https://example.com/` are the same site typed two ways, and a list showing
 * both makes a customer think one of them is not working.
 */
export function normalizeWidgetDomains(values: readonly string[]): {
  domains: string[];
  rejected: string[];
} {
  const domains: string[] = [];
  const rejected: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    if (value.trim().length === 0) continue;

    const normalized = normalizeWidgetDomain(value);
    if (normalized === null) {
      rejected.push(value.trim());
      continue;
    }
    if (seen.has(normalized)) continue;

    seen.add(normalized);
    if (domains.length < MAX_WIDGET_DOMAINS) domains.push(normalized);
    else rejected.push(value.trim());
  }

  return { domains, rejected };
}

/**
 * A newline- or comma-separated textarea, split into candidate domains.
 *
 * The configuration screen uses a textarea rather than a repeating field: a
 * customer pasting their four site hostnames out of a spreadsheet should not
 * have to press "add" four times.
 */
export function splitDomainInput(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

/**
 * The `frame-ancestors` source list for a widget's approved domains.
 *
 * An empty allowlist yields `*` — unrestricted, which is the honest rendering
 * of "the customer has not restricted this". The alternative, defaulting to
 * closed, would mean every widget was broken until somebody found this
 * setting, and the most common deployment (one restaurant, one website, pasted
 * once) would never work on the first try.
 *
 * A non-empty list always keeps `'self'` alongside it, because the in-app
 * preview frames the same document from Lia's own origin and a customer must
 * not have to add `lia.bond` to their own allowlist to see what they are
 * publishing.
 *
 * Both `https://` and `http://` sources are emitted for each host. Restaurant
 * websites are not universally on TLS, and a widget that silently fails to
 * paint on a plain-HTTP page is a support ticket that reads "it does not
 * work". The widget document itself is always served over TLS regardless.
 */
export function frameAncestorsDirective(domains: readonly string[]): string {
  if (domains.length === 0) return "frame-ancestors *";

  const sources = domains.flatMap((domain) => [`https://${domain}`, `http://${domain}`]);
  return `frame-ancestors 'self' ${sources.join(" ")}`;
}
