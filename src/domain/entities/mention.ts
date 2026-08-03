import { z } from "zod";
import {
  escalationCategorySchema,
  mentionSourceTypeSchema,
  mentionStatusSchema,
  platformSchema,
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
  });

export type IngestMentionInput = z.infer<typeof ingestMentionInputSchema>;

/** What an ingest did to the record. Drives the counts a sync reports. */
export type MentionIngestOutcome = "created" | "updated" | "unchanged";

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
    createdAt: timestampSchema,
  })
  .extend(organizationOwnedSchema.shape);

export type MentionAnalysis = z.infer<typeof mentionAnalysisSchema>;

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
