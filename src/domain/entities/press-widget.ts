import { z } from "zod";
import {
  pressWidgetLayoutSchema,
  pressWidgetStatusSchema,
  pressWidgetThemeSchema,
} from "@/domain/enums";
import {
  organizationOwnedSchema,
  timestampSchema,
  timestampsSchema,
  uuidSchema,
} from "@/domain/primitives";
import { MAX_WIDGET_DOMAINS, widgetDomainSchema } from "@/domain/entities/review-widget";

/**
 * The website press widget: the organization's latest earned media, on its own
 * site.
 *
 * The second thing Lia publishes rather than reads, and a deliberately
 * separate table from `review_widgets` rather than a mode of it. The two look
 * alike from the outside — a public id, a theme, an approved-domain list, a
 * snippet — and are different products underneath:
 *
 * 1. **Scope.** A review widget names a location; a press widget names an
 *    organization. Coverage arrives bound to a monitoring query, not to a
 *    restaurant, and a query may itself be organization-wide. Adding a
 *    location selector here would invent a filter the data cannot honour.
 *
 * 2. **Cardinality.** A review widget shows one review. A press widget shows
 *    one to three stories, because a single headline reads as an anecdote and
 *    a wall of them reads as a press page rather than as proof.
 *
 * 3. **Selection.** There is no pinning. Automatic, newest-first, always —
 *    see the note on `monitoringQueryId`. A pinned story is the feature that
 *    turns a "recent press" widget into a stale one, and it is not built.
 *
 * What both share is the envelope: `src/lib/widgets/kinds.ts`,
 * `domains.ts`, `csp.ts`, `html.ts`, `public-id.ts`, `snippet.ts`, and
 * `loader.ts` are source-neutral and shared verbatim. Everything that decides
 * *what appears* is separate, in `src/lib/widgets/press/`.
 */

/* -------------------------------------------------------------------------- */
/* The stored configuration                                                    */
/* -------------------------------------------------------------------------- */

/**
 * How many stories a press widget may show.
 *
 * One to three, and three is the default. The ceiling is a product decision
 * rather than a technical one: past three, a "recent press" strip stops being
 * proof on a homepage and starts being a press page that belongs on its own
 * route, maintained by somebody. The floor is one because a restaurant with a
 * single good piece of coverage should be able to show it.
 */
export const MIN_PRESS_WIDGET_ITEMS = 1;
export const MAX_PRESS_WIDGET_ITEMS = 3;
export const DEFAULT_PRESS_WIDGET_ITEMS = 3;

export const pressWidgetItemLimitSchema = z
  .number()
  .int()
  .min(MIN_PRESS_WIDGET_ITEMS)
  .max(MAX_PRESS_WIDGET_ITEMS);

export const pressWidgetSchema = z
  .object({
    /** The identifier in the customer's page. Public by design. */
    publicId: z.string().min(8).max(64),
    status: pressWidgetStatusSchema,
    layout: pressWidgetLayoutSchema,
    theme: pressWidgetThemeSchema,
    /**
     * Which coverage the widget draws from, or null for all of it.
     *
     * Null means every eligible news article in the organization. A value
     * narrows the widget to one monitoring query — which may itself be
     * organization-wide or scoped to a location, and *that* is how a
     * per-restaurant press widget is expressed. There is deliberately no
     * separate location column: a story's attribution to a restaurant is a
     * property of the query that found it, and a second, independent location
     * filter would silently disagree with the first.
     *
     * `on delete set null` in the schema, so deleting a monitoring query
     * widens the widget to all press rather than emptying it. That is the less
     * surprising of the two failures: a customer who deletes a query has
     * decided they no longer want that watch, not that their homepage should
     * go blank.
     */
    monitoringQueryId: uuidSchema.nullable(),
    itemLimit: pressWidgetItemLimitSchema,
    /** Empty means unrestricted. Shared with the review widget; see `domains.ts`. */
    allowedDomains: z.array(widgetDomainSchema).max(MAX_WIDGET_DOMAINS),
    /**
     * Whether the customer's plan has bought the attribution line away.
     *
     * Nothing writes this and `resolveWidgetAttribution()` is the only reader,
     * exactly as on `review_widgets`. Lia has no billing model, so there is no
     * plan for it to be true on; the column is the seam a plan gate lands on.
     */
    attributionSuppressed: z.boolean(),
    /** When the embed identifier was last rotated. Null means never. */
    publicIdRotatedAt: timestampSchema.nullable(),
    /** Who set it up. Nulled on offboarding; the audit trail is the record. */
    createdByUserId: uuidSchema.nullable(),
  })
  .extend(organizationOwnedSchema.shape)
  .extend(timestampsSchema.shape);

export type PressWidget = z.infer<typeof pressWidgetSchema>;

/* -------------------------------------------------------------------------- */
/* Writes                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What a person may set.
 *
 * `publicId`, `status`, and `attributionSuppressed` are absent on purpose, for
 * the reasons `saveReviewWidgetInputSchema` records: the first is issued by
 * the service and only ever changed by an explicit rotation; the second by
 * explicit enable/disable, because "your widget went dark" must never be a
 * side effect of saving a theme; the third by a plan gate that does not exist.
 */
export const savePressWidgetInputSchema = z.object({
  theme: pressWidgetThemeSchema,
  layout: pressWidgetLayoutSchema.default("recent_press_list"),
  monitoringQueryId: uuidSchema.nullable().default(null),
  itemLimit: pressWidgetItemLimitSchema.default(DEFAULT_PRESS_WIDGET_ITEMS),
  /**
   * Raw, as typed. **Not** `widgetDomainSchema`.
   *
   * The same bound and the same reasoning as the review widget's: people paste
   * `https://example.com/` and `EXAMPLE.COM` and mean the same site, and
   * `normalizeWidgetDomains` is what turns those into something a
   * `frame-ancestors` source can express. The stored shape is strict, so
   * nothing unenforceable reaches the database.
   */
  allowedDomains: z
    .array(z.string().max(300))
    .max(MAX_WIDGET_DOMAINS * 5)
    .default([]),
});

export type SavePressWidgetInput = z.infer<typeof savePressWidgetInputSchema>;

/**
 * The shape the repository writes.
 *
 * Distinct from `SavePressWidgetInput` because the service resolves the
 * `publicId` before the write — on a create it issues one, on an update it
 * carries the existing one forward — and an input type that carried it would
 * let a caller choose somebody else's.
 */
export interface UpsertPressWidgetInput
  extends Omit<SavePressWidgetInput, "allowedDomains"> {
  publicId: string;
  createdByUserId: string | null;
  /** Normalised, not raw. See `UpsertReviewWidgetInput` for why this narrows. */
  allowedDomains: string[];
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Why a press widget is not showing any coverage.
 *
 * Three rather than the review widget's four: there is no pinning here, so
 * `selected_review_unavailable` has no press equivalent. Each remaining one is
 * a different sentence to a person looking at their own website.
 */
export const PRESS_WIDGET_UNAVAILABLE_REASONS = [
  /** No widget carries this public id. A revoked or mistyped snippet. */
  "unknown_widget",
  /** The widget exists and its owner switched it off. */
  "disabled",
  /** Nothing in the selected coverage qualifies yet. */
  "no_eligible_press",
] as const;

export const pressWidgetUnavailableReasonSchema = z.enum(
  PRESS_WIDGET_UNAVAILABLE_REASONS,
);
export type PressWidgetUnavailableReason = z.infer<
  typeof pressWidgetUnavailableReasonSchema
>;

/**
 * One story, reduced to what the widget puts on a stranger's screen.
 *
 * Deliberately not a `Mention`. A mention carries sentiment, risk level,
 * relevance and engagement scores, an internal status, the monitoring query
 * that found it, and the raw provider payload — none of which belongs on a
 * public page, and all of which would be one careless spread away from being
 * there. This type is the boundary: what is not on it cannot leak, whatever
 * the renderer does.
 *
 * Note what is here and what is *not*. `publisherDomain` is here; a logo URL
 * is not. The anonymous resolver returns a normalised domain and the renderer
 * resolves it against a local registry — so a value that reached Lia from a
 * provider can never choose which file a visitor's browser fetches. See
 * `src/lib/widgets/press/publisher-logos.ts`.
 */
export const pressWidgetStorySchema = z.object({
  headline: z.string().min(1),
  /** The provider's short description, when it gave one. */
  excerpt: z.string().nullable(),
  /** The outlet's name as the source reported it. Rendered as text. */
  publisherName: z.string().nullable(),
  /** Normalised, lowercased, bare host. The *only* input to logo resolution. */
  publisherDomain: z.string().nullable(),
  /** Validated as HTTP(S) at the rendering boundary before it becomes an anchor. */
  sourceUrl: z.url(),
  publishedAt: timestampSchema,
});

export type PressWidgetStory = z.infer<typeof pressWidgetStorySchema>;

/** What the public renderer was asked to draw. */
export type RenderedPressWidget =
  | {
      state: "ready";
      theme: z.infer<typeof pressWidgetThemeSchema>;
      layout: z.infer<typeof pressWidgetLayoutSchema>;
      showAttribution: boolean;
      allowedDomains: string[];
      /** At least one, at most three. Newest first. */
      stories: PressWidgetStory[];
    }
  | {
      state: "unavailable";
      reason: PressWidgetUnavailableReason;
      theme: z.infer<typeof pressWidgetThemeSchema>;
      layout: z.infer<typeof pressWidgetLayoutSchema>;
      showAttribution: boolean;
      allowedDomains: string[];
    };

/**
 * One story as the anonymous resolver returns it, before any presentation
 * decision.
 *
 * Every field is untrusted here and trusted nowhere: `sourceUrl` is a string
 * rather than `z.url()` because the resolver's job is to report what the row
 * held, and validating it is the renderer's job at the boundary where it
 * becomes an anchor. A story whose URL fails that check is dropped rather than
 * linked.
 */
export interface PressWidgetStoryRow {
  headline: string | null;
  excerpt: string | null;
  publisherName: string | null;
  publisherDomain: string | null;
  sourceUrl: string | null;
  publishedAt: string | null;
}

/**
 * The row the public render path reads.
 *
 * One flat shape rather than a widget plus a list of mentions, because under
 * Supabase it arrives as exactly one row from one `SECURITY DEFINER` function
 * and the adapter must not be able to widen it. Every field here is either
 * widget configuration or one of the six story fields the widget displays.
 *
 * `stories` is already capped at the widget's `item_limit` by the resolver —
 * the array is what the widget draws, not a page of candidates to filter.
 */
export interface PressWidgetRenderRow {
  theme: z.infer<typeof pressWidgetThemeSchema>;
  layout: z.infer<typeof pressWidgetLayoutSchema>;
  status: z.infer<typeof pressWidgetStatusSchema>;
  attributionSuppressed: boolean;
  allowedDomains: string[];
  stories: PressWidgetStoryRow[];
}
