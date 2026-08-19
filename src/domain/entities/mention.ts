import { z } from "zod";
import {
  escalationCategorySchema,
  MENTION_SOURCE_TYPES,
  mentionCaptureMethodSchema,
  mentionSourceTypeSchema,
  mentionStatusSchema,
  platformSchema,
  PLATFORMS,
  recommendedActionSchema,
  riskLevelSchema,
  sentimentSchema,
} from "@/domain/enums";
import {
  jsonObjectSchema,
  languageTagSchema,
  organizationOwnedSchema,
  timestampSchema,
  timestampsSchema,
  unitScoreSchema,
  uuidSchema,
} from "@/domain/primitives";

/**
 * The universal mention.
 *
 * Every external source — a Google review, a Reddit thread, a news article, a
 * comment under that article — normalises into this one shape. Screens, rules,
 * and analytics only ever see these fields.
 *
 * The original API response is preserved verbatim in `rawPayload` so a
 * connector change never loses data that normalisation did not anticipate.
 */
export const mentionSchema = z
  .object({
    locationId: uuidSchema.nullable(),
    platformConnectionId: uuidSchema,
    platformProfileId: uuidSchema.nullable(),
    sourceType: mentionSourceTypeSchema,
    /** Identifier on the source platform. Unique per connection and source type. */
    externalId: z.string().min(1).max(300),
    /** Parent thread or article, when the source is a reply or a comment. */
    externalParentId: z.string().max(300).nullable(),
    sourceUrl: z.url().nullable(),
    title: z.string().max(400).nullable(),
    content: z.string(),
    authorName: z.string().max(200).nullable(),
    authorExternalId: z.string().max(200).nullable(),
    /** Star rating on review sources; null everywhere else. */
    rating: z.number().min(0).max(5).nullable(),
    language: languageTagSchema.nullable(),
    /** When the author published it on the source platform. */
    publishedAt: timestampSchema,
    /** When Lia ingested it. Differs from `publishedAt` after a backfill. */
    receivedAt: timestampSchema,
    status: mentionStatusSchema,
    sentiment: sentimentSchema,
    riskLevel: riskLevelSchema,
    relevanceScore: unitScoreSchema.nullable(),
    engagementScore: unitScoreSchema.nullable(),
    rawPayload: jsonObjectSchema,

    /* ---------------------------------------------------------------------- */
    /* Source-owned fields                                                     */
    /*                                                                        */
    /* Everything below is owned by the platform, not by Lia. A sync overwrites */
    /* these on every run; nothing above `rawPayload` that represents a human   */
    /* decision — status, sentiment, risk — is ever touched by an ingest.       */
    /* ---------------------------------------------------------------------- */

    /** Fully qualified provider resource name, when the provider has one. */
    externalResourceName: z.string().max(400).nullable(),
    authorAvatarUrl: z.url().nullable(),
    /**
     * The source said the author is anonymous.
     *
     * Distinct from `authorName` being null, which only means we were not given
     * one. Google reports the two separately and so does Lia.
     */
    authorIsAnonymous: z.boolean(),
    /** When the author last edited it at the source. Null when unreported. */
    sourceUpdatedAt: timestampSchema.nullable(),
    /**
     * The owner reply currently published at the source.
     *
     * Source state, not a Lia response. Lia has published nothing — this is
     * what the platform shows today, recorded so a future drafting workflow can
     * see that a reply already exists rather than proposing a second one.
     */
    sourceReplyText: z.string().nullable(),
    sourceReplyUpdatedAt: timestampSchema.nullable(),
    /** Named, reviewed source fields. Never a spread of a provider response. */
    sourceMetadata: jsonObjectSchema,
    /** When a sync last confirmed this record against the source. */
    lastSyncedAt: timestampSchema.nullable(),

    /* ---------------------------------------------------------------------- */
    /* News fields                                                             */
    /*                                                                        */
    /* Platform-neutral, matching D21's precedent of extending the canonical   */
    /* model rather than forking the inbox for a new source.                  */
    /* ---------------------------------------------------------------------- */

    /** The outlet's name, as the source reported it. Source-owned. */
    publisherName: z.string().max(200).nullable(),
    /** The outlet's domain, as the source reported it. Source-owned. */
    publisherDomain: z.string().max(253).nullable(),
    /**
     * Set by Lia's own gate, never by a provider — the free news tier offers
     * no clustering flag of its own (D86).
     */
    isSyndicated: z.boolean(),

    /* ---------------------------------------------------------------------- */
    /* Discussion fields                                                       */
    /*                                                                        */
    /* Platform-neutral, following the same precedent the news fields set: a   */
    /* threaded public discussion is not a Reddit idea, and forking the inbox  */
    /* for one would repeat the mistake D21 refused. Every one of these is     */
    /* source-owned — a refresh overwrites them, and none of them is reachable */
    /* from Lia's own workflow state.                                          */
    /* ---------------------------------------------------------------------- */

    /**
     * The post at the top of the thread this belongs to.
     *
     * A root post sets this to its own external id; a comment sets it to the
     * root post's. That self-reference is deliberate — it makes "everything in
     * this thread" one equality filter rather than a union of two queries, and
     * it means a thread with no comments yet is still a thread.
     */
    conversationRootExternalId: z.string().max(300).nullable(),
    /** The community, canonical and bare: `askculinary`, never `r/AskCulinary`. */
    sourceCommunity: z.string().max(120).nullable(),
    /** The source's own score. Volatile — refreshed, never treated as history. */
    sourceScore: z.number().int().nullable(),
    sourceCommentCount: z.number().int().min(0).nullable(),
    /** Replies are closed. Publishing must refuse rather than discover this. */
    sourceIsLocked: z.boolean(),
    sourceIsArchived: z.boolean(),
    sourceIsNsfw: z.boolean(),
    /**
     * When the source stopped carrying this content.
     *
     * Set when a refresh finds a post or comment deleted or removed. Not a
     * tombstone for its own sake: it is what the retention contract counts
     * from, and what stops Lia showing a customer's team words their author
     * has withdrawn.
     */
    sourceRemovedAt: timestampSchema.nullable(),
    /**
     * When Lia last confirmed this record still exists at the source.
     *
     * Distinct from `lastSyncedAt`, which says when a sync last wrote it. This
     * says when its continued existence was last checked, which is the clock
     * the deletion window actually runs on — and the one an operator watches
     * to know whether Lia is keeping up with its obligations.
     */
    sourceLastVerifiedAt: timestampSchema.nullable(),
    /**
     * The monitoring query that first found this article.
     *
     * Deliberately **not** source-owned: an article naming two restaurants
     * attributes to whichever query saw it first, and a second query that
     * later matches the same article must not steal the attribution.
     * `applySourceFields` leaves this untouched on update — only a brand-new
     * mention sets it.
     */
    monitoringQueryId: uuidSchema.nullable(),

    /* ---------------------------------------------------------------------- */
    /* Capture provenance                                                      */
    /*                                                                        */
    /* How this record's content got here. Platform-neutral, and deliberately  */
    /* **not** source-owned: a synchronisation may not write any of these, so  */
    /* no ingest can relabel a customer-typed review as retrieved from an API, */
    /* or the reverse. See SOURCE_OWNED_MENTION_FIELDS, which omits them.      */
    /* ---------------------------------------------------------------------- */

    /**
     * Whether a provider returned this content or a person typed it.
     *
     * Every mention that predates manual capture is `provider_api`, which is
     * true of all of them. The value is what the interface reads to decide
     * whether it may say "imported" — and what stops it saying so about a
     * review nothing ever imported.
     */
    captureMethod: mentionCaptureMethodSchema,
    /** Who typed it. Null on every `provider_api` row. */
    capturedByUserId: uuidSchema.nullable(),
    /** When they typed it. Distinct from `publishedAt`, which is Yelp's date. */
    capturedAt: timestampSchema.nullable(),
    /**
     * The listing-activity occurrence that prompted the capture, if any.
     *
     * Nullable even on a manual row: somebody may add a review they found
     * themselves, with no detected change behind it, and demanding an
     * occurrence would make the ordinary case impossible.
     */
    yelpActivityOccurrenceId: uuidSchema.nullable(),
  })
  .extend(organizationOwnedSchema.shape)
  .extend(timestampsSchema.shape);

export type Mention = z.infer<typeof mentionSchema>;

/** Defaults for the source-owned fields workflow 03 added, for older fixtures. */
export const NEW_MENTION_DEFAULTS = {
  externalResourceName: null,
  authorAvatarUrl: null,
  authorIsAnonymous: false,
  sourceUpdatedAt: null,
  sourceReplyText: null,
  sourceReplyUpdatedAt: null,
  sourceMetadata: {},
  lastSyncedAt: null,
  // News fields (workflow 06). Every pre-existing fixture predates news
  // monitoring, so null/false is the honest default rather than a fabrication.
  publisherName: null,
  publisherDomain: null,
  isSyndicated: false,
  monitoringQueryId: null,
  // Discussion fields. Every pre-existing fixture predates Reddit monitoring;
  // null and false are the honest defaults rather than a fabricated thread.
  conversationRootExternalId: null,
  sourceCommunity: null,
  sourceScore: null,
  sourceCommentCount: null,
  sourceIsLocked: false,
  sourceIsArchived: false,
  sourceIsNsfw: false,
  sourceRemovedAt: null,
  sourceLastVerifiedAt: null,
  // Capture provenance. Every pre-existing fixture came from a provider, so
  // `provider_api` is the honest default rather than a placeholder.
  captureMethod: "provider_api",
  capturedByUserId: null,
  capturedAt: null,
  yelpActivityOccurrenceId: null,
} as const;

/**
 * Fields a connector supplies on ingest.
 *
 * `organizationId` is deliberately absent: the tenant comes from the caller's
 * verified scope, never from the payload. A connector that could name its own
 * organization would be a cross-tenant write waiting to happen.
 */
export const createMentionInputSchema = mentionSchema
  .omit({
    id: true,
    organizationId: true,
    createdAt: true,
    updatedAt: true,
    status: true,
    sentiment: true,
    riskLevel: true,
    receivedAt: true,
  })
  .extend({
    status: mentionStatusSchema.default("new"),
    sentiment: sentimentSchema.default("unknown"),
    riskLevel: riskLevelSchema.default("low"),
    receivedAt: timestampSchema.optional(),
    // Defaulted rather than required so a connector that does not have these
    // concepts — a Reddit thread has no owner reply — does not have to name
    // them just to say "none".
    externalResourceName: z.string().max(400).nullable().default(null),
    authorAvatarUrl: z.url().nullable().default(null),
    authorIsAnonymous: z.boolean().default(false),
    sourceUpdatedAt: timestampSchema.nullable().default(null),
    sourceReplyText: z.string().nullable().default(null),
    sourceReplyUpdatedAt: timestampSchema.nullable().default(null),
    sourceMetadata: jsonObjectSchema.default({}),
    lastSyncedAt: timestampSchema.nullable().default(null),
    // News fields, defaulted for the same reason: every non-news caller has
    // no concept of a publisher or a monitoring query.
    publisherName: z.string().max(200).nullable().default(null),
    publisherDomain: z.string().max(253).nullable().default(null),
    isSyndicated: z.boolean().default(false),
    monitoringQueryId: uuidSchema.nullable().default(null),
    // Discussion fields, defaulted for the same reason: a Google review is not
    // a thread and has no community, score, or lock state to name.
    conversationRootExternalId: z.string().max(300).nullable().default(null),
    sourceCommunity: z.string().max(120).nullable().default(null),
    sourceScore: z.number().int().nullable().default(null),
    sourceCommentCount: z.number().int().min(0).nullable().default(null),
    sourceIsLocked: z.boolean().default(false),
    sourceIsArchived: z.boolean().default(false),
    sourceIsNsfw: z.boolean().default(false),
    sourceRemovedAt: timestampSchema.nullable().default(null),
    sourceLastVerifiedAt: timestampSchema.nullable().default(null),
    // Capture provenance, defaulted so every existing caller — Google's sync,
    // the news poll, the seed — keeps compiling and keeps saying the true
    // thing about itself. Only the manual-capture service names these, and it
    // is the only caller with a person and a moment to name them with.
    captureMethod: mentionCaptureMethodSchema.default("provider_api"),
    capturedByUserId: uuidSchema.nullable().default(null),
    capturedAt: timestampSchema.nullable().default(null),
    yelpActivityOccurrenceId: uuidSchema.nullable().default(null),
  })
  /**
   * A typed review has a typist; a fetched one does not.
   *
   * Enforced here as well as by a database constraint, because this pairing is
   * what makes `captureMethod` worth having. A `manual_entry` row with no actor
   * and no timestamp is provenance that records nothing, and a `provider_api`
   * row carrying an actor is a fetched review wearing somebody's name — which
   * is precisely the confusion the column exists to prevent.
   */
  .superRefine((value, ctx) => {
    const manual = value.captureMethod === "manual_entry";
    if (manual && (value.capturedByUserId === null || value.capturedAt === null)) {
      ctx.addIssue({
        code: "custom",
        path: ["capturedByUserId"],
        message: "A manually captured mention must name who captured it, and when",
      });
    }
    if (!manual && (value.capturedByUserId !== null || value.capturedAt !== null)) {
      ctx.addIssue({
        code: "custom",
        path: ["captureMethod"],
        message: "Only a manually captured mention may carry a capturing actor",
      });
    }
  });

export type CreateMentionInput = z.input<typeof createMentionInputSchema>;

/* -------------------------------------------------------------------------- */
/* Ingest                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * What a synchronisation is allowed to write.
 *
 * The omissions are the point. `status`, `sentiment`, `riskLevel`,
 * `relevanceScore`, and `engagementScore` are absent from this type, so a sync
 * cannot set them even by accident — a re-import that moved a mention a person
 * had escalated back to "new" would quietly drop it out of the queue somebody
 * is working, and no amount of care at the call site is as reliable as the
 * field not existing.
 *
 * `receivedAt` is likewise absent: it records when Lia first saw the mention,
 * and a re-sync did not first see it again.
 */
export const ingestMentionInputSchema = mentionSchema
  .pick({
    locationId: true,
    platformConnectionId: true,
    platformProfileId: true,
    sourceType: true,
    externalId: true,
    externalParentId: true,
    sourceUrl: true,
    title: true,
    content: true,
    authorName: true,
    authorExternalId: true,
    rating: true,
    language: true,
    publishedAt: true,
    rawPayload: true,
    externalResourceName: true,
    authorAvatarUrl: true,
    authorIsAnonymous: true,
    sourceUpdatedAt: true,
    sourceReplyText: true,
    sourceReplyUpdatedAt: true,
    sourceMetadata: true,
  })
  .extend({
    /**
     * When this sync ran.
     *
     * Supplied by the caller rather than read from the clock inside each
     * adapter, so the demo adapter (which runs on a fixed seed clock) and the
     * Supabase adapter record the same instant for the same run.
     */
    syncedAt: timestampSchema,
    // News fields. Extended rather than picked, so every existing ingest
    // caller (Google, Reddit) that has no concept of a publisher or a
    // monitoring query keeps compiling and defaults to "none" rather than
    // being forced to name one.
    publisherName: z.string().max(200).nullable().default(null),
    publisherDomain: z.string().max(253).nullable().default(null),
    /**
     * Set only on a brand-new mention (see `applySourceFields`); absent from
     * `SOURCE_OWNED_MENTION_FIELDS` on purpose.
     */
    monitoringQueryId: uuidSchema.nullable().default(null),
    // Discussion fields. Extended rather than picked, so every existing ingest
    // caller — Google, news — keeps compiling and defaults to "not a thread"
    // rather than being forced to describe one.
    conversationRootExternalId: z.string().max(300).nullable().default(null),
    sourceCommunity: z.string().max(120).nullable().default(null),
    sourceScore: z.number().int().nullable().default(null),
    sourceCommentCount: z.number().int().min(0).nullable().default(null),
    sourceIsLocked: z.boolean().default(false),
    sourceIsArchived: z.boolean().default(false),
    sourceIsNsfw: z.boolean().default(false),
    sourceRemovedAt: timestampSchema.nullable().default(null),
    sourceLastVerifiedAt: timestampSchema.nullable().default(null),
  });

/**
 * `z.infer`, not `z.input` — unlike `CreateMentionInput`. Every ingest caller
 * already names every source-owned field explicitly, defaulted or not (an
 * ingest is a deliberate overwrite of a live record), so the `.default()`s
 * above exist as a schema-level safety net rather than for a caller's
 * convenience. Staying on the output type also keeps `rawPayload` and
 * `sourceMetadata` at their validated `Record<string, JsonValue>` shape:
 * `jsonObjectSchema` is `z.lazy`, whose `z.input` type collapses to
 * `Record<string, unknown>`, which is not assignable back into `Mention`.
 */
export type IngestMentionInput = z.infer<typeof ingestMentionInputSchema>;

/** What an ingest did to the record. Drives the counts a sync reports. */
export type MentionIngestOutcome = "created" | "updated" | "unchanged";

/**
 * "This source is not a threaded discussion."
 *
 * Spread by every ingest caller that is not Reddit. The alternative was to let
 * the schema defaults cover them silently, and that would break the rule this
 * type is built on: an ingest is a deliberate overwrite of a live record, so
 * every source-owned field is named at the call site rather than defaulted
 * into existence. A Google review genuinely has no community, score, or lock
 * state, and saying so once by name is both honest and the thing that makes
 * the next discussion source a compile error here rather than a silent null.
 */
export const NON_DISCUSSION_INGEST_FIELDS = {
  conversationRootExternalId: null,
  sourceCommunity: null,
  sourceScore: null,
  sourceCommentCount: null,
  sourceIsLocked: false,
  sourceIsArchived: false,
  sourceIsNsfw: false,
  sourceRemovedAt: null,
  sourceLastVerifiedAt: null,
} as const satisfies Pick<
  IngestMentionInput,
  | "conversationRootExternalId"
  | "sourceCommunity"
  | "sourceScore"
  | "sourceCommentCount"
  | "sourceIsLocked"
  | "sourceIsArchived"
  | "sourceIsNsfw"
  | "sourceRemovedAt"
  | "sourceLastVerifiedAt"
>;

/**
 * The fields an ingest owns.
 *
 * Declared once, as data, so the two adapters cannot disagree about which side
 * of the line a field falls on — and so adding a source field to `Mention`
 * without deciding whether a sync owns it becomes a visible omission here
 * rather than an invisible one in two query builders.
 */
export const SOURCE_OWNED_MENTION_FIELDS = [
  "locationId",
  "platformProfileId",
  "externalParentId",
  "sourceUrl",
  "title",
  "content",
  "authorName",
  "authorExternalId",
  "authorAvatarUrl",
  "authorIsAnonymous",
  "rating",
  "language",
  "publishedAt",
  "rawPayload",
  "externalResourceName",
  "sourceUpdatedAt",
  "sourceReplyText",
  "sourceReplyUpdatedAt",
  "sourceMetadata",
  "publisherName",
  "publisherDomain",
  // Discussion fields. Every one is source-owned: a refresh is the only thing
  // that knows a thread was locked, archived, re-scored, or removed, and none
  // of them is a decision a person made in Lia.
  "conversationRootExternalId",
  "sourceCommunity",
  "sourceScore",
  "sourceCommentCount",
  "sourceIsLocked",
  "sourceIsArchived",
  "sourceIsNsfw",
  "sourceRemovedAt",
  "sourceLastVerifiedAt",
] as const satisfies readonly (keyof IngestMentionInput & keyof Mention)[];

/**
 * Did anything the source owns actually change?
 *
 * Used to report `unchanged` rather than `updated`, which is what makes a
 * second sync legible: "42 fetched, 0 created, 0 updated, 42 unchanged" says
 * the import is idempotent in a way that "42 updated" does not.
 *
 * Compared by JSON rather than by reference so `rawPayload` and
 * `sourceMetadata` are examined by value.
 */
export function sourceFieldsChanged(
  existing: Mention,
  input: IngestMentionInput,
): boolean {
  return SOURCE_OWNED_MENTION_FIELDS.some(
    (field) => JSON.stringify(existing[field]) !== JSON.stringify(input[field]),
  );
}

/**
 * Apply an ingest to an existing mention.
 *
 * Everything not named in `SOURCE_OWNED_MENTION_FIELDS` is carried through from
 * `existing` untouched — the status somebody set, the sentiment an analysis
 * produced, the `receivedAt` from the first import, and the `id` that every
 * draft, approval, and escalation references.
 */
export function applySourceFields(
  existing: Mention,
  input: IngestMentionInput,
  updatedAt: string,
): Mention {
  return {
    ...existing,
    locationId: input.locationId,
    platformProfileId: input.platformProfileId,
    externalParentId: input.externalParentId,
    sourceUrl: input.sourceUrl,
    title: input.title,
    content: input.content,
    authorName: input.authorName,
    authorExternalId: input.authorExternalId,
    authorAvatarUrl: input.authorAvatarUrl,
    authorIsAnonymous: input.authorIsAnonymous,
    rating: input.rating,
    language: input.language,
    publishedAt: input.publishedAt,
    rawPayload: input.rawPayload,
    externalResourceName: input.externalResourceName,
    sourceUpdatedAt: input.sourceUpdatedAt,
    sourceReplyText: input.sourceReplyText,
    sourceReplyUpdatedAt: input.sourceReplyUpdatedAt,
    sourceMetadata: input.sourceMetadata,
    lastSyncedAt: input.syncedAt,
    publisherName: input.publisherName,
    publisherDomain: input.publisherDomain,
    conversationRootExternalId: input.conversationRootExternalId,
    sourceCommunity: input.sourceCommunity,
    sourceScore: input.sourceScore,
    sourceCommentCount: input.sourceCommentCount,
    sourceIsLocked: input.sourceIsLocked,
    sourceIsArchived: input.sourceIsArchived,
    sourceIsNsfw: input.sourceIsNsfw,
    sourceRemovedAt: input.sourceRemovedAt,
    sourceLastVerifiedAt: input.sourceLastVerifiedAt,
    // Deliberately absent: `monitoringQueryId` is not source-owned. See the
    // field's doc comment on `mentionSchema`.
    updatedAt,
  };
}

export const updateMentionStatusInputSchema = z.object({
  mentionId: uuidSchema,
  status: mentionStatusSchema,
  note: z.string().max(1000).optional(),
});

export type UpdateMentionStatusInput = z.infer<
  typeof updateMentionStatusInputSchema
>;

/**
 * Filters accepted by `listMentions`.
 *
 * The demo adapter applies these in memory and the Supabase adapter pushes them
 * into the query, so callers do not have to know which is running.
 */
export const mentionFilterSchema = z.object({
  locationId: uuidSchema.optional(),
  platform: platformSchema.optional(),
  sourceTypes: z.array(mentionSourceTypeSchema).optional(),
  statuses: z.array(mentionStatusSchema).optional(),
  sentiments: z.array(sentimentSchema).optional(),
  riskLevels: z.array(riskLevelSchema).optional(),
  /** Case-insensitive match against title, content, and author name. */
  search: z.string().max(200).optional(),
  publishedAfter: timestampSchema.optional(),
  publishedBefore: timestampSchema.optional(),
  limit: z.number().int().min(1).max(200).optional(),
  offset: z.number().int().min(0).optional(),
});

export type MentionFilter = z.infer<typeof mentionFilterSchema>;

/* -------------------------------------------------------------------------- */
/* Analysis                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * The model's read on a mention.
 *
 * Kept in its own table so a mention can be re-analysed under a new prompt or
 * model without mutating the source record, and so model metadata is auditable.
 */
export const mentionAnalysisSchema = z
  .object({
    mentionId: uuidSchema,
    modelProvider: z.string().min(1).max(80),
    modelName: z.string().min(1).max(120),
    promptVersion: z.string().min(1).max(40),
    relevanceScore: unitScoreSchema,
    relevanceExplanation: z.string().nullable(),
    sentiment: sentimentSchema,
    /** −1 (most negative) to 1 (most positive). */
    sentimentScore: z.number().min(-1).max(1).nullable(),
    riskLevel: riskLevelSchema,
    riskCategories: z.array(escalationCategorySchema),
    riskExplanation: z.string().nullable(),
    topics: z.array(z.string().min(1).max(80)),
    /** Claims a human should check before Lia repeats or contradicts them. */
    factsNeedingVerification: z.array(z.string().min(1).max(400)),
    recommendedAction: recommendedActionSchema,
    recommendationExplanation: z.string().nullable(),
    analyzedAt: timestampSchema,
    /** Which run produced it. Null for seeded rows and one-off analyses. */
    analysisRunId: uuidSchema.nullable(),
    /** Null on a heuristic analysis, which spends no tokens. */
    inputTokens: z.number().int().min(0).nullable(),
    outputTokens: z.number().int().min(0).nullable(),
    /**
     * When this occurrence's effects (escalation decision + mention
     * outcome) were applied, set only by `apply_analysis_occurrence`. Null
     * marks a pending occurrence — recovery re-picks it rather than
     * re-analysing.
     */
    outcomeAppliedAt: timestampSchema.nullable(),
    createdAt: timestampSchema,
  })
  .extend(organizationOwnedSchema.shape);

export type MentionAnalysis = z.infer<typeof mentionAnalysisSchema>;

/**
 * What an analysis run writes.
 *
 * `organizationId` is absent for the same reason it is absent from
 * `CreateMentionInput`: the tenant comes from the caller's verified scope, not
 * from the payload.
 *
 * `analyzedAt` is supplied rather than defaulted so every analysis in one run
 * carries that run's instant, and the demo store's fixed clock does not
 * disagree with Postgres.
 *
 * `analysisRunId` is required and non-null, unlike the entity's own field: the
 * logical analysis event is (organization, run, mention), so a recording with
 * no run id has no identity and cannot be deduplicated. Historical rows carry
 * none, which is why the entity stays nullable; new work carries one, which is
 * why `record_analysis_occurrence` refuses a null run id (22004) and this
 * schema refuses it before the call is made.
 */
export const createMentionAnalysisInputSchema = mentionAnalysisSchema
  .omit({
    id: true,
    organizationId: true,
    createdAt: true,
  })
  .extend({
    analysisRunId: uuidSchema,
    inputTokens: z.number().int().min(0).nullable().default(null),
    outputTokens: z.number().int().min(0).nullable().default(null),
    // Freshly recorded occurrences are pending until apply_analysis_occurrence
    // applies their outcome; nothing that creates an analysis through this
    // input has authority to claim it was already applied.
    outcomeAppliedAt: timestampSchema.nullable().default(null),
  });

export type CreateMentionAnalysisInput = z.input<
  typeof createMentionAnalysisInputSchema
>;

/** Provenance for an analysis produced without a model call. */
export const HEURISTIC_MODEL_PROVIDER = "lia" as const;
export const HEURISTIC_MODEL_NAME = "rating-heuristic" as const;

/**
 * Was this analysis produced by a model, or by a pure function?
 *
 * Worth being able to ask: a rating-only review's analysis is honest but
 * shallow, and a reader comparing two analyses should be able to tell which
 * kind they are looking at rather than assuming a model weighed both.
 */
export function isHeuristicAnalysis(analysis: {
  modelProvider: string;
  modelName: string;
}): boolean {
  return (
    analysis.modelProvider === HEURISTIC_MODEL_PROVIDER &&
    analysis.modelName === HEURISTIC_MODEL_NAME
  );
}

/** A mention with its latest analysis, which is what every workspace renders. */
export const mentionWithAnalysisSchema = z.object({
  mention: mentionSchema,
  analysis: mentionAnalysisSchema.nullable(),
});

export type MentionWithAnalysis = z.infer<typeof mentionWithAnalysisSchema>;

/* -------------------------------------------------------------------------- */
/* Source mapping                                                              */
/* -------------------------------------------------------------------------- */

/** Which platform a source type belongs to. Used for grouping and routing. */
export const SOURCE_TYPE_PLATFORM: Record<
  z.infer<typeof mentionSourceTypeSchema>,
  z.infer<typeof platformSchema>
> = {
  google_review: "google_business_profile",
  yelp_review: "yelp",
  trustpilot_review: "trustpilot",
  tripadvisor_review: "tripadvisor",
  reddit_post: "reddit",
  reddit_comment: "reddit",
  news_article: "news_media",
  article_comment: "disqus",
  facebook_comment: "facebook",
  instagram_comment: "instagram",
};

/**
 * The reverse of `SOURCE_TYPE_PLATFORM`: every source type a platform can
 * produce.
 *
 * Derived from the forward map rather than written out again, so the two can
 * never disagree about where a source type lives.
 *
 * It exists because excluding a source type does not necessarily exclude its
 * platform, which is what `rulePlatformScope` needs to get right: a rule
 * carrying only `source_type is_not reddit_post` still affects Reddit, because
 * `reddit_comment` remains. Reddit is the only platform with more than one
 * source type today — hard-coding around that would break on the second.
 *
 * Seeded from `PLATFORMS` rather than from the forward map's values so a
 * platform with no source type yet still gets a key. Reading a missing one
 * would return undefined and throw on the caller's `.filter`, rather than
 * answering "nothing excludes this platform".
 */
export const PLATFORM_SOURCE_TYPES: Record<
  z.infer<typeof platformSchema>,
  readonly z.infer<typeof mentionSourceTypeSchema>[]
> = (() => {
  const map = {} as Record<
    z.infer<typeof platformSchema>,
    z.infer<typeof mentionSourceTypeSchema>[]
  >;
  for (const platform of PLATFORMS) map[platform] = [];
  for (const sourceType of MENTION_SOURCE_TYPES) {
    map[SOURCE_TYPE_PLATFORM[sourceType]].push(sourceType);
  }
  return map;
})();

/** Source types that carry a star rating. */
export const REVIEW_SOURCE_TYPES = [
  "google_review",
  "yelp_review",
  "trustpilot_review",
  "tripadvisor_review",
] as const;

export function isReviewSourceType(
  sourceType: z.infer<typeof mentionSourceTypeSchema>,
): boolean {
  return (REVIEW_SOURCE_TYPES as readonly string[]).includes(sourceType);
}
