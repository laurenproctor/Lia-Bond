/**
 * Publication logos, and the trust boundary around them.
 *
 * A press widget wants to show the mastheads of the outlets that covered the
 * customer. Every obvious way of getting them is a way of turning the
 * customer's website into an uncontrolled network client, so none of them is
 * used:
 *
 * - **Not the provider's image URL.** GNews returns an `image` field; it is a
 *   publisher-controlled URL, and putting it in an `<img src>` on somebody's
 *   homepage means the publisher's server sees every visitor, sets whatever it
 *   likes, and can serve anything at all — including nothing, on the day their
 *   CDN moves.
 * - **Not a favicon service, Clearbit, Logo.dev, or Google's `s2/favicons`.**
 *   Same problem with a third party added: a request from the customer's page
 *   to a company the customer has never heard of, which their consent banner
 *   has an opinion about and their content policy may simply block.
 * - **Not a server-side fetch of a publisher-controlled URL during a render.**
 *   That is an SSRF surface reachable by anonymous traffic and an availability
 *   dependency on somebody else's uptime, on the one route that must always
 *   answer.
 * - **Not provider- or customer-supplied SVG markup.** Storing markup that
 *   ends up inline in a document is storing a script tag that has not been
 *   written yet.
 *
 * What is used instead: a small, versioned, typed registry of logo files Lia
 * itself serves, keyed by normalised publisher domain. The public iframe's
 * `img-src` is `'self' data:` and nothing else, so a mistake here cannot
 * become a request to another origin — the registry decides *which* local file
 * is drawn, and the content policy decides that only local files can be.
 *
 * **The resolver never chooses a path.** `press_widget_render` returns a
 * normalised domain and a display name. This module maps that domain to a
 * logo, and a domain that is not in the table renders as text. A row in the
 * database therefore cannot name an asset; it can only name a key that this
 * table may or may not recognise.
 *
 * **A missing logo never costs a story its place.** The publisher's name in
 * text is a complete rendering of "who published this", and dropping an
 * otherwise eligible article because Lia has no picture for its masthead would
 * be the tail wagging the dog.
 *
 * Adding a publication is a change to this file plus two files under
 * `public/widget-logos/` — no migration, no database write, no ingestion job.
 * Automated logo discovery is deliberately not built; see `docs/press-widget.md`.
 */

/* -------------------------------------------------------------------------- */
/* Domain normalisation                                                        */
/* -------------------------------------------------------------------------- */

/**
 * Whatever a provider reported, reduced to a key this table can be looked up
 * by.
 *
 * Lowercased, stripped of scheme, credentials, port, path, query, fragment,
 * trailing dots, and a leading `www.` — because `WWW.Example.com/story?a=1`
 * and `example.com` are the same outlet and a registry that held both would be
 * a registry that missed one.
 *
 * Returns null for anything that is not a hostname a publication could have:
 * an empty value, a bare label with no dot, an IP address, or a string with a
 * character a hostname cannot contain. Null is not an error — it is the text
 * fallback, which is a perfectly good rendering.
 */
export function normalizePublisherDomain(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim().toLowerCase();
  if (trimmed.length === 0 || trimmed.length > 253) return null;

  let host = trimmed.replace(/^[a-z][a-z0-9+.-]*:\/\//, "");
  host = host.split("/")[0] ?? "";
  host = host.split("?")[0] ?? "";
  host = host.split("#")[0] ?? "";

  // Credentials and ports are both how a hostile value is made to read as a
  // trusted one, and neither is part of a publication's identity.
  if (host.includes("@")) return null;
  host = host.split(":")[0] ?? "";

  host = host.replace(/\.+$/, "");
  if (host.startsWith("www.")) host = host.slice(4);

  if (host.length === 0 || host.length > 253) return null;
  // An IPv4 literal is not a publication.
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  // A hostname, with at least one dot. `localhost` and `intranet` name nothing
  // a reader could recognise as an outlet.
  if (!/^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/.test(host)) {
    return null;
  }

  return host;
}

/* -------------------------------------------------------------------------- */
/* The registry                                                                */
/* -------------------------------------------------------------------------- */

/** Where every bundled logo lives, and the only prefix a logo path may have. */
const LOGO_ROOT = "/widget-logos";

/**
 * The shape of a path this module is willing to emit.
 *
 * Checked rather than assumed, and checked on the way *out* rather than only
 * on the way in. The registry below is a literal in this file today; the check
 * is what makes "a logo path is always a versioned file under `/widget-logos/`"
 * a property of the module rather than of the care taken by whoever edits the
 * table next. `..` cannot appear, an absolute URL cannot appear, and neither
 * can a path pointing anywhere else in `public/`.
 */
const LOGO_PATH_PATTERN = /^\/widget-logos\/[a-z0-9-]+\/[a-z0-9-]+\.v[0-9]+\.svg$/;

export function isTrustedLogoPath(path: string): boolean {
  return LOGO_PATH_PATTERN.test(path);
}

export interface PublisherLogoAsset {
  /** Root-relative, served by Lia. Never an absolute URL. */
  path: string;
  /** Intrinsic dimensions, so the card reserves space before the file loads. */
  width: number;
  height: number;
}

export interface PublisherLogo {
  /** Stable key. Also the directory the assets live in. */
  key: string;
  /** The accessible name of the publication. Used as alt text. */
  name: string;
  light: PublisherLogoAsset;
  dark: PublisherLogoAsset;
}

/**
 * Every publication Lia holds a verified mark for.
 *
 * **This table ships with three entries, and all three are invented.** They
 * exist so the Website widgets landing page can show a real press widget
 * rendered by the real renderer, with real logo files, without putting a
 * trademark Lia has no licence to reproduce onto a marketing page — and
 * without implying that the invented coverage is somebody's real coverage.
 * Their domains are under `.example`, which RFC 2606 reserves and which can
 * therefore never collide with a publication a customer is actually covered by.
 *
 * The consequence is deliberate and worth stating plainly: **no real
 * publication has a bundled logo today, so production coverage renders the
 * publisher's name as text.** That is a complete rendering, and it is the
 * honest state until somebody does the licensing work outlet by outlet.
 * Adding one is a two-file change plus a row here.
 *
 * Every asset in this repository is original artwork drawn for it, and its
 * provenance is recorded in `public/widget-logos/README.md`.
 */
export const PUBLISHER_LOGOS: Readonly<Record<string, PublisherLogo>> = {
  "harbourledger.example": {
    key: "harbour-ledger",
    name: "The Harbour Ledger",
    light: { path: `${LOGO_ROOT}/harbour-ledger/harbour-ledger.v1.svg`, width: 168, height: 24 },
    dark: { path: `${LOGO_ROOT}/harbour-ledger/harbour-ledger-dark.v1.svg`, width: 168, height: 24 },
  },
  "meridiantable.example": {
    key: "meridian-table",
    name: "Meridian Table",
    light: { path: `${LOGO_ROOT}/meridian-table/meridian-table.v1.svg`, width: 148, height: 24 },
    dark: { path: `${LOGO_ROOT}/meridian-table/meridian-table-dark.v1.svg`, width: 148, height: 24 },
  },
  "northsidedispatch.example": {
    key: "northside-dispatch",
    name: "Northside Dispatch",
    light: { path: `${LOGO_ROOT}/northside-dispatch/northside-dispatch.v1.svg`, width: 186, height: 24 },
    dark: { path: `${LOGO_ROOT}/northside-dispatch/northside-dispatch-dark.v1.svg`, width: 186, height: 24 },
  },
};

/**
 * The logo for a publisher domain, or null.
 *
 * Null is the ordinary answer, not the exceptional one: it means the renderer
 * draws the publication's name in text. The domain is normalised here rather
 * than trusted from the caller, so a resolver that ever stopped normalising
 * would fall back to text rather than start matching on raw values.
 *
 * The returned paths are re-checked against `LOGO_PATH_PATTERN` before they
 * leave this function. A registry entry that somehow named an off-root path is
 * treated as no logo at all, which is the failure mode that costs a card a
 * picture rather than the one that puts an unexpected request on a customer's
 * page.
 */
export function resolvePublisherLogo(
  domain: string | null | undefined,
): PublisherLogo | null {
  const normalized = normalizePublisherDomain(domain);
  if (normalized === null) return null;

  const logo = PUBLISHER_LOGOS[normalized];
  if (!logo) return null;

  if (!isTrustedLogoPath(logo.light.path) || !isTrustedLogoPath(logo.dark.path)) {
    return null;
  }

  return logo;
}

/**
 * What the card writes where a mark would go, when there is no mark.
 *
 * The provider's own publisher name if it gave one, otherwise the normalised
 * domain, otherwise null — at which point the card draws no publisher line at
 * all rather than the word "Unknown", which tells a reader nothing and looks
 * like a bug.
 */
export function publisherDisplayName(
  publisherName: string | null,
  publisherDomain: string | null,
): string | null {
  const named = publisherName?.trim();
  if (named) return named;

  return normalizePublisherDomain(publisherDomain);
}
