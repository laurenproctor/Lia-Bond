import type {
  PressWidgetStory,
  PressWidgetTheme,
  PressWidgetUnavailableReason,
  RenderedPressWidget,
} from "@/domain";
import { escapeHtml } from "@/lib/widgets/html";
import { WIDGET_KINDS } from "@/lib/widgets/kinds";
import { widgetArticleDate, widgetArticleDateTime } from "@/lib/widgets/press/date";
import {
  publisherDisplayName,
  resolvePublisherLogo,
} from "@/lib/widgets/press/publisher-logos";

/**
 * The press widget document.
 *
 * A complete, self-contained HTML page returned by a route handler — not a
 * React page under `src/app/`, for every reason the review document's header
 * records: no framework, no external stylesheet, no webfont, no hydration to
 * fail inside somebody else's page.
 *
 * One difference from the review document, and it is the only one that matters
 * for security: this document loads images. Publisher logos are files Lia
 * serves from its own origin, the content policy is `img-src 'self' data:`,
 * and the path is chosen by `resolvePublisherLogo` from a normalised domain —
 * never by anything the resolver returned. A publication Lia holds no mark for
 * renders as text and keeps its place in the list.
 *
 * The visual language deliberately does not imitate the review card. A review
 * is a quotation and reads as one: serif, large, one voice. Press is a
 * citation list and reads as one: a masthead, a headline, a line of context, a
 * date, and a link — three of them, stacked, separated by rules. Somebody
 * glancing at a homepage should be able to tell the two apart without reading
 * either.
 */

/* -------------------------------------------------------------------------- */
/* Palette                                                                     */
/* -------------------------------------------------------------------------- */

export interface PressPalette {
  surface: string;
  border: string;
  /** The headline, and anything else that has to be read first. */
  headline: string;
  body: string;
  muted: string;
  rule: string;
  link: string;
  /** The small "In the press" eyebrow above the list. */
  eyebrow: string;
  /**
   * The plate a logo or a publisher name sits on.
   *
   * A logo needs a consistent background or a light mark vanishes on a light
   * card. It is a very low-contrast tint rather than a box: the mark is the
   * subordinate element on this card and a hard-edged container would fight
   * the headline for attention.
   */
  plate: string;
  /** The publisher's name when it is drawn as text instead of a mark. */
  publisher: string;
}

/**
 * Two palettes, written out rather than derived.
 *
 * Deliberately **not** Lia's product tokens, for the reason the review
 * palettes record: the widget wears the customer's credibility, and Lia's
 * purple on a restaurant's homepage reads as an advert. It is also not the
 * review widget's palette — that one is built around a gold star and a serif
 * quotation, and neither appears here.
 *
 * Every pairing is measured in `tests/press-widget-contrast.test.ts` against
 * the surface it is actually drawn on. The dark palette is not the light one
 * inverted: a pure-white card floated on a dark page looks like a rendering
 * failure, and `#fff` body text at 13px on `#111` vibrates.
 */
export const PRESS_WIDGET_PALETTES: Record<PressWidgetTheme, PressPalette> = {
  light: {
    surface: "#ffffff",
    border: "#e6e8ec",
    headline: "#12161f",
    body: "#3a4250",
    muted: "#5f6875",
    rule: "#eceef2",
    link: "#1a4d8f",
    eyebrow: "#5f6875",
    plate: "#f6f7f9",
    publisher: "#2c3440",
  },
  dark: {
    surface: "#12141a",
    border: "#272a33",
    headline: "#f2f4f8",
    body: "#c9ced9",
    muted: "#9aa2b1",
    rule: "#242731",
    link: "#8fb7ea",
    eyebrow: "#9aa2b1",
    plate: "#1b1e26",
    publisher: "#dfe4ec",
  },
};

/* -------------------------------------------------------------------------- */
/* Marks                                                                       */
/* -------------------------------------------------------------------------- */

/** Lia's leaf, matched to the review widget's "Powered by Lia" lockup. */
const LIA_MARK = `<svg class="leaf" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true" focusable="false"><path fill="currentColor" d="M13.4 2.2c.3 4.6-1 7.6-3.2 9.1-1.7 1.2-3.7 1.2-4.9.4l-1.5 1.9a.7.7 0 0 1-1.1-.9l1.5-1.9c-.9-1.2-1.1-3.2 0-5C5.6 3.5 8.6 2.2 13.4 2.2z"/></svg>`;

/** The outbound arrow on "Read article". Inline, like everything else here. */
const EXTERNAL_MARK = `<svg viewBox="0 0 16 16" width="12" height="12" aria-hidden="true" focusable="false"><path fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" d="M6 2H2.8v11.2H14V10M9.5 2H14v4.5M14 2L7.2 8.8"/></svg>`;

/* -------------------------------------------------------------------------- */
/* Styles                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * The stylesheet, inlined.
 *
 * Four things in here are load-bearing rather than cosmetic:
 *
 * - **`box-sizing` and a margin reset on `body`.** The document is the whole
 *   frame; a default 8px body margin makes the auto-height measurement report
 *   16px more than the card occupies, and the frame grows every render.
 * - **`object-fit: contain` on every logo, with a fixed box height and an
 *   `auto` width.** A masthead is a wordmark with its own aspect ratio;
 *   stretching one to a common box is the single most recognisable way to make
 *   a publication look like it did not consent to appear. The box reserves
 *   consistent vertical space, and the mark sits inside it at whatever width
 *   it needs.
 * - **A capped logo height (20px) well under the headline's 15px bold.** The
 *   headline is what a reader is there for; a masthead larger than it turns a
 *   proof strip into an advert for somebody else.
 * - **A container query rather than a viewport media query.** The frame is as
 *   wide as the customer's column, not as wide as the screen, so
 *   `@media (max-width: …)` measures the wrong box.
 */
function styles(theme: PressWidgetTheme, palette: PressPalette): string {
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
 * The container is the wrapper, not the card — container queries style a
 * container's descendants and never the container element itself, so
 * declaring container-type on .card would silently drop every .card rule
 * inside the query below while its children's rules applied normally.
 */
.widget { container-type: inline-size; }
.card {
  background: ${palette.surface};
  border: 1px solid ${palette.border};
  border-radius: 16px;
  padding: 18px 22px 14px;
  max-width: 100%;
}
.eyebrow {
  display: block; margin: 0 0 12px;
  font-size: 11.5px; font-weight: 600; letter-spacing: 0.07em; text-transform: uppercase;
  color: ${palette.eyebrow};
}
.stories { list-style: none; margin: 0; padding: 0; }
.story { padding: 13px 0; border-top: 1px solid ${palette.rule}; }
.story:first-child { padding-top: 0; border-top: 0; }
.masthead {
  display: flex; align-items: center;
  min-height: 22px; margin-bottom: 7px;
}
/*
 * A fixed-height box with an auto width. Every mark gets the same vertical
 * space and keeps its own proportions; none is cropped, stretched, or
 * recoloured.
 */
.logo {
  display: block; height: 20px; width: auto;
  max-width: 190px; object-fit: contain; object-position: left center;
}
.publisher {
  font-size: 12.5px; font-weight: 600; letter-spacing: 0.01em;
  color: ${palette.publisher};
  background: ${palette.plate};
  border-radius: 5px; padding: 3px 7px;
}
.headline {
  margin: 0; font-size: 15px; line-height: 1.35; font-weight: 650;
  letter-spacing: -0.005em; color: ${palette.headline};
  overflow-wrap: break-word;
}
.headline a { color: inherit; text-decoration: none; }
.headline a:hover { text-decoration: underline; }
.headline a:focus-visible { outline: 2px solid ${palette.link}; outline-offset: 3px; border-radius: 3px; }
.excerpt {
  margin: 5px 0 0; font-size: 13px; line-height: 1.45; color: ${palette.body};
  overflow-wrap: break-word;
}
.meta {
  display: flex; flex-wrap: wrap; align-items: center; gap: 10px;
  margin-top: 8px; font-size: 12.5px;
}
.when { color: ${palette.muted}; }
.read {
  color: ${palette.link}; font-weight: 600; text-decoration: none;
  display: inline-flex; align-items: center; gap: 5px; border-radius: 4px;
}
.read:hover { text-decoration: underline; }
.read:focus-visible { outline: 2px solid ${palette.link}; outline-offset: 3px; }
.foot {
  display: flex; align-items: center; justify-content: flex-end;
  margin-top: 12px; padding-top: 11px; border-top: 1px solid ${palette.rule};
}
.lia {
  color: ${palette.muted}; display: inline-flex; align-items: center; gap: 5px;
  font-size: 12.5px;
}
.lia .leaf { color: ${palette.muted}; }
.lia strong { color: ${palette.body}; font-weight: 600; }
.empty { font-size: 14px; color: ${palette.muted}; line-height: 1.5; margin: 0; }
.empty .headline-line { display: block; color: ${palette.headline}; font-weight: 600; font-size: 14px; margin-bottom: 3px; }

@container (max-width: 460px) {
  .card { padding: 16px 16px 12px; }
  .headline { font-size: 14.5px; }
  .logo { max-width: 150px; }
  .meta { row-gap: 6px; }
}

@media (prefers-reduced-motion: no-preference) {
  .read, .headline a { transition: color 120ms ease; }
}
`.trim();
}

/* -------------------------------------------------------------------------- */
/* Auto-height                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The frame's only script: tell the parent how tall this is.
 *
 * Identical in shape to the review document's, and deliberately a separate
 * copy rather than a shared builder: the two are five lines each, they post
 * different `source` values, and a shared generator would be a third thing to
 * read before understanding either. What must not diverge is the *contract*,
 * and that lives in `WIDGET_KINDS.press.messageSource`, which both this and
 * the listener import.
 *
 * `postMessage` targets `"*"` because the frame genuinely does not know which
 * origin embedded it — that is what an embed is. Nothing sensitive travels in
 * the message (a number and a widget id already in the page's HTML), and the
 * *listener* is where the origin check that matters lives.
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
      WIDGET_KINDS.press.messageSource,
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
 * What an empty press widget says, in the customer's own page.
 *
 * Written for two readers at once: the restaurant owner, who needs to know
 * what to do, and the guest who happened to load the page first, who must not
 * be shown Lia's internal vocabulary. So none of them mentions eligibility,
 * monitoring queries, syndication, or dismissals.
 *
 * They are quiet on purpose. A red error box on somebody's homepage is worse
 * for them than a small grey line.
 */
const UNAVAILABLE_COPY: Record<
  PressWidgetUnavailableReason,
  { headline: string; detail: string }
> = {
  unknown_widget: {
    headline: "This press widget is no longer available.",
    detail:
      "The embed code on this page points at a widget that has been removed or had its code regenerated. Copy the current embed code from Lia.",
  },
  disabled: {
    headline: "This press widget is switched off.",
    detail: "Turn it back on in Lia to start showing coverage here again.",
  },
  no_eligible_press: {
    headline: "No press coverage to show yet.",
    detail:
      "Recent coverage will appear here as soon as there is some to show.",
  },
};

/* -------------------------------------------------------------------------- */
/* The document                                                                */
/* -------------------------------------------------------------------------- */

export interface RenderPressDocumentInput {
  publicId: string;
  rendered: RenderedPressWidget;
}

export function renderPressWidgetDocument(input: RenderPressDocumentInput): string {
  const { rendered, publicId } = input;
  const palette = PRESS_WIDGET_PALETTES[rendered.theme];

  const inner =
    rendered.state === "ready"
      ? readyMarkup(rendered)
      : unavailableMarkup(rendered.reason);

  const foot = rendered.showAttribution
    ? `<div class="foot"><span class="lia">${LIA_MARK} Powered by <strong>Lia</strong></span></div>`
    : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Recent press</title>
<style>${styles(rendered.theme, palette)}</style>
</head>
<body>
<div class="widget"><div class="card">${inner}${foot}</div></div>
<script>${heightScript(publicId)}</script>
</body>
</html>`;
}

function readyMarkup(
  rendered: Extract<RenderedPressWidget, { state: "ready" }>,
): string {
  const items = rendered.stories
    .map((story) => storyMarkup(story, rendered.theme))
    .join("");

  // A heading rather than a bare list. Lifted out of the loop because the
  // eyebrow labels the group, and repeating it per story would make a screen
  // reader announce "in the press" three times.
  return `<span class="eyebrow">In the press</span>
<ul class="stories">${items}</ul>`;
}

function storyMarkup(story: PressWidgetStory, theme: PressWidgetTheme): string {
  const date = widgetArticleDate(story.publishedAt);
  const dateTime = widgetArticleDateTime(story.publishedAt);

  return `<li class="story">
${mastheadMarkup(story, theme)}
<p class="headline"><a href="${escapeHtml(story.sourceUrl)}" target="_blank" rel="noopener noreferrer nofollow">${escapeHtml(story.headline)}</a></p>
${story.excerpt ? `<p class="excerpt">${escapeHtml(story.excerpt)}</p>` : ""}
<div class="meta">
${date ? `<time class="when" datetime="${escapeHtml(dateTime)}">${escapeHtml(date)}</time>` : ""}
<a class="read" href="${escapeHtml(story.sourceUrl)}" target="_blank" rel="noopener noreferrer nofollow">Read article${EXTERNAL_MARK}</a>
</div>
</li>`;
}

/**
 * The publication's mark, or its name.
 *
 * Two things about the accessibility here are deliberate.
 *
 * **The logo carries the publication's name as alt text**, taken from the
 * registry rather than from the provider — the registry's name is the one that
 * was checked when the mark was added, and a provider that reports "Harbour
 * Ledger — Food" should not put that in an image's accessible name.
 *
 * **A name drawn in text is not also announced by an image.** The two branches
 * are exclusive: either there is a mark, in which case its alt text is the
 * name, or there is no mark, in which case the name is a text node. There is
 * never a mark with empty alt beside its own name, which is the arrangement
 * that reads correctly and the arrangement most likely to rot into a mark with
 * no alt at all.
 *
 * A story with neither a registered mark nor any publisher name draws no
 * masthead row. The headline and its link still stand — losing the outlet's
 * identity is a real loss, but it is smaller than losing the coverage.
 */
function mastheadMarkup(story: PressWidgetStory, theme: PressWidgetTheme): string {
  const logo = resolvePublisherLogo(story.publisherDomain);

  if (logo) {
    const asset = theme === "dark" ? logo.dark : logo.light;
    return `<div class="masthead"><img class="logo" src="${escapeHtml(
      asset.path,
    )}" width="${asset.width}" height="${asset.height}" alt="${escapeHtml(
      logo.name,
    )}" loading="lazy" decoding="async"></div>`;
  }

  const name = publisherDisplayName(story.publisherName, story.publisherDomain);
  if (name === null) return "";

  return `<div class="masthead"><span class="publisher">${escapeHtml(name)}</span></div>`;
}

function unavailableMarkup(reason: PressWidgetUnavailableReason): string {
  const copy = UNAVAILABLE_COPY[reason];
  return `<p class="empty"><span class="headline-line">${escapeHtml(
    copy.headline,
  )}</span>${escapeHtml(copy.detail)}</p>`;
}
