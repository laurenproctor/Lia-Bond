import type { ReviewWidgetRenderRow, ReviewWidgetTheme } from "@/domain";

/**
 * The example widget shown to somebody who has no location yet.
 *
 * A person who has just signed up cannot be shown their own review, because
 * there is not one — and the screen that says so is the screen where they
 * decide whether this feature is worth connecting a Google account for. So
 * they are shown the thing itself, filled with an invented review, rather than
 * a sentence describing it.
 *
 * It is a `ReviewWidgetRenderRow` rather than markup for the same reason the
 * in-app preview is one: the teaser then travels the identical path the public
 * embed does — `resolveRenderedWidget` → `renderReviewWidgetDocument` — and so
 * cannot promise a card that differs from the one a customer's website will
 * get. A hand-built React imitation would look right on the day it was written
 * and would drift the first time a padding changed on one side and not the
 * other.
 *
 * **The review is fiction, and the surface that renders it says so.** The
 * teaser labels it as an example, because a fabricated review mistaken for a
 * real one — even for a second, even inside the customer's own admin screen —
 * is exactly the trust the rest of this feature is built to protect. Nothing
 * here is ever served under a public id: the sample branch of
 * `/embed/review-widget/preview` is the only caller, and that route is framed
 * by Lia's own pages only.
 */

/** Twelve days reads as "1 week ago", which is what a live widget usually shows. */
const SAMPLE_AGE_MS = 12 * 24 * 60 * 60 * 1000;

/**
 * Deliberately about a party booking rather than a dish.
 *
 * Plainly generic — no cuisine, no city, no restaurant name — so that nobody
 * reads it as a review of *their* business, and long enough to show how the
 * card handles a real paragraph rather than a one-line rave.
 */
const SAMPLE_TEXT =
  "We booked the back room for twelve people and they made the whole thing feel easy. " +
  "The short rib was what everyone talked about on the way out, and our server checked in " +
  "exactly the right number of times.";

/**
 * Google Maps itself, not an invented listing.
 *
 * The footer row is part of what the widget looks like, so the teaser draws
 * it — and the destination has to be a real Google URL that
 * `normalizeGoogleUrl` accepts. A fabricated `?cid=` would be a link to a
 * business that does not exist, which is worse than no link at all.
 */
const SAMPLE_PROFILE_URL = "https://www.google.com/maps";

export function sampleReviewWidgetRow(
  theme: ReviewWidgetTheme,
  now: number,
): ReviewWidgetRenderRow {
  return {
    theme,
    layout: "single_review_text",
    status: "active",
    attributionSuppressed: false,
    // Framed by Lia's own screens only; the route pins `frame-ancestors` to
    // `'self'` regardless of what this list says.
    allowedDomains: [],
    selectionMode: "most_recent",
    reviewRating: 5,
    reviewText: SAMPLE_TEXT,
    reviewAuthorName: "Danielle W.",
    reviewPublishedAt: new Date(now - SAMPLE_AGE_MS).toISOString(),
    profileUrl: SAMPLE_PROFILE_URL,
  };
}
