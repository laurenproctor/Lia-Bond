import { z } from "zod";
import { reviewWidgetLayoutSchema, reviewWidgetSelectionModeSchema, reviewWidgetStatusSchema, reviewWidgetThemeSchema } from "@/domain/enums";
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
 * 3. **`layout` exists at one value.** Photo- and video-led layouts are named
 *    in the product brief and deliberately not built. A column that can only
 *    ever hold one value is the seam that lets the second one arrive without a
 *    migration to the widget's identity, and `single_review_text` says what
 *    this version actually is rather than pretending to be generic.
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
    layout: reviewWidgetLayoutSchema.default("single_review_text"),
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
}
