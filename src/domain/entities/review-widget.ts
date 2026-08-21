import { z } from "zod";
import { reviewWidgetLayoutSchema, reviewWidgetSelectionModeSchema, reviewWidgetStatusSchema, reviewWidgetThemeSchema, savableReviewWidgetLayoutSchema } from "@/domain/enums";
import {
  organizationOwnedSchema,
  timestampSchema,
  timestampsSchema,
  uuidSchema,
} from "@/domain/primitives";

/**
 * The website review widget: one Google review, on the customer's own site.
 *
 * The whole feature is an *outbound* surface, which is new for Lia — every
 * other source of truth in this codebase describes something Lia read from
 * somewhere else. That inversion is what most of the shape below is arranged
 * around:
 *
 * 1. **A widget is configuration, not content.** It holds no review text. It
 *    names a location and a selection rule, and the review is resolved at
 *    render time from `mentions`. A copy of the review here would go stale the
 *    moment the reviewer edited it at the source, and Lia would be publishing
 *    words on a customer's homepage that Google no longer shows.
 *
 * 2. **`publicId` is an identifier, not a secret.** It is pasted into page
 *    HTML by design, so treating it as a bearer token would be theatre. It is
 *    random rather than sequential for one narrow reason — so nobody can walk
 *    the range and enumerate which restaurants use Lia — and rotating it is
 *    offered because a customer who wants an old embed to stop working has no
 *    other lever. See `src/lib/widgets/public-id.ts`.
 *
 * 3. **`layout` renders at three values and stores at one.** The photo- and
 *    video-led layouts are built — `renderReviewWidgetDocument` draws all
 *    three — but Google's review API returns no photographs and no video, so
 *    there is nothing to fill them with on a real website. Until media has a
 *    source, `saveReviewWidgetInput` accepts only `single_review_text`, which
 *    is exactly what the column's check constraint accepts. See
 *    `SAVABLE_REVIEW_WIDGET_LAYOUTS`.
 */

/* -------------------------------------------------------------------------- */
/* The stored configuration                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The lowest average star rating an automatically selected review may carry.
 *
 * Not in the product brief, and added deliberately. "Most recent eligible
 * review" with no floor puts whatever arrived last on a customer's homepage,
 * and the review that arrives last is as likely to be one star as five. Every
 * competing product in this category has a threshold; a customer discovering
 * the omission by finding a complaint on their own landing page is not a
 * recoverable first impression.
 *
 * Four is the default rather than five because five-only is how a widget goes
 * blank for a month at a well-run restaurant with a couple of fours.
 */
export const DEFAULT_MINIMUM_RATING = 4;

/** Ratings are whole and half stars; anything else is not a rating Google gives. */
export const minimumRatingSchema = z
  .number()
  .min(1)
  .max(5)
  .refine((value) => Number.isInteger(value * 2), {
    message: "Use whole or half stars",
  });

/**
 * One approved website host.
 *
 * Stored as a bare hostname, lowercased, optionally with a single leading
 * `*.` wildcard label — the exact vocabulary a CSP `frame-ancestors` source
 * can express, because that directive is what actually enforces this. Storing
 * a full URL would invite a path or a query nobody can enforce; storing a
 * regular expression would invite one nobody can read.
 */
export const widgetDomainSchema = z
  .string()
  .min(3)
  .max(253)
  .regex(
    /^(\*\.)?(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/,
    "Use a hostname such as example.com or *.example.com",
  );

/** At most this many approved domains. A list nobody can audit is not a control. */
export const MAX_WIDGET_DOMAINS = 20;

export const reviewWidgetSchema = z
  .object({
    /** Exactly one location. A widget shows one restaurant's review, or none. */
    locationId: uuidSchema,
    /** The identifier in the customer's page. Public by design. */
    publicId: z.string().min(8).max(64),
    status: reviewWidgetStatusSchema,
    layout: reviewWidgetLayoutSchema,
    theme: reviewWidgetThemeSchema,
    selectionMode: reviewWidgetSelectionModeSchema,
    /**
     * The pinned review, when `selectionMode` is `specific`.
     *
     * Nullable even then, and that is the point rather than a gap: the column
     * is `on delete set null`, so a pinned review that is deleted leaves the
     * widget pinned to nothing. The renderer answers that with an unavailable
     * state. Falling back to "the most recent one instead" would silently put
     * a different customer's words on the page — which is exactly the failure
     * the product brief names.
     */
    selectedMentionId: uuidSchema.nullable(),
    minimumRating: minimumRatingSchema,
    /** Empty means unrestricted. See `src/lib/widgets/domains.ts`. */
    allowedDomains: z.array(widgetDomainSchema).max(MAX_WIDGET_DOMAINS),
    /**
     * Whether the customer's plan has bought the attribution line away.
     *
     * Nothing writes this today and `resolveWidgetAttribution()` is the only
     * reader — Lia has no billing model, so there is no plan for it to be true
     * on. It exists for the same reason `monitoring_queries.postal_code` does:
     * the column is cheap now and the migration is not, and the alternative is
     * a boolean invented under time pressure on the day plans ship.
     */
    attributionSuppressed: z.boolean(),
    /** When the embed identifier was last rotated. Null means never. */
    publicIdRotatedAt: timestampSchema.nullable(),
    /** Who set it up. Nulled on offboarding; the audit trail is the record. */
    createdByUserId: uuidSchema.nullable(),
  })
  .extend(organizationOwnedSchema.shape)
  .extend(timestampsSchema.shape);

export type ReviewWidget = z.infer<typeof reviewWidgetSchema>;

/* -------------------------------------------------------------------------- */
/* Writes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What a person may set.
 *
 * `publicId`, `status`, and `attributionSuppressed` are absent on purpose.
 * The first is issued by the service and only ever changed by an explicit
 * rotation; the second by explicit enable/disable, because "your widget went
 * dark" should never be a side effect of saving a theme; the third by a plan
 * gate that does not exist yet. Keeping them out of the type is what makes
 * that structural rather than a rule a call site has to remember.
 */
export const saveReviewWidgetInputSchema = z
  .object({
    locationId: uuidSchema,
    theme: reviewWidgetThemeSchema,
    /**
     * Narrower than the renderer's vocabulary, on purpose.
     *
     * `savableReviewWidgetLayoutSchema` mirrors the check constraint on
     * `review_widgets.layout`, so a photo or video layout is refused here —
     * with a field error under the control that sent it — rather than by
     * Postgres under a save button. The renderer accepts all three because the
     * preview surfaces draw all three from sample content; the database
     * accepts one because only one can be filled with a customer's own data.
     */
    layout: savableReviewWidgetLayoutSchema.default("single_review_text"),
    selectionMode: reviewWidgetSelectionModeSchema,
    selectedMentionId: uuidSchema.nullable().default(null),
    minimumRating: minimumRatingSchema.default(DEFAULT_MINIMUM_RATING),
    /**
     * Raw, as typed. **Not** `widgetDomainSchema`.
     *
     * People paste `https://example.com/` and `EXAMPLE.COM` and mean the same
     * site, and `normalizeWidgetDomains` in `src/lib/widgets/domains.ts` is
     * what turns those into something a `frame-ancestors` source can express.
     * Validating strictly here would reject the save before the normaliser
     * ever ran, and the person would be told their own domain was malformed.
     *
     * The stored shape is strict — see `reviewWidgetSchema.allowedDomains` —
     * so nothing unenforceable reaches the database. This bound is only a
     * ceiling on how much text one save may carry; the normaliser applies the
     * real `MAX_WIDGET_DOMAINS` cap and reports what it dropped.
     */
    allowedDomains: z
      .array(z.string().max(300))
      .max(MAX_WIDGET_DOMAINS * 5)
      .default([]),
  })
  .refine(
    (input) => input.selectionMode !== "specific" || input.selectedMentionId !== null,
    {
      message: "Choose which review to show",
      path: ["selectedMentionId"],
    },
  );

export type SaveReviewWidgetInput = z.infer<typeof saveReviewWidgetInputSchema>;

/**
 * The shape the repository writes.
 *
 * Distinct from `SaveReviewWidgetInput` because the service resolves the
 * `publicId` before the write — on a create it issues one, on an update it
 * carries the existing one forward — and an input type that carried it would
 * let a caller choose somebody else's.
 */
export interface UpsertReviewWidgetInput
  extends Omit<SaveReviewWidgetInput, "allowedDomains"> {
  publicId: string;
  createdByUserId: string | null;
  /**
   * Normalised, not raw.
   *
   * `SaveReviewWidgetInput` carries what a person typed; this carries what
   * `normalizeWidgetDomains` made of it. Narrowing the field here rather than
   * inheriting it is what keeps an adapter from being handed
   * `https://Example.com/` and writing it to a column whose whole purpose is
   * to be interpolated into a CSP directive.
   */
  allowedDomains: string[];
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Why a widget is not showing a review.
 *
 * Each one is a different sentence to a person looking at their own website,
 * and collapsing them into "unavailable" would make the most common support
 * question — "why is my widget empty" — unanswerable from the page itself.
 */
export const REVIEW_WIDGET_UNAVAILABLE_REASONS = [
  /** No widget carries this public id. A revoked or mistyped snippet. */
  "unknown_widget",
  /** The widget exists and its owner switched it off. */
  "disabled",
  /** Selection is `specific` and the pinned review is gone or no longer eligible. */
  "selected_review_unavailable",
  /** Selection is `most_recent` and nothing at this location qualifies. */
  "no_eligible_review",
] as const;

export const reviewWidgetUnavailableReasonSchema = z.enum(
  REVIEW_WIDGET_UNAVAILABLE_REASONS,
);
export type ReviewWidgetUnavailableReason = z.infer<
  typeof reviewWidgetUnavailableReasonSchema
>;

/**
 * One image the widget draws, and what a screen reader is told about it.
 *
 * `alt` is required rather than optional because there is no such thing as a
 * decorative photograph in this card — the whole argument for a photo layout
 * is that the picture carries meaning the words do not. A caller with nothing
 * useful to say has to write an empty string and mean it.
 *
 * `src` is deliberately just a string. It is a data URI for the sample cards
 * and would be a Lia-hosted URL for a customer's own upload; what it must
 * never be is a third-party origin, and that is enforced where it matters — by
 * the `img-src` directive on the embed response, not by a type.
 */
export const widgetImageSchema = z.object({
  src: z.string().min(1),
  alt: z.string(),
});

export type WidgetImage = z.infer<typeof widgetImageSchema>;

/** At most this many photographs in a photo-led card. */
export const MAX_WIDGET_PHOTOS = 3;

/**
 * What a media-led layout draws, or null on the text layout.
 *
 * A discriminated union rather than two nullable fields, because "a photo card
 * with a video in it" and "a video card with three photographs and no poster"
 * are states that should not be expressible. The renderer switches on `kind`
 * and the type checker guarantees the arm it lands in has what it needs.
 *
 * **Nothing populates this from Google.** Both arms exist to be filled by
 * `@/lib/widgets/sample` today and by a customer's own upload if that ships;
 * `resolveRenderedWidget` treats absent media as "draw the text layout"
 * rather than as an error, so no widget can ever render an empty picture
 * frame on somebody's homepage.
 */
export const reviewWidgetMediaSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("photo"),
    photos: z.array(widgetImageSchema).min(1).max(MAX_WIDGET_PHOTOS),
  }),
  z.object({
    kind: z.literal("video"),
    /**
     * The still the card shows before anything plays.
     *
     * Required, and the video source is not. A poster with no video is a
     * legible card; a video with no poster is a black rectangle until the
     * first frame decodes, on a page the customer does not control.
     */
    poster: widgetImageSchema,
    /**
     * The video itself, or null for a poster-only card.
     *
     * Null is what the sample uses: a self-contained document cannot carry a
     * video the way it carries an inline SVG, and shipping a fabricated clip
     * to make a preview look complete is the same mistake as shipping a
     * fabricated review. The play badge renders either way; with null it is
     * drawn as the still it is, and the surface around it says so.
     */
    src: z.string().min(1).nullable(),
    /** How long the clip runs, spoken as "1:12". Null when unknown. */
    durationLabel: z.string().min(1).max(12).nullable(),
  }),
]);

export type ReviewWidgetMedia = z.infer<typeof reviewWidgetMediaSchema>;

/**
 * The review, reduced to what the widget puts on a stranger's screen.
 *
 * Deliberately not a `Mention`. A mention carries sentiment, risk level,
 * escalation state, an internal status, and the raw provider payload — none of
 * which belongs on a public page, and all of which would be one careless
 * `JSON.stringify` away from being there. This type is the boundary: what is
 * not on it cannot leak, whatever the renderer does.
 */
export const reviewWidgetReviewSchema = z.object({
  rating: z.number().min(0).max(5),
  text: z.string().min(1),
  authorName: z.string().min(1),
  /** Rendered in the avatar disc. Derived, never a photo — this version has none. */
  authorInitials: z.string().min(1).max(2),
  publishedAt: timestampSchema,
  /**
   * Where "Read on Google" points, or null.
   *
   * Google returns no per-review permalink (see
   * `src/integrations/google-business-profile/reviews.ts`), so this is the
   * location's own Google profile when Lia holds a trusted one. A fabricated
   * deep link that 404s would be worse than no link, which is why the control
   * disappears rather than degrading.
   */
  readOnGoogleUrl: z.url().nullable(),
  /**
   * Photographs or a video to draw alongside the words, or null.
   *
   * Null on the text layout, and also on a media layout that resolved no media
   * — `resolveRenderedWidget` degrades the layout to match rather than leaving
   * a card describing a picture it does not have.
   */
  media: reviewWidgetMediaSchema.nullable(),
});

export type ReviewWidgetReview = z.infer<typeof reviewWidgetReviewSchema>;

/** What the public renderer was asked to draw. */
export type RenderedReviewWidget =
  | {
      state: "ready";
      theme: z.infer<typeof reviewWidgetThemeSchema>;
      layout: z.infer<typeof reviewWidgetLayoutSchema>;
      showAttribution: boolean;
      allowedDomains: string[];
      review: ReviewWidgetReview;
    }
  | {
      state: "unavailable";
      reason: ReviewWidgetUnavailableReason;
      theme: z.infer<typeof reviewWidgetThemeSchema>;
      layout: z.infer<typeof reviewWidgetLayoutSchema>;
      showAttribution: boolean;
      allowedDomains: string[];
    };

/**
 * The row the public render path reads, before any presentation decision.
 *
 * One flat shape rather than a widget plus a mention plus a profile, because
 * under Supabase it arrives as exactly one row from one `SECURITY DEFINER`
 * function and the adapter must not be able to widen it. Every field here is
 * either widget configuration or one of the six review fields the widget
 * displays.
 */
export interface ReviewWidgetRenderRow {
  theme: z.infer<typeof reviewWidgetThemeSchema>;
  layout: z.infer<typeof reviewWidgetLayoutSchema>;
  status: z.infer<typeof reviewWidgetStatusSchema>;
  attributionSuppressed: boolean;
  allowedDomains: string[];
  selectionMode: z.infer<typeof reviewWidgetSelectionModeSchema>;
  /** Null when nothing eligible resolved. The reason is derived, not stored. */
  reviewRating: number | null;
  reviewText: string | null;
  reviewAuthorName: string | null;
  reviewPublishedAt: string | null;
  /** The location's Google profile URL, untrusted until validated. */
  profileUrl: string | null;
  /**
   * Media for a photo- or video-led layout, or null.
   *
   * Not a column, and not from Google. Both Supabase and the demo adapter
   * return null here, because neither has anywhere to read it from: the
   * Business Profile API carries no per-review media. `@/lib/widgets/sample`
   * is the only producer today, which is why the two media layouts appear in
   * Lia's own preview surfaces and nowhere else.
   */
  media: ReviewWidgetMedia | null;
}
