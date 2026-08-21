import type {
  RenderedReviewWidget,
  ReviewWidgetTheme,
  ReviewWidgetUnavailableReason,
} from "@/domain";
import { escapeHtml } from "@/lib/widgets/html";
import { WIDGET_KINDS } from "@/lib/widgets/kinds";
import { widgetReviewDate } from "@/lib/widgets/relative-date";

/**
 * The widget document.
 *
 * A complete, self-contained HTML page returned by a route handler — not a
 * React page under `src/app/`, and the difference is the whole isolation
 * story. Anything rendered through the App Router inherits the root layout,
 * `globals.css`, Tailwind's preflight, and the React runtime. Every one of
 * those is a liability inside an iframe on somebody else's website: the
 * payload is two orders of magnitude larger than the markup needs, a change to
 * a product token silently restyles thousands of customer pages, and a
 * hydration error surfaces as a blank rectangle on a restaurant's homepage.
 *
 * So this is a string. No framework, no external stylesheet, no webfont, no
 * network request of any kind after the document itself — which also means the
 * widget adds no third-party request to a customer's page and nothing for a
 * consent banner to have an opinion about.
 *
 * The visual language follows the reference designs: a quiet card, a serif
 * quotation, gold stars, an initials disc where a photograph would go, and a
 * footer that separates the customer's link to Google from Lia's own line.
 * Photographs and video are deliberately absent in this layout — see
 * `REVIEW_WIDGET_LAYOUTS`.
 */

/* -------------------------------------------------------------------------- */
/* Escaping                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Re-exported rather than defined here.
 *
 * `escapeHtml` moved to `@/lib/widgets/html` when the press widget arrived and
 * needed the identical guarantee for a headline. It stays exported from this
 * module because "the review document's escaper" is how every caller and every
 * test already refers to it, and because there must visibly be exactly one.
 */
export { escapeHtml } from "@/lib/widgets/html";

/* -------------------------------------------------------------------------- */
/* Palette                                                                     */
/* -------------------------------------------------------------------------- */

export interface Palette {
  surface: string;
  border: string;
  quote: string;
  body: string;
  muted: string;
  rule: string;
  disc: string;
  discText: string;
  link: string;
  /** Fill of a filled star. */
  star: string;
  /**
   * Outline of a filled star.
   *
   * Not decoration. A gold fill measures 1.84:1 against white — well under
   * WCAG 1.4.11's 3:1 for meaningful graphics — so on its own a star rating is
   * a shape a low-vision reader cannot reliably find. The outline is what
   * carries the shape; the fill is what says the star is earned.
   */
  starOutline: string;
  /**
   * Outline of an empty star, which has no fill at all.
   *
   * Filled and empty are therefore distinguished by *form* (filled versus
   * hollow) rather than by two similar colours — the failure mode this palette
   * originally had, at 1.43:1 between gold and light grey.
   */
  starEmpty: string;
  quoteMark: string;
}

/**
 * Two palettes, written out rather than derived.
 *
 * Deliberately **not** Lia's product tokens. The widget is on the customer's
 * website, wearing the customer's credibility, and Lia's purple appearing on a
 * restaurant's homepage would read as an advert rather than as a review. The
 * only Lia-coloured thing in the document is the attribution line, and it is
 * grey.
 *
 * The dark palette is not the light one inverted. Gold on near-black is what
 * the reference uses because a pure-white card floated on a dark page looks
 * like a rendering failure, and #fff text at this size on #111 vibrates.
 */
export const WIDGET_PALETTES: Record<ReviewWidgetTheme, Palette> = {
  light: {
    surface: "#ffffff",
    border: "#e6e8ec",
    quote: "#12161f",
    body: "#2c3440",
    muted: "#6b7280",
    rule: "#eceef2",
    disc: "#123a6b",
    discText: "#ffffff",
    link: "#1a4d8f",
    star: "#f5b418",
    // 4.18:1 on white.
    starOutline: "#a1740a",
    // 3.10:1 on white.
    starEmpty: "#8b939f",
    quoteMark: "#123a6b",
  },
  dark: {
    surface: "#12130f",
    border: "#2a2c26",
    quote: "#f4efe4",
    body: "#d8d3c6",
    muted: "#948e80",
    rule: "#26281f",
    disc: "#c8a96a",
    discText: "#17180f",
    link: "#d8b878",
    star: "#e5b64a",
    // 4.43:1 on the dark surface.
    starOutline: "#9a7620",
    // 4.09:1 on the dark surface.
    starEmpty: "#75776a",
    quoteMark: "#c8a96a",
  },
};

/* -------------------------------------------------------------------------- */
/* Marks                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Google's four-colour G, inline.
 *
 * Inline rather than an `<img>` for the same reason everything else here is
 * inline: a widget that fetches a logo is a widget that shows a broken image
 * on a page with a strict content policy, and it is a third-party request on
 * somebody's website. The four brand colours are fixed in both themes —
 * recolouring a trademark to suit a palette is the one thing a review widget
 * must not do, because the mark is the attribution.
 */
const GOOGLE_G = `<svg class="g" viewBox="0 0 48 48" width="18" height="18" aria-hidden="true" focusable="false"><path fill="#4285F4" d="M45.1 24.5c0-1.6-.1-3.2-.4-4.7H24v8.9h11.8c-.5 2.7-2 5-4.4 6.6v5.5h7.1c4.1-3.8 6.6-9.5 6.6-16.3z"/><path fill="#34A853" d="M24 46c6 0 11-2 14.6-5.3l-7.1-5.5c-2 1.3-4.5 2.1-7.5 2.1-5.8 0-10.6-3.9-12.4-9.1H4.3v5.7C7.9 41.1 15.4 46 24 46z"/><path fill="#FBBC05" d="M11.6 28.2c-.4-1.3-.7-2.7-.7-4.2s.3-2.9.7-4.2v-5.7H4.3A22 22 0 0 0 2 24c0 3.6.9 6.9 2.3 9.9l7.3-5.7z"/><path fill="#EA4335" d="M24 10.7c3.3 0 6.2 1.1 8.500 3.3l6.3-6.3C34.9 4.1 30 2 24 2 15.4 2 7.9 6.9 4.3 14.1l7.3 5.7c1.8-5.2 6.6-9.1 12.4-9.1z"/></svg>`;

/** Lia's leaf, matched to the reference's "Powered by Lia" lockup. */
const LIA_MARK = `<svg class="leaf" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><path fill="currentColor" d="M13.4 2.2c.3 4.6-1 7.6-3.2 9.1-1.7 1.2-3.7 1.2-4.9.4l-1.5 1.9a.7.7 0 0 1-1.1-.9l1.5-1.9c-.9-1.2-1.1-3.2 0-5C5.6 3.5 8.6 2.2 13.4 2.2z"/></svg>`;

/** The star outline, shared by both states so the geometry cannot drift. */
const STAR_PATH = "M10 1.6l2.5 5.2 5.7.8-4.1 4 1 5.7-5.1-2.7-5.1 2.7 1-5.7-4.1-4 5.7-.8z";

function starRow(rating: number, palette: Palette): string {
  const filled = Math.round(rating);

  // Every star is stroked, and only earned ones are filled. That is what makes
  // the rating readable without relying on two colours being told apart: a
  // gold fill measures 1.84:1 against white, so a palette that distinguished
  // filled from empty by colour alone would be unreadable to anybody whose
  // sight is not excellent.
  const stars = Array.from({ length: 5 }, (_, index) => {
    const earned = index < filled;
    const fill = earned ? palette.star : "none";
    const stroke = earned ? palette.starOutline : palette.starEmpty;
    return `<svg viewBox="0 0 20 20" width="16" height="16" aria-hidden="true" focusable="false"><path fill="${fill}" stroke="${stroke}" stroke-width="1.2" stroke-linejoin="round" d="${STAR_PATH}"/></svg>`;
  }).join("");

  // One accessible name for the group rather than five decorative stars with
  // no text alternative. Screen readers get "Rated 5 out of 5"; the SVGs are
  // hidden individually so the rating is not read out as five separate marks.
  return `<span class="stars" role="img" aria-label="Rated ${escapeHtml(
    formatRating(rating),
  )} out of 5">${stars}</span>`;
}

/** "5" not "5.0"; "4.5" stays "4.5". Google publishes whole and half stars. */
function formatRating(rating: number): string {
  return Number.isInteger(rating) ? String(rating) : rating.toFixed(1);
}

/* -------------------------------------------------------------------------- */
/* Styles                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The stylesheet, inlined.
 *
 * Three things in here are load-bearing rather than cosmetic:
 *
 * - **`box-sizing` and a margin reset on `body`.** The document is the whole
 *   frame; a default 8px body margin makes the auto-height measurement report
 *   16px more than the card occupies, and the frame grows every render.
 * - **A system font stack with a serif for the quotation.** No webfont, so
 *   nothing to load and nothing to block paint. The serif is what makes the
 *   quotation read as a testimonial rather than as UI copy, which is the whole
 *   visual argument of the reference designs.
 * - **A container query rather than a viewport media query.** The frame is as
 *   wide as the customer's column, not as wide as the screen, so `@media
 *   (max-width: …)` measures the wrong box — a phone-shaped widget in a narrow
 *   sidebar on a 27-inch monitor would never trigger it.
 */
function styles(theme: ReviewWidgetTheme, palette: Palette): string {
  return `
:root { color-scheme: ${theme}; }
* { box-sizing: border-box; }
html, body { margin: 0; padding: 0; background: transparent; }
body {
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  -webkit-font-smoothing: antialiased;
  color: ${palette.body};
}
/*
 * The container is the wrapper, not the card.
 *
 * Container queries style a container's *descendants*, never the container
 * element itself — so declaring container-type on .card would silently drop
 * every .card rule inside the query below while the rules for its children
 * applied normally. That failure is invisible in a diff and shows up as a
 * card keeping its desktop padding inside a phone.
 */
.widget { container-type: inline-size; }
.card {
  background: ${palette.surface};
  border: 1px solid ${palette.border};
  border-radius: 16px;
  padding: 22px 24px 16px;
  max-width: 100%;
}
.top { display: flex; gap: 20px; align-items: flex-start; }
.mark {
  display: flex; flex-direction: column; gap: 10px; align-items: flex-start;
  padding-right: 20px; border-right: 1px solid ${palette.rule};
  flex: 0 0 auto; min-width: 132px;
}
.mark .wordmark {
  display: inline-flex; align-items: center; gap: 7px;
  font-size: 14px; font-weight: 600; letter-spacing: -0.01em; color: ${palette.quote};
}
.stars { display: inline-flex; gap: 2px; }
.body { flex: 1 1 auto; min-width: 0; }
blockquote {
  margin: 0;
  font-family: ui-serif, Georgia, Cambria, "Times New Roman", Times, serif;
  font-size: 21px; line-height: 1.32; letter-spacing: -0.01em;
  color: ${palette.quote};
  overflow-wrap: break-word;
}
blockquote::before {
  content: "\\201C"; color: ${palette.quoteMark};
  font-size: 34px; line-height: 0; vertical-align: -0.18em; margin-right: 4px;
}
.who { display: flex; align-items: center; gap: 11px; margin-top: 18px; }
.disc {
  width: 38px; height: 38px; border-radius: 50%; flex: 0 0 auto;
  background: ${palette.disc}; color: ${palette.discText};
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; font-weight: 600; letter-spacing: 0.02em;
}
.name { display: block; font-size: 14px; font-weight: 600; color: ${palette.quote}; }
.when { display: block; font-size: 13px; color: ${palette.muted}; margin-top: 1px; }
.foot {
  display: flex; align-items: center; justify-content: space-between; gap: 12px;
  margin-top: 18px; padding-top: 13px; border-top: 1px solid ${palette.rule};
  font-size: 13px;
}
.foot a {
  color: ${palette.link}; font-weight: 600; text-decoration: none;
  display: inline-flex; align-items: center; gap: 5px;
  border-radius: 4px;
}
.foot a:hover { text-decoration: underline; }
.foot a:focus-visible { outline: 2px solid ${palette.link}; outline-offset: 3px; }
.lia {
  color: ${palette.muted}; display: inline-flex; align-items: center; gap: 5px;
  margin-left: auto; font-size: 12.5px;
}
.lia .leaf { color: ${palette.muted}; }
.lia strong { color: ${palette.body}; font-weight: 600; }
.empty { font-size: 14px; color: ${palette.muted}; line-height: 1.5; margin: 0; }
.empty .headline { display: block; color: ${palette.quote}; font-weight: 600; margin-bottom: 3px; }

@container (max-width: 460px) {
  .card { padding: 18px 18px 13px; }
  .top { flex-direction: column; gap: 14px; }
  .mark {
    flex-direction: row; align-items: center; gap: 12px;
    padding-right: 0; padding-bottom: 14px;
    border-right: 0; border-bottom: 1px solid ${palette.rule};
    width: 100%; min-width: 0;
  }
  blockquote { font-size: 18px; }
  .foot { flex-wrap: wrap; row-gap: 8px; }
}

@media (prefers-reduced-motion: no-preference) {
  .foot a { transition: color 120ms ease; }
}
`.trim();
}

/* -------------------------------------------------------------------------- */
/* Auto-height                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The frame's only script: tell the parent how tall this is.
 *
 * An iframe cannot size itself to its content, and a fixed height either clips
 * a long review or leaves a gap under a short one. The loader on the customer's
 * page listens for this message and sets the height.
 *
 * `postMessage` targets `"*"` because the frame genuinely does not know which
 * origin embedded it — that is what an embed is. Nothing sensitive travels in
 * the message (a number and a widget id already in the page's HTML), and the
 * *listener* is where the origin check that matters lives: the loader rejects
 * any message whose origin is not Lia's.
 *
 * `ResizeObserver` rather than a load-time measurement: a webfont on the host
 * page cannot affect this document, but a container-query breakpoint can fire
 * when the customer's own layout reflows, and the frame has to follow.
 */
function heightScript(publicId: string): string {
  return `
(function () {
  var id = ${JSON.stringify(publicId)};
  var last = 0;
  function report() {
    var el = document.querySelector(".widget");
    if (!el) return;
    var height = Math.ceil(el.getBoundingClientRect().height);
    if (height === last || height === 0) return;
    last = height;
    parent.postMessage({ source: ${JSON.stringify(
      WIDGET_KINDS.review.messageSource,
    )}, type: "height", id: id, height: height }, "*");
  }
  if (typeof ResizeObserver === "function") {
    new ResizeObserver(report).observe(document.documentElement);
  }
  window.addEventListener("load", report);
  report();
})();
`.trim();
}

/* -------------------------------------------------------------------------- */
/* Copy                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * What an empty widget says, in the customer's own page.
 *
 * Every one of these is written for two readers at once: the restaurant owner,
 * who needs to know what to do, and the guest who happened to load the page
 * first, who must not be shown Lia's internal vocabulary. So none of them
 * mentions eligibility, statuses, or dismissals — and none of them shows a
 * different review, which is the failure the product brief singles out.
 *
 * They are quiet on purpose. A red error box on a restaurant's homepage is
 * worse for the restaurant than a small grey line.
 */
const UNAVAILABLE_COPY: Record<
  ReviewWidgetUnavailableReason,
  { headline: string; detail: string }
> = {
  unknown_widget: {
    headline: "This review widget is no longer available.",
    detail:
      "The embed code on this page points at a widget that has been removed or had its code regenerated. Copy the current embed code from Lia.",
  },
  disabled: {
    headline: "This review widget is switched off.",
    detail: "Turn it back on in Lia to start showing reviews here again.",
  },
  selected_review_unavailable: {
    headline: "The selected review is not available.",
    detail:
      "The review this widget was pinned to can no longer be shown. Choose another one in Lia — no other review will be shown in its place.",
  },
  no_eligible_review: {
    headline: "No review to show yet.",
    detail:
      "This location has no Google review that meets the widget’s settings. It will appear here as soon as one does.",
  },
};

/* -------------------------------------------------------------------------- */
/* The document                                                                */
/* -------------------------------------------------------------------------- */

export interface RenderDocumentInput {
  publicId: string;
  rendered: RenderedReviewWidget;
  /** Injected so a test, the preview, and the public page all agree. */
  now: number;
}

export function renderReviewWidgetDocument(input: RenderDocumentInput): string {
  const { rendered, publicId, now } = input;
  const palette = WIDGET_PALETTES[rendered.theme];

  const inner =
    rendered.state === "ready"
      ? readyMarkup(rendered, palette, now)
      : unavailableMarkup(rendered.reason);

  const attribution = rendered.showAttribution
    ? `<span class="lia">${LIA_MARK} Powered by <strong>Lia</strong></span>`
    : "";

  // The footer row exists whenever there is something to put in it. A widget
  // with no Google link and no attribution draws no rule, rather than an empty
  // band under the review.
  const foot =
    rendered.state === "ready" && rendered.review.readOnGoogleUrl
      ? `<div class="foot"><a href="${escapeHtml(
          rendered.review.readOnGoogleUrl,
        )}" target="_blank" rel="noopener noreferrer nofollow">Read on Google<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M6 2H2.8v11.2H14V10M9.5 2H14v4.5M14 2L7.2 8.8"/></svg></a>${attribution}</div>`
      : attribution
        ? `<div class="foot">${attribution}</div>`
        : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Review</title>
<style>${styles(rendered.theme, palette)}</style>
</head>
<body>
<div class="widget"><div class="card">${inner}${foot}</div></div>
<script>${heightScript(publicId)}</script>
</body>
</html>`;
}

function readyMarkup(
  rendered: Extract<RenderedReviewWidget, { state: "ready" }>,
  palette: Palette,
  now: number,
): string {
  const review = rendered.review;

  return `<div class="top">
<div class="mark">
<span class="wordmark">${GOOGLE_G} Google Review</span>
${starRow(review.rating, palette)}
</div>
<div class="body">
<blockquote>${escapeHtml(review.text)}</blockquote>
<div class="who">
<span class="disc" aria-hidden="true">${escapeHtml(review.authorInitials)}</span>
<span>
<span class="name">${escapeHtml(review.authorName)}</span>
<span class="when">${escapeHtml(widgetReviewDate(review.publishedAt, now))}</span>
</span>
</div>
</div>
</div>`;
}

function unavailableMarkup(reason: ReviewWidgetUnavailableReason): string {
  const copy = UNAVAILABLE_COPY[reason];
  return `<p class="empty"><span class="headline">${escapeHtml(
    copy.headline,
  )}</span>${escapeHtml(copy.detail)}</p>`;
}
