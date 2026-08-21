/**
 * The content policy on a widget document.
 *
 * Shared by both widgets and by both of their preview routes, because a policy
 * restated in four places is a policy that is wrong in one of them. The two
 * widgets differ in exactly one directive — press loads logo files from Lia's
 * own origin, reviews load nothing at all — so that one is a parameter and the
 * rest are fixed.
 *
 * What each directive is closing:
 *
 * - `default-src 'none'` with `style-src`/`script-src` at `'unsafe-inline'`
 *   describes what these documents actually are: inlined CSS, one inline
 *   script, and no external resource beyond the `img-src` allowance below.
 *   There is no origin either document may fetch from, so provider text that
 *   somehow escaped escaping still could not reach the network.
 * - `img-src` and `media-src` are where the two widgets differ, and neither is
 *   ever widened to `https:`. Both are `'self' data:` on the review widget —
 *   `data:` is how its sample cards carry their pictures, `'self'` is where a
 *   customer's uploaded media would live — and the press widget takes the same
 *   `img-src` for its bundled publisher logos and no `media-src` at all,
 *   because it has no clip to play. A publisher logo on a customer's page must
 *   be a file Lia serves, not a request to a publisher's own server; see
 *   `docs/press-widget.md` on the logo trust boundary.
 * - `frame-ancestors` is the customer's approved-domain list, and the reason
 *   this header exists at all. The visitor's browser refuses to paint the
 *   frame anywhere else, which is a real control on a URL anybody can fetch
 *   with curl.
 * - `sandbox` is deliberately NOT set here. The loader sets it on the iframe
 *   element, where the embedder controls it; setting it in a response header
 *   too would give the frame an opaque origin and break the height channel's
 *   origin check.
 *
 * `X-Frame-Options` is likewise absent: it cannot express a list of origins,
 * and its `ALLOW-FROM` form was removed from every current browser. Sending
 * `DENY` or `SAMEORIGIN` alongside `frame-ancestors` would break the entire
 * feature in the browsers that honour it.
 */

export interface WidgetCspInput {
  /** A complete `frame-ancestors` directive, from `frameAncestorsDirective`. */
  frameAncestors: string;
  /**
   * The `img-src` source list.
   *
   * `"'self' data:"` on both widgets today, for different reasons: the review
   * widget's sample layouts carry pictures as `data:` URIs, and the press
   * widget loads bundled publisher logos from Lia's own origin. Never an
   * arbitrary host.
   */
  imgSrc: string;
  /**
   * The `media-src` source list, or omitted.
   *
   * Only the review widget has a video layout. Omitting it on the press widget
   * is not tidiness — `default-src 'none'` then covers it, so a `<video>` that
   * somehow reached that document could not load a thing.
   */
  mediaSrc?: string;
}

export function widgetDocumentCsp({
  frameAncestors,
  imgSrc,
  mediaSrc,
}: WidgetCspInput): string {
  return [
    "default-src 'none'",
    "style-src 'unsafe-inline'",
    "script-src 'unsafe-inline'",
    `img-src ${imgSrc}`,
    ...(mediaSrc ? [`media-src ${mediaSrc}`] : []),
    "form-action 'none'",
    "base-uri 'none'",
    frameAncestors,
  ].join("; ");
}

/**
 * The headers every widget document carries, whatever it draws.
 *
 * `Referrer-Policy: no-referrer` so a customer's page URL never travels to Lia
 * with the frame request, and `X-Robots-Tag` because a second indexable copy
 * of a review or a headline on Lia's domain would compete with the customer's
 * own page — and with the publisher's — for the words in it.
 */
export function widgetDocumentHeaders(input: {
  csp: string;
  cacheControl: string;
}): Record<string, string> {
  return {
    "content-type": "text/html; charset=utf-8",
    "content-security-policy": input.csp,
    "referrer-policy": "no-referrer",
    "x-content-type-options": "nosniff",
    "cache-control": input.cacheControl,
    "x-robots-tag": "noindex, nofollow",
  };
}
