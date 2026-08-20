import { isWidgetPublicIdShaped } from "@/lib/widgets/public-id";

/**
 * The loader script served at `/embed/review-widget.js`.
 *
 * Written as a string rather than as a source file that a bundler emits, and
 * that is a deliberate trade. A bundled entry point would be idiomatic Next.js
 * and would give this code type checking — but it would also be built for
 * modern browsers by whatever the framework's target happens to be that
 * quarter, fingerprinted into a URL that cannot appear in a snippet already
 * pasted into a thousand websites, and liable to grow a runtime import the day
 * somebody adds one. This file's whole job is to still work in five years on a
 * page nobody has touched since.
 *
 * So: ES5, no dependencies, no polyfill, roughly 2 KB, and every construct in
 * it works back to IE11 — not because IE matters, but because "the oldest
 * thing that will ever load this" is the correct design target for a public
 * embed and IE11 is a legible proxy for it.
 *
 * What it does, in order:
 *
 * 1. finds every `[data-lia-review-widget]` element;
 * 2. mounts one iframe per element, exactly once, keyed by a marker attribute
 *    so a double-included script cannot double-mount;
 * 3. listens for height messages from Lia's origin **only**, and sizes the
 *    frame to its content;
 * 4. re-scans when the DOM changes, because website builders inject blocks
 *    after the page has loaded and an `async` script that only ran once would
 *    miss them.
 *
 * The origin check on the message listener is the security-relevant line in
 * the whole file: without it, any frame on the page could resize Lia's frame,
 * which is a small thing that becomes a large one when the resized frame is
 * pushed over the page's own controls.
 */

export function buildLoaderScript(origin: string): string {
  const trimmed = origin.replace(/\/+$/, "");

  return `/* Lia review widget loader. https://lia.bond */
(function () {
  "use strict";

  var ORIGIN = ${JSON.stringify(trimmed)};
  var ATTR = "data-lia-review-widget";
  var MOUNTED = "data-lia-mounted";
  var frames = [];

  function isValidId(value) {
    return typeof value === "string" && /^rw_[A-Za-z0-9_-]{20}$/.test(value);
  }

  function mount(host) {
    if (host.getAttribute(MOUNTED) === "1") return;

    var id = host.getAttribute(ATTR);
    if (!isValidId(id)) return;

    host.setAttribute(MOUNTED, "1");

    var frame = document.createElement("iframe");
    frame.src = ORIGIN + "/embed/review-widget/" + encodeURIComponent(id);
    frame.title = "Customer review";
    frame.loading = "lazy";
    // The narrow sandbox that still lets the widget do its two jobs: run its
    // height script, and open the one "Read on Google" link. Everything else —
    // forms, top-level navigation, downloads, pointer lock, modals — is denied.
    //
    // "allow-same-origin" alongside "allow-scripts" is the pairing that is
    // usually a warning sign, and it is correct here. The danger is a frame
    // that is same-origin *with its embedder*, which can then reach up and
    // remove its own sandbox; this document is served from Lia and embedded on
    // the customer's domain, so it is cross-origin by construction. Without it
    // the frame gets an opaque origin, every message it posts arrives at the
    // listener below as origin "null", and the origin check that makes the
    // resize channel safe would have nothing to check against.
    frame.setAttribute(
      "sandbox",
      "allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox"
    );
    frame.setAttribute("scrolling", "no");
    frame.setAttribute("frameborder", "0");
    frame.style.width = "100%";
    frame.style.border = "0";
    frame.style.display = "block";
    frame.style.overflow = "hidden";
    // A first height that is close enough that the card does not visibly jump
    // when the real measurement arrives a frame later.
    frame.style.height = "220px";
    frame.style.colorScheme = "normal";

    host.appendChild(frame);
    frames.push({ id: id, frame: frame });
  }

  function scan() {
    var hosts = document.querySelectorAll("[" + ATTR + "]");
    for (var i = 0; i < hosts.length; i++) mount(hosts[i]);
  }

  function onMessage(event) {
    if (event.origin !== ORIGIN) return;

    var data = event.data;
    if (!data || data.source !== "lia-review-widget" || data.type !== "height") return;

    var height = parseInt(data.height, 10);
    if (!(height > 0) || height > 4000) return;

    for (var i = 0; i < frames.length; i++) {
      // Matched on the frame's own window rather than on the id in the
      // message: an id is guessable from the page's HTML, a window handle is
      // not, so a hostile frame cannot resize a sibling by claiming its id.
      if (frames[i].frame.contentWindow === event.source) {
        frames[i].frame.style.height = height + "px";
        return;
      }
    }
  }

  if (window.addEventListener) window.addEventListener("message", onMessage, false);

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", scan);
  } else {
    scan();
  }

  // Website builders inject content after load, and a customer may have a
  // widget inside a tab or an accordion that is not in the DOM at first paint.
  if (typeof MutationObserver === "function") {
    new MutationObserver(scan).observe(document.documentElement, {
      childList: true,
      subtree: true
    });
  }
})();
`;
}

/**
 * The pattern the loader tests ids against, restated in TypeScript.
 *
 * Exported so `tests/review-widget-embed.test.ts` can assert the two agree:
 * the loader's copy is inside a template literal and cannot import anything,
 * which is precisely the kind of duplication that drifts silently.
 */
export function loaderAcceptsPublicId(value: string): boolean {
  return isWidgetPublicIdShaped(value);
}
