/**
 * The two string checks every widget document depends on.
 *
 * Source-neutral on purpose. Both widgets render provider-controlled text — a
 * reviewer's words, a headline written by a newsroom — into a page served on
 * the customer's own domain, which is the textbook shape of a stored XSS. The
 * iframe's origin limits the blast radius without removing it: the frame can
 * still be repainted into a convincing phishing surface under the restaurant's
 * branding.
 *
 * Kept here rather than in either renderer so that neither can grow its own
 * slightly different copy. There is exactly one escape function in this
 * feature and exactly one URL check.
 */

/**
 * The only way provider text reaches a widget document.
 *
 * Both quote forms are escaped, not just `<` and `&`, because the same helper
 * writes attribute values (`href`, `title`) as well as text nodes. One helper
 * with the strict rule beats two with a note about which to use where.
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * A URL that may become an anchor on a stranger's screen, or null.
 *
 * `escapeHtml` keeps a value inside its attribute; it has no opinion about
 * where the attribute points, so `javascript:alert(1)` survives it intact.
 * This is the second, different check: only `http:` and `https:` are allowed
 * through, and everything else — `javascript:`, `data:`, `blob:`, `file:`, a
 * protocol-relative `//host`, and anything unparseable — is refused.
 *
 * `http:` is admitted alongside `https:` because a local newspaper's archive
 * from 2011 is a real destination that a great many small publishers still
 * serve without TLS, and refusing it would drop the story rather than the
 * risk. The document is served over TLS regardless; the anchor is a link the
 * visitor chooses to follow.
 *
 * A refused URL costs one story its link — or, where the link is the story's
 * whole point, costs the story its place in the widget. It never emits an
 * unsafe anchor.
 */
export function safeHttpUrl(value: string | null | undefined): string | null {
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > 2000) return null;

  // Rejects a protocol-relative `//host/path` on its own, before `new URL`
  // has a base to resolve it against.
  if (trimmed.startsWith("//")) return null;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }

  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
  if (parsed.hostname.length === 0) return null;

  return parsed.toString();
}
