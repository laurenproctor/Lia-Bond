import { z } from "zod";
import {
  gateRejectionReasonSchema,
  monitoringQueryTypeSchema,
  syncRunStatusSchema,
  syncTriggerSchema,
} from "@/domain/enums";
import {
  languageTagSchema,
  organizationOwnedSchema,
  timestampSchema,
  timestampsSchema,
  unitScoreSchema,
  uuidSchema,
} from "@/domain/primitives";

/**
 * What Lia watches.
 *
 * The entity Google never needed. A review sync knows what to fetch because a
 * listing was mapped to a location; a news poll has no such anchor, so the
 * query itself is the anchor.
 */

/** Below this, polling would burn the daily request budget (D67). */
export const MIN_POLL_INTERVAL_MINUTES = 60;
/** The GNews free tier returns at most this many articles per request. */
export const MAX_ARTICLES_PER_POLL = 10;
/** A repeated headline inside this window is treated as syndication (D68). */
export const SYNDICATION_WINDOW_MS = 72 * 60 * 60 * 1000;
/**
 * How long a rejection is kept.
 *
 * This table writes far more rows per run than a sync does, so unlike
 * `platform_sync_runs` it has a retention policy from the start.
 */
export const REJECTION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const termSchema = z.string().trim().min(2).max(120);
const domainSchema = z
  .string()
  .trim()
  .min(3)
  .max(253)
  .regex(/^[a-z0-9.-]+$/, "Use a bare domain, without a scheme or path.");

export const monitoringQuerySchema = z
  .object({
    /** Null means organization-wide. Set means articles attribute here. */
    locationId: uuidSchema.nullable(),
    name: z.string().trim().min(1).max(120),
    queryType: monitoringQueryTypeSchema,
    /** Required terms. Pushed down to the provider. */
    keywords: z.array(termSchema).min(1).max(20),
    /** Negative terms. GNews supports NOT, so these push down too. */
    exclusions: z.array(termSchema).max(40),
    /** Empty means every domain is allowed. Also the locality signal. */
    allowedDomains: z.array(domainSchema).max(200),
    deniedDomains: z.array(domainSchema).max(200),
    /** ISO 3166-1 alpha-2. What GNews actually filters on. */
    sourceCountry: z.string().length(2).toLowerCase().nullable(),
    language: languageTagSchema.nullable(),
    /** Gate admission floor. Tuned against `news_rejected_candidates`. */
    relevanceThreshold: unitScoreSchema,
    enabled: z.boolean(),
    pollIntervalMinutes: z.number().int().min(MIN_POLL_INTERVAL_MINUTES).max(10_080),
    /** Doubles as the incremental cursor: `publishedAfter` (D66). */
    lastPolledAt: timestampSchema.nullable(),
  })
  .extend(organizationOwnedSchema.shape)
  .extend(timestampsSchema.shape);

export type MonitoringQuery = z.infer<typeof monitoringQuerySchema>;

/**
 * `organizationId` is absent on purpose: the tenant comes from the caller's
 * verified scope, never from the payload. Same rule as `CreateMentionInput`.
 */
export const createMonitoringQueryInputSchema = monitoringQuerySchema.omit({
  id: true,
  organizationId: true,
  createdAt: true,
  updatedAt: true,
  lastPolledAt: true,
});
export type CreateMonitoringQueryInput = z.infer<
  typeof createMonitoringQueryInputSchema
>;

/** `lastPolledAt` is absent: only the poll service advances the cursor. */
export const updateMonitoringQueryInputSchema =
  createMonitoringQueryInputSchema.partial();
export type UpdateMonitoringQueryInput = z.infer<
  typeof updateMonitoringQueryInputSchema
>;

/**
 * One attempt to poll one monitoring query.
 *
 * Its own table rather than a reuse of `platform_sync_runs`, whose
 * `platform_profile_id` is `not null` and which news has nothing to put in
 * (D63).
 */
export const newsPollRunSchema = z
  .object({
    monitoringQueryId: uuidSchema,
    trigger: syncTriggerSchema,
    /** Nulled rather than cascaded: offboarding must not erase the record. */
    actorUserId: uuidSchema.nullable(),
    status: syncRunStatusSchema,
    startedAt: timestampSchema,
    completedAt: timestampSchema.nullable(),
    candidatesEvaluated: z.number().int().min(0),
    acceptedCount: z.number().int().min(0),
    rejectedCount: z.number().int().min(0),
    requestsSpent: z.number().int().min(0),
    /** The provider capped the page and there is no paging to follow. */
    truncated: z.boolean(),
    gateScoreMin: unitScoreSchema.nullable(),
    gateScoreMean: unitScoreSchema.nullable(),
    gateScoreMax: unitScoreSchema.nullable(),
    errorCode: z.string().max(80).nullable(),
    /** Lia's own sentence. Never the provider's message. */
    errorMessage: z.string().max(400).nullable(),
  })
  .extend(organizationOwnedSchema.shape)
  .extend(timestampsSchema.shape);

export type NewsPollRun = z.infer<typeof newsPollRunSchema>;

/**
 * An article the gate refused.
 *
 * "Why did you miss this story" is the first question asked of any monitoring
 * product, and without this row the gate is unfalsifiable (D64).
 */
export const newsRejectedCandidateSchema = z
  .object({
    monitoringQueryId: uuidSchema,
    newsPollRunId: uuidSchema,
    externalId: z.string().min(1).max(500),
    url: z.url(),
    title: z.string().max(400),
    publisherDomain: z.string().max(253),
    reason: gateRejectionReasonSchema,
    score: unitScoreSchema,
    publishedAt: timestampSchema,
  })
  .extend(organizationOwnedSchema.shape)
  .extend(timestampsSchema.shape);

export type NewsRejectedCandidate = z.infer<typeof newsRejectedCandidateSchema>;
