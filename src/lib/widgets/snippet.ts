/**
 * The embed snippet, and the script it loads.
 *
 * Both are built from one origin so a self-hosted or preview deployment
 * generates a snippet that points at itself rather than at production.
 *
 * The snippet's shape is fixed by where it has to survive: Squarespace,
 * Wix, WordPress, Shopify, and whatever a restaurant's cousin built in 2014.
 * That rules out several things people reach for first:
 *
 * - **No inline `<script>` with configuration in it.** Many builders strip
 *   inline script bodies, and a page with a content-security policy rejects
 *   them outright. A `src` and a data attribute survive both.
 * - **No `document.write`.** It is what the previous generation of embeds used
 *   and it destroys a page that has finished parsing, which is exactly what
 *   happens when a builder injects the block after load.
 * - **A `div` before the `script`, not after.** The mount point has to exist
 *   where the customer put it. The script is `async`, so it may arrive at any
 *   time, and it re-scans on mutation for exactly this reason.
 */

const SCRIPT_PATH = "/embed/review-widget.js";

/** Where one widget's frame lives. Also the URL the in-app preview frames. */
export function widgetFrameUrl(origin: string, publicId: string): string {
  return `${trimOrigin(origin)}/embed/review-widget/${encodeURIComponent(publicId)}`;
}

export function widgetScriptUrl(origin: string): string {
  return `${trimOrigin(origin)}${SCRIPT_PATH}`;
}

/**
 * The two lines a customer pastes.
 *
 * Deliberately two lines and no comment. Everything a snippet says gets pasted
 * into a page's source and read by whoever maintains that site next; a wall of
 * explanatory comments is noise there, and the explanation belongs on the
 * screen the customer copies it from.
 */
export function buildEmbedSnippet(origin: string, publicId: string): string {
  return [
    `<div data-lia-review-widget="${publicId}"></div>`,
    `<script async src="${widgetScriptUrl(origin)}"></script>`,
  ].join("\n");
}

function trimOrigin(origin: string): string {
  return origin.replace(/\/+$/, "");
}
