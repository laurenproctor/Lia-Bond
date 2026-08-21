import type {
  ReviewWidgetLayout,
  ReviewWidgetMedia,
  ReviewWidgetRenderRow,
  ReviewWidgetTheme,
} from "@/domain";

/**
 * The example widget shown to somebody who has no location yet, in each of the
 * three layouts.
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
 *
 * **The media is fiction twice over,** and that is the more delicate half.
 * Google's review API returns no photographs and no video (see
 * `googleReviewSchema`), so the two media layouts have no real content
 * anywhere in Lia and are drawn from the illustrations below. They are
 * illustrations rather than photographs on purpose: a stock photograph of a
 * dining room in a preview headed "your widget" is a picture somebody could
 * believe came from their own listing, and no caption reliably undoes that. A
 * flat drawing cannot be mistaken for a place.
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
 * Shorter, because a media card has less room for words before it becomes tall.
 *
 * Kept just as generic, and written so the pictures below it have something to
 * be pictures *of* — a review that mentions the room reads oddly beside a
 * drawing of a plate.
 */
const SAMPLE_TEXT_PHOTO =
  "The room is even better than it looks online, and the tasting plates kept arriving " +
  "long after we thought we were finished.";

const SAMPLE_TEXT_VIDEO =
  "Filmed the moment they brought the cake out. Twenty seconds that our family will " +
  "still be sending each other in a decade.";

/**
 * Google Maps itself, not an invented listing.
 *
 * The footer row is part of what the widget looks like, so the teaser draws
 * it — and the destination has to be a real Google URL that
 * `normalizeGoogleUrl` accepts. A fabricated `?cid=` would be a link to a
 * business that does not exist, which is worse than no link at all.
 */
const SAMPLE_PROFILE_URL = "https://www.google.com/maps";

/* -------------------------------------------------------------------------- */
/* The illustrations                                                           */
/* -------------------------------------------------------------------------- */

/**
 * An SVG turned into something an `<img src>` can hold.
 *
 * A data URI rather than a file under `public/`, so the sample cards keep the
 * property the real widget document is built around: no network request of any
 * kind after the document itself. A preview that fetched two images would be a
 * preview whose loading behaviour differed from the thing it previews, and the
 * frame's height would settle twice.
 *
 * `encodeURIComponent` rather than base64 — an SVG of this size survives it at
 * roughly half the bytes, and the result stays readable in a page source,
 * which matters for the one thing anybody ever does with these: work out where
 * the picture in the preview came from.
 */
function illustration(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg.replace(/\s+/g, " ").trim())}`;
}

/**
 * A warm, plainly-drawn scene at a fixed ratio.
 *
 * Every one of these is the same handful of shapes in a different arrangement.
 * They are not trying to be beautiful; they are trying to be obviously not a
 * photograph while still occupying the space a photograph would, so the layout
 * being previewed is the thing under examination rather than the picture.
 */
function scene(width: number, height: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="presentation">
<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
<stop offset="0" stop-color="#f6ead6"/><stop offset="1" stop-color="#e4cfae"/>
</linearGradient></defs>
<rect width="${width}" height="${height}" fill="url(#g)"/>
${body}
</svg>`;
}

/** The room: arches, a rail of lights, a floor. */
const SAMPLE_PHOTO_ROOM = illustration(
  scene(
    800,
    500,
    `<rect y="360" width="800" height="140" fill="#c9a877" opacity="0.55"/>
     <path d="M150 360V230a90 90 0 0 1 180 0v130z" fill="#b98f5c" opacity="0.5"/>
     <path d="M470 360V250a80 80 0 0 1 160 0v110z" fill="#b98f5c" opacity="0.4"/>
     <g fill="#8c6234" opacity="0.55">
       <circle cx="240" cy="120" r="16"/><circle cx="400" cy="96" r="12"/><circle cx="560" cy="126" r="14"/>
     </g>
     <rect x="120" y="96" width="560" height="3" fill="#8c6234" opacity="0.35"/>`,
  ),
);

/** The table: two plates, a glass, a shadow. */
const SAMPLE_PHOTO_TABLE = illustration(
  scene(
    800,
    500,
    `<ellipse cx="300" cy="300" rx="170" ry="120" fill="#fffaf0" opacity="0.85"/>
     <ellipse cx="300" cy="300" rx="110" ry="76" fill="#d9a441" opacity="0.55"/>
     <ellipse cx="600" cy="360" rx="110" ry="78" fill="#fffaf0" opacity="0.7"/>
     <rect x="560" y="120" width="70" height="150" rx="12" fill="#f7efe0" opacity="0.8"/>
     <rect x="560" y="196" width="70" height="74" rx="10" fill="#a8452f" opacity="0.5"/>`,
  ),
);

/** The plate, close: a ring and three pieces. */
const SAMPLE_PHOTO_PLATE = illustration(
  scene(
    800,
    500,
    `<circle cx="400" cy="250" r="200" fill="#fffaf0" opacity="0.9"/>
     <circle cx="400" cy="250" r="150" fill="none" stroke="#c9a877" stroke-width="6" opacity="0.6"/>
     <g fill="#8c4a2f" opacity="0.65">
       <rect x="300" y="200" width="120" height="60" rx="18"/>
       <rect x="380" y="270" width="130" height="52" rx="16"/>
     </g>
     <circle cx="330" cy="300" r="26" fill="#6f8f4a" opacity="0.6"/>`,
  ),
);

/** The video still: the same room, wider, with the lights lit. */
const SAMPLE_VIDEO_POSTER = illustration(
  scene(
    960,
    540,
    `<rect y="380" width="960" height="160" fill="#c9a877" opacity="0.5"/>
     <path d="M200 380V240a100 100 0 0 1 200 0v140z" fill="#b98f5c" opacity="0.45"/>
     <path d="M560 380V266a86 86 0 0 1 172 0v114z" fill="#b98f5c" opacity="0.35"/>
     <g fill="#f0c765" opacity="0.85">
       <circle cx="300" cy="140" r="20"/><circle cx="480" cy="112" r="15"/><circle cx="660" cy="146" r="17"/>
     </g>
     <rect x="160" y="112" width="640" height="3" fill="#8c6234" opacity="0.3"/>`,
  ),
);

/**
 * What a screen reader is told, and it is told the truth.
 *
 * Not "a photograph of the dining room" — that would describe a photograph
 * that does not exist to the one reader who cannot see that it is a drawing.
 * The alt text says what the picture is *for*, which is the same thing the
 * sighted reader learns from the fact that it is obviously a drawing.
 */
const PHOTO_ALT = "Illustration standing in for a photograph on a guest's review";
const VIDEO_ALT = "Illustration standing in for the opening frame of a guest's video";

const SAMPLE_MEDIA: Record<
  Exclude<ReviewWidgetLayout, "single_review_text">,
  ReviewWidgetMedia
> = {
  single_review_photo: {
    kind: "photo",
    // Three, because three is the arrangement that has to be got right. One is
    // a banner and two are a pair; three is where the grid, the gaps and the
    // narrow-column stacking all have to hold at once.
    photos: [
      { src: SAMPLE_PHOTO_ROOM, alt: PHOTO_ALT },
      { src: SAMPLE_PHOTO_TABLE, alt: PHOTO_ALT },
      { src: SAMPLE_PHOTO_PLATE, alt: PHOTO_ALT },
    ],
  },
  single_review_video: {
    kind: "video",
    poster: { src: SAMPLE_VIDEO_POSTER, alt: VIDEO_ALT },
    /**
     * No clip, deliberately.
     *
     * Shipping a fabricated twenty seconds of somebody's birthday to make a
     * preview feel finished is the same error as shipping a fabricated review,
     * and a real clip would also be the one asset in this document that could
     * not be inlined. So the video layout previews as its own first frame —
     * which is what a visitor sees before they press play in any case — and
     * the surfaces that draw it say the clip is not part of the example.
     */
    src: null,
    durationLabel: "0:24",
  },
};

const SAMPLE_TEXT_BY_LAYOUT: Record<ReviewWidgetLayout, string> = {
  single_review_text: SAMPLE_TEXT,
  single_review_photo: SAMPLE_TEXT_PHOTO,
  single_review_video: SAMPLE_TEXT_VIDEO,
};

export function sampleReviewWidgetRow(
  theme: ReviewWidgetTheme,
  layout: ReviewWidgetLayout,
  now: number,
): ReviewWidgetRenderRow {
  return {
    theme,
    layout,
    status: "active",
    attributionSuppressed: false,
    // Framed by Lia's own screens only; the route pins `frame-ancestors` to
    // `'self'` regardless of what this list says.
    allowedDomains: [],
    selectionMode: "most_recent",
    reviewRating: 5,
    reviewText: SAMPLE_TEXT_BY_LAYOUT[layout],
    reviewAuthorName: "Danielle W.",
    reviewPublishedAt: new Date(now - SAMPLE_AGE_MS).toISOString(),
    profileUrl: SAMPLE_PROFILE_URL,
    media: layout === "single_review_text" ? null : SAMPLE_MEDIA[layout],
  };
}
