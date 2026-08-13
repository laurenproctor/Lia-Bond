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

/** Below this, polling would burn the daily request budget (D85). */
export const MIN_POLL_INTERVAL_MINUTES = 60;
/**
 * The admission floor a query starts at.
 *
 * One value, declared beside the schema it belongs to, so the integration
 * screen's editor and the onboarding configurator cannot drift onto two
 * different ideas of "default". Matches the seed data's own default.
 */
export const DEFAULT_RELEVANCE_THRESHOLD = 0.35;
/** Four hours. What the query editor has always offered a new query. */
export const DEFAULT_POLL_INTERVAL_MINUTES = MIN_POLL_INTERVAL_MINUTES * 4;
/** The GNews free tier returns at most this many articles per request. */
export const MAX_ARTICLES_PER_POLL = 10;
/**
 * The longest a query may be named.
 *
 * Declared rather than inlined because the generated names — the onboarding
 * brand watch, the per-location watches — are built from an organization or
 * location name that is allowed to be longer than this, and the code that
 * shortens them must not carry its own copy of the limit.
 */
export const MAX_MONITORING_QUERY_NAME_LENGTH = 120;
/** A repeated headline inside this window is treated as syndication (D86). */
export const SYNDICATION_WINDOW_MS = 72 * 60 * 60 * 1000;
/**
 * How long a rejection is kept.
 *
 * This table writes far more rows per run than a sync does, so unlike
 * `platform_sync_runs` it has a retention policy from the start.
 */
export const REJECTION_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * Who created a query.
 *
 * `user` is a person on the News & Media screen; `onboarding` is the setup
 * wizard. Provenance, not behaviour — polling and gating never read it. It
 * exists so the wizard can be idempotent: step 2 edits *its* brand query
 * rather than guessing by position, and step 3 can see that a location's
 * query was created by a person and leave it alone.
 */
export const MONITORING_QUERY_ORIGINS = ["user", "onboarding"] as const;
export const monitoringQueryOriginSchema = z.enum(MONITORING_QUERY_ORIGINS);
export type MonitoringQueryOrigin = z.infer<typeof monitoringQueryOriginSchema>;

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
    name: z.string().trim().min(1).max(MAX_MONITORING_QUERY_NAME_LENGTH),
    queryType: monitoringQueryTypeSchema,
    /** Required terms. Pushed down to the provider. */
    keywords: z.array(termSchema).min(1).max(20),
    /** Negative terms. GNews supports NOT, so these push down too. */
    exclusions: z.array(termSchema).max(40),
    /** Empty means every domain is allowed. Also the locality signal. */
    allowedDomains: z.array(domainSchema).max(200),
    deniedDomains: z.array(domainSchema).max(200),
    /** ISO 3166-1 alpha-2. What GNews actually filters on. */
    sourceCountry: z
      .string()
      .length(2)
      .regex(/^[A-Za-z]{2}$/, "Use a two-letter country code.")
      .toLowerCase()
      .nullable(),
    language: languageTagSchema.nullable(),
    /** Gate admission floor. Tuned against `news_rejected_candidates`. */
    relevanceThreshold: unitScoreSchema,
    enabled: z.boolean(),
    pollIntervalMinutes: z.number().int().min(MIN_POLL_INTERVAL_MINUTES).max(10_080),
    origin: monitoringQueryOriginSchema,
    /** Doubles as the incremental cursor: `publishedAfter` (D84). */
    lastPolledAt: timestampSchema.nullable(),
  })
  .extend(organizationOwnedSchema.shape)
  .extend(timestampsSchema.shape);

export type MonitoringQuery = z.infer<typeof monitoringQuerySchema>;

/**
 * `organizationId` is absent on purpose: the tenant comes from the caller's
 * verified scope, never from the payload. Same rule as `CreateMentionInput`.
 *
 * `origin` defaults to `user` so every pre-existing caller keeps meaning
 * what it meant; only the onboarding services pass `onboarding`, and the
 * public create action overrides whatever the browser sent — a client must
 * not be able to label its own query as the wizard's.
 */
export const createMonitoringQueryInputSchema = monitoringQuerySchema
  .omit({
    id: true,
    organizationId: true,
    createdAt: true,
    updatedAt: true,
    lastPolledAt: true,
    origin: true,
  })
  .extend({ origin: monitoringQueryOriginSchema.default("user") });
/**
 * `z.input`, not `z.infer`: `origin` is defaulted by the schema, so a caller
 * that has nothing to say about provenance — every pre-existing one — may
 * omit it and gets `user` after parsing.
 */
export type CreateMonitoringQueryInput = z.input<
  typeof createMonitoringQueryInputSchema
>;

/**
 * `lastPolledAt` is absent: only the poll service advances the cursor.
 * `origin` is absent: provenance is set at creation and never edited.
 */
export const updateMonitoringQueryInputSchema = createMonitoringQueryInputSchema
  .omit({ origin: true })
  .partial();
export type UpdateMonitoringQueryInput = z.infer<
  typeof updateMonitoringQueryInputSchema
>;

/**
 * What the onboarding configurator may set.
 *
 * A strict subset of `createMonitoringQueryInputSchema`, picked rather than
 * restated so the fields cannot drift from the real schema. Everything absent
 * — query type, location binding, publisher lists, the admission threshold,
 * the poll interval — is filled with the documented defaults on the server
 * (`saveOnboardingNewsQuery`), because those are tuning controls that belong
 * on the full News & Media screen, not decisions to demand from somebody four
 * minutes into their account.
 */
export const onboardingNewsMonitoringInputSchema = createMonitoringQueryInputSchema.pick({
  name: true,
  keywords: true,
  exclusions: true,
  sourceCountry: true,
  language: true,
  enabled: true,
});
export type OnboardingNewsMonitoringInput = z.infer<
  typeof onboardingNewsMonitoringInputSchema
>;

/**
 * One attempt to poll one monitoring query.
 *
 * Its own table rather than a reuse of `platform_sync_runs`, whose
 * `platform_profile_id` is `not null` and which news has nothing to put in
 * (D81).
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
 * product, and without this row the gate is unfalsifiable (D82).
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
