/**
 * The two website widgets, and the handful of strings that differ between them.
 *
 * Lia publishes two things onto customer websites: one Google review for one
 * location, and one to three news stories for the organization. They are
 * separate products with separate configuration, separate eligibility, and
 * separate renderers — deliberately, because a single renderer over a row full
 * of nullable review-or-press fields is how both of them end up half-wrong.
 *
 * What they genuinely share is the *plumbing*: a public id, a loader script, an
 * iframe, a height message, a snippet, an approved-domain list, and a content
 * policy. Every one of those needs a name that differs per widget and a
 * behaviour that does not, and this table is where those names live so a third
 * copy of "the attribute is `data-lia-…`" cannot appear.
 *
 * Nothing here is a rendering decision. A widget's *appearance* is its own
 * module's business; this is the envelope it travels in.
 */

export interface WidgetKindConfig {
  /**
   * The prefix on the public id.
   *
   * Two characters plus an underscore, and it earns them: a value in a
   * customer's page source, a support ticket, or a server log says which of
   * the two products it belongs to without anybody having to look it up.
   */
  publicIdPrefix: string;
  /** The attribute the loader scans the customer's page for. */
  attribute: string;
  /** Where the loader script lives. Pasted into customer HTML; never fingerprinted. */
  scriptPath: string;
  /** The parent path of one widget's document. The public id is the next segment. */
  framePath: string;
  /**
   * The `source` field on the height message.
   *
   * Distinct per widget so a page carrying both does not have two listeners
   * accepting each other's messages — the loader matches on the frame's own
   * window as well, but a shared name would make that the *only* thing
   * separating them.
   */
  messageSource: string;
  /** The iframe's accessible name on the customer's page. */
  frameTitle: string;
  /**
   * The height the loader gives a frame before the document reports its own.
   *
   * Close enough that the card does not visibly jump when the real
   * measurement arrives a frame later. It differs per widget because a
   * three-story press list is roughly half again as tall as a review card, and
   * one shared number would make one of them jump on every page load.
   */
  initialFrameHeight: number;
}

export const WIDGET_KINDS = {
  review: {
    publicIdPrefix: "rw_",
    attribute: "data-lia-review-widget",
    scriptPath: "/embed/review-widget.js",
    framePath: "/embed/review-widget",
    messageSource: "lia-review-widget",
    frameTitle: "Customer review",
    initialFrameHeight: 220,
  },
  press: {
    publicIdPrefix: "pw_",
    attribute: "data-lia-press-widget",
    scriptPath: "/embed/press-widget.js",
    framePath: "/embed/press-widget",
    messageSource: "lia-press-widget",
    frameTitle: "Recent press coverage",
    initialFrameHeight: 320,
  },
} as const satisfies Record<string, WidgetKindConfig>;

export type WidgetKind = keyof typeof WIDGET_KINDS;

export const WIDGET_KIND_NAMES = Object.keys(WIDGET_KINDS) as WidgetKind[];
