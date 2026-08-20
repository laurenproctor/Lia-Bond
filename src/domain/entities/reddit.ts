import { z } from "zod";
import { syncTriggerSchema } from "@/domain/enums";
import {
  organizationOwnedSchema,
  timestampSchema,
  timestampsSchema,
  unitScoreSchema,
  uuidSchema,
} from "@/domain/primitives";

/**
 * Reddit's own vocabulary.
 *
 * Deliberately separate from `monitoring.ts`, which is news. The two look
 * superficially alike — both are "things Lia watches" — and merging them was
 * considered and refused: a news query carries publisher domains, a country, a
 * language, and a GNews relevance threshold, none of which mean anything to
 * Reddit, while a Reddit query carries subreddits and a comment-thread refresh
 * cadence, which mean nothing to GNews. A single table with a `platform`
 * discriminator would make half its columns null on every row and turn a
 * mature, tested news service into a union of two incompatible ideas.
 */

/* -------------------------------------------------------------------------- */
/* Identifiers                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Reddit "fullnames": a type prefix and a base-36 id.
 *
 * `t3_` is a post (a "link"), `t1_` is a comment. Every external id Lia stores
 * for Reddit is a fullname rather than a bare id, because the bare ids are
 * drawn from the same space — post `abc123` and comment `abc123` can both
 * exist — and a store keyed on the bare id would silently collide them.
 */
export const redditPostFullnameSchema = z
  .string()
  .regex(/^t3_[a-z0-9]{1,20}$/, "Expected a Reddit post fullname, like t3_abc123");

export const redditCommentFullnameSchema = z
  .string()
  .regex(/^t1_[a-z0-9]{1,20}$/, "Expected a Reddit comment fullname, like t1_abc123");

/** Either kind. Used where a target may be a post or a comment. */
export const redditFullnameSchema = z
  .string()
  .regex(/^t[13]_[a-z0-9]{1,20}$/, "Expected a Reddit post or comment fullname");

export function isRedditPostFullname(value: string): boolean {
  return redditPostFullnameSchema.safeParse(value).success;
}

export function isRedditCommentFullname(value: string): boolean {
  return redditCommentFullnameSchema.safeParse(value).success;
}

/**
 * A subreddit name in the one form Lia stores: lowercase, bare, no `r/`.
 *
 * Reddit's own rules — 3 to 21 characters, letters, digits, and underscores.
 * Stored canonically rather than as typed, because a community posture keyed
 * on "AskCulinary" would not match a monitor configured for "askculinary", and
 * the failure mode of that mismatch is publishing into a community whose rules
 * nobody checked.
 */
export const subredditNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9_]{2,20}$/, "Use a bare subreddit name, without r/");

export type SubredditName = z.infer<typeof subredditNameSchema>;

/**
 * Reduce whatever somebody typed to a canonical subreddit name, or null.
 *
 * Accepts the forms people actually paste — `r/AskCulinary`, `/r/askculinary`,
 * a full URL — and refuses anything that is not exactly one community:
 * wildcards, multireddits (`a+b`), user pages, and empty strings. Returning
 * null rather than throwing lets the caller decide whether a bad entry is a
 * validation error to show or an item to drop.
 */
export function canonicalizeSubreddit(input: string): SubredditName | null {
  const trimmed = input.trim();
  if (trimmed.length === 0) return null;

  // Strip a URL down to its path, so a pasted link works and a link to
  // something that is not a subreddit does not.
  const withoutOrigin = trimmed.replace(
    /^(?:https?:)?\/\/(?:[a-z0-9-]+\.)*reddit\.com/i,
    "",
  );
  // A remaining scheme means it was a URL to somewhere else entirely.
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(withoutOrigin)) return null;

  const withoutPrefix = withoutOrigin
    .replace(/^\/+/, "")
    .replace(/^r\//i, "")
    .replace(/\/+$/, "");

  // `a+b` is a multireddit and `user/name` is a profile: both are one string
  // naming something other than one community, and neither has rules Lia can
  // check.
  if (withoutPrefix.includes("/") || withoutPrefix.includes("+")) return null;

  const lowered = withoutPrefix.toLowerCase();
  const parsed = subredditNameSchema.safeParse(lowered);
  return parsed.success ? parsed.data : null;
}

/* -------------------------------------------------------------------------- */
/* Vocabularies                                                                */
/* -------------------------------------------------------------------------- */

/**
 * What a poll run was doing.
 *
 * `search` discovers posts matching a query. `thread_refresh` re-reads the
 * comments inside a post Lia already matched. `deletion_reconcile` re-verifies
 * stored content against the source so deletions are honoured within the
 * agreed window. Three kinds rather than one because their budgets, their
 * failure meanings, and their scheduling are all different — and because a
 * discovery backlog must never be able to starve the deletion duty.
 */
export const REDDIT_POLL_RUN_KINDS = [
  "search",
  "thread_refresh",
  "deletion_reconcile",
] as const;
export const redditPollRunKindSchema = z.enum(REDDIT_POLL_RUN_KINDS);
export type RedditPollRunKind = z.infer<typeof redditPollRunKindSchema>;

export const REDDIT_POLL_RUN_STATUSES = ["running", "completed", "failed"] as const;
export const redditPollRunStatusSchema = z.enum(REDDIT_POLL_RUN_STATUSES);
export type RedditPollRunStatus = z.infer<typeof redditPollRunStatusSchema>;

/**
 * Whether Lia may post into a community.
 *
 * Four values, and the ordering of the two negative ones matters. Subreddit
 * rules bind before Reddit's own do: many communities ban brand and
 * promotional accounts outright, and a technically-permitted reply into one of
 * those still ends in a ban — usually of the customer's account, not Lia's. So
 * this is a per-community decision a person makes and records, never a global
 * "can post" flag.
 *
 * Only `allowed` permits publishing. `unknown` is the default for a community
 * nobody has looked at; `review_required` is where a community returns when
 * its rules change under a previously-granted `allowed`; `blocked` is an
 * explicit refusal. All three fail closed.
 */
export const REDDIT_COMMUNITY_POSTURES = [
  "unknown",
  "review_required",
  "allowed",
  "blocked",
] as const;
export const redditCommunityPostureValueSchema = z.enum(REDDIT_COMMUNITY_POSTURES);
export type RedditCommunityPostureValue = z.infer<
  typeof redditCommunityPostureValueSchema
>;

/** The one value that permits a public write. */
export function permitsPublishing(posture: RedditCommunityPostureValue): boolean {
  return posture === "allowed";
}

/**
 * Why the deterministic gate refused a candidate.
 *
 * Reddit's own list rather than a reuse of `GATE_REJECTION_REASONS`, which is
 * shaped around news: publisher allowlists and syndication have no Reddit
 * meaning, and NSFW and community posture have no news meaning.
 */
export const REDDIT_GATE_REJECTION_REASONS = [
  "malformed",
  "removed_at_source",
  "nsfw_excluded",
  "denied_community",
  "outside_allowed_communities",
  "excluded_term",
  "no_required_term",
  "below_threshold",
] as const;
export const redditGateRejectionReasonSchema = z.enum(REDDIT_GATE_REJECTION_REASONS);
export type RedditGateRejectionReason = z.infer<
  typeof redditGateRejectionReasonSchema
>;

/* -------------------------------------------------------------------------- */
/* Bounds                                                                      */
/* -------------------------------------------------------------------------- */

/** Below this, polling would burn the negotiated request budget. */
export const MIN_REDDIT_POLL_INTERVAL_MINUTES = 15;
/** What the query editor offers a new monitor. */
export const DEFAULT_REDDIT_POLL_INTERVAL_MINUTES = 60;
export const MAX_REDDIT_QUERY_NAME_LENGTH = 120;
export const MAX_REDDIT_TERMS = 20;
export const MAX_REDDIT_EXCLUSIONS = 40;
export const MAX_REDDIT_COMMUNITIES = 100;
/** The gate's admission floor for a new monitor. */
export const DEFAULT_REDDIT_RELEVANCE_THRESHOLD = 0.35;

const redditTermSchema = z.string().trim().min(2).max(120);

/* -------------------------------------------------------------------------- */
/* Monitoring queries                                                          */
/* -------------------------------------------------------------------------- */

/**
 * What Lia watches on Reddit.
 *
 * `lastPolledAt` is a high-water mark, **not** a provider cursor, and that is a
 * deliberate departure from the news query's `lastPolledAt`-as-cursor (D84). A
 * Reddit listing is mutable — posts are edited, removed, and re-scored, and
 * `new` re-orders under you — so a single cursor advanced past a page is
 * lossy. Polling instead re-reads an overlapping window and relies on the
 * fullname uniqueness to make re-ingesting the same post a no-op.
 */
export const redditMonitoringQuerySchema = z
  .object({
    /** Null means organization-wide. Set means matches attribute here. */
    locationId: uuidSchema.nullable(),
    name: z.string().trim().min(1).max(MAX_REDDIT_QUERY_NAME_LENGTH),
    /** Required terms. At least one, or the monitor matches everything. */
    terms: z.array(redditTermSchema).min(1).max(MAX_REDDIT_TERMS),
    exclusions: z.array(redditTermSchema).max(MAX_REDDIT_EXCLUSIONS),
    /** Empty means every community is allowed, subject to `deniedSubreddits`. */
    allowedSubreddits: z.array(subredditNameSchema).max(MAX_REDDIT_COMMUNITIES),
    deniedSubreddits: z.array(subredditNameSchema).max(MAX_REDDIT_COMMUNITIES),
    /** Off by default. A restaurant's monitor has no business in NSFW threads. */
    includeNsfw: z.boolean(),
    relevanceThreshold: unitScoreSchema,
    enabled: z.boolean(),
    pollIntervalMinutes: z
      .number()
      .int()
      .min(MIN_REDDIT_POLL_INTERVAL_MINUTES)
      .max(10_080),
    /** Provenance only. Polling and gating never read it. */
    origin: z.enum(["user", "onboarding"]),
    /** High-water mark for the overlap window, not a provider cursor. */
    lastPolledAt: timestampSchema.nullable(),
  })
  .extend(organizationOwnedSchema.shape)
  .extend(timestampsSchema.shape);

export type RedditMonitoringQuery = z.infer<typeof redditMonitoringQuerySchema>;

/**
 * `organizationId` is absent on purpose: the tenant comes from the caller's
 * verified scope, never from the payload. Same rule as `CreateMentionInput`.
 */
export const createRedditMonitoringQueryInputSchema = redditMonitoringQuerySchema
  .omit({
    id: true,
    organizationId: true,
    createdAt: true,
    updatedAt: true,
    lastPolledAt: true,
    origin: true,
  })
  .extend({
    origin: z.enum(["user", "onboarding"]).default("user"),
    exclusions: z.array(redditTermSchema).max(MAX_REDDIT_EXCLUSIONS).default([]),
    allowedSubreddits: z
      .array(subredditNameSchema)
      .max(MAX_REDDIT_COMMUNITIES)
      .default([]),
    deniedSubreddits: z
      .array(subredditNameSchema)
      .max(MAX_REDDIT_COMMUNITIES)
      .default([]),
    includeNsfw: z.boolean().default(false),
    relevanceThreshold: unitScoreSchema.default(DEFAULT_REDDIT_RELEVANCE_THRESHOLD),
    enabled: z.boolean().default(true),
    pollIntervalMinutes: z
      .number()
      .int()
      .min(MIN_REDDIT_POLL_INTERVAL_MINUTES)
      .max(10_080)
      .default(DEFAULT_REDDIT_POLL_INTERVAL_MINUTES),
  });

export type CreateRedditMonitoringQueryInput = z.input<
  typeof createRedditMonitoringQueryInputSchema
>;

/**
 * `lastPolledAt` is absent: only the poll service advances the high-water
 * mark, and a failed poll must never be able to claim freshness. `origin` is
 * absent: provenance is set at creation and never edited.
 */
export const updateRedditMonitoringQueryInputSchema =
  createRedditMonitoringQueryInputSchema.omit({ origin: true }).partial();

export type UpdateRedditMonitoringQueryInput = z.infer<
  typeof updateRedditMonitoringQueryInputSchema
>;

/* -------------------------------------------------------------------------- */
/* Poll runs                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * One attempt at one unit of Reddit work.
 *
 * Counts and normalised codes only. There is no `errorMessage` carrying a
 * provider sentence and no field anywhere on this row that could hold Reddit
 * text — a run record is read by operators, and the provider's own message can
 * quote the content that caused it.
 *
 * `rejectedReasonCounts` is a tally rather than a list of what was refused.
 * The news gate keeps whole rejected candidates so it can be tuned, and that
 * was right for news; it is wrong here, because keeping refused Reddit posts
 * would mean storing content Lia decided it had no reason to hold, under the
 * same retention obligations as content it did.
 */
export const redditPollRunSchema = z
  .object({
    kind: redditPollRunKindSchema,
    /** Set for `search` runs; null for a thread refresh or a reconcile. */
    redditMonitoringQueryId: uuidSchema.nullable(),
    /** Set for `thread_refresh`; the post whose comments were re-read. */
    rootExternalId: redditPostFullnameSchema.nullable(),
    status: redditPollRunStatusSchema,
    trigger: syncTriggerSchema,
    /** Nulled rather than cascaded: offboarding must not erase the record. */
    actorUserId: uuidSchema.nullable(),
    startedAt: timestampSchema,
    completedAt: timestampSchema.nullable(),
    /** Lease expiry, so a crashed worker's run can be reclaimed. */
    claimExpiresAt: timestampSchema.nullable(),
    requestsSpent: z.number().int().min(0),
    postsEvaluated: z.number().int().min(0),
    postsAccepted: z.number().int().min(0),
    commentsIngested: z.number().int().min(0),
    malformedCount: z.number().int().min(0),
    /** Reason → count. Never the candidates themselves. */
    rejectedReasonCounts: z.record(redditGateRejectionReasonSchema, z.number().int().min(0)),
    /**
     * Coverage was incomplete: the provider capped the listing, the comment
     * budget ran out, or the rate budget did. Surfaced rather than swallowed —
     * partial coverage reported as success is the failure mode that makes a
     * monitoring product untrustworthy.
     */
    truncated: z.boolean(),
    rateLimitRemaining: z.number().int().min(0).nullable(),
    /** A normalised Lia code. Never a provider string. */
    errorCode: z.string().max(80).nullable(),
  })
  .extend(organizationOwnedSchema.shape)
  .extend(timestampsSchema.shape);

export type RedditPollRun = z.infer<typeof redditPollRunSchema>;

/* -------------------------------------------------------------------------- */
/* Query matches                                                               */
/* -------------------------------------------------------------------------- */

/**
 * That a query matched a mention.
 *
 * Its own row rather than a `monitoringQueryId` column on the mention, which is
 * what news does. News can get away with first-writer-wins because an article
 * naming two restaurants is uncommon and the attribution is cosmetic. On
 * Reddit it is neither: two location monitors for the same brand routinely
 * match the same thread, and the attribution decides which restaurant's team
 * sees it. Storing every match lets the location be *derived* from the whole
 * set — and lets a conflict stay honestly organization-wide instead of being
 * resolved by whichever poll happened to run first.
 */
export const redditQueryMatchSchema = z
  .object({
    redditMonitoringQueryId: uuidSchema,
    mentionId: uuidSchema,
    /** Which of the query's terms actually hit. Lia's own words, not Reddit's. */
    matchedTerms: z.array(redditTermSchema).max(MAX_REDDIT_TERMS),
    matchScore: unitScoreSchema,
    firstMatchedAt: timestampSchema,
    lastMatchedAt: timestampSchema,
  })
  .extend(organizationOwnedSchema.shape)
  .extend(timestampsSchema.shape);

export type RedditQueryMatch = z.infer<typeof redditQueryMatchSchema>;

/**
 * Derive a mention's location from every query that matched it.
 *
 * Unanimity or nothing. One location among location-scoped matches wins;
 * disagreement, or matches that are all organization-wide, leaves it
 * organization-wide. The rule this replaces — last writer wins — would let a
 * second monitor silently move a thread out of the queue the first
 * restaurant's team was working.
 *
 * Organization-wide matches are ignored rather than treated as a dissenting
 * vote: a brand-wide monitor matching a thread says nothing about which
 * restaurant it concerns, so letting it veto a location would make the common
 * case (one brand monitor plus one location monitor) resolve to nothing.
 */
export function deriveLocationFromMatches(
  matches: readonly { locationId: string | null }[],
): string | null {
  const located = matches
    .map((match) => match.locationId)
    .filter((id): id is string => id !== null);

  if (located.length === 0) return null;
  const first = located[0] ?? null;
  return located.every((id) => id === first) ? first : null;
}

/* -------------------------------------------------------------------------- */
/* Community postures                                                          */
/* -------------------------------------------------------------------------- */

/**
 * A recorded decision about whether Lia may post into one community.
 *
 * `rulesHash` is what makes `allowed` revocable without a person watching:
 * when a refresh finds the community's rules have changed, the stored hash no
 * longer matches and the posture returns to `review_required`. An `allowed`
 * granted against rules that no longer exist is not a permission, it is a
 * stale note.
 */
export const redditCommunityPostureSchema = z
  .object({
    subreddit: subredditNameSchema,
    posture: redditCommunityPostureValueSchema,
    rulesUrl: z.url().nullable(),
    /** Hash of the fetched rules. Never the rules text, which is Reddit's. */
    rulesHash: z.string().max(128).nullable(),
    rulesCheckedAt: timestampSchema.nullable(),
    decidedByUserId: uuidSchema.nullable(),
    decidedAt: timestampSchema.nullable(),
    /** Lia-side operator note. Free text a person typed, never provider text. */
    note: z.string().max(1000).nullable(),
  })
  .extend(organizationOwnedSchema.shape)
  .extend(timestampsSchema.shape);

export type RedditCommunityPosture = z.infer<
  typeof redditCommunityPostureSchema
>;

/**
 * How long an `allowed` decision stands before it must be re-checked.
 *
 * A default, not a policy. The signed terms may demand something shorter, in
 * which case this is overridden by configuration — but there has to be *some*
 * expiry, because a community's rules can change the day after somebody
 * approved it and nothing would otherwise notice.
 */
export const DEFAULT_COMMUNITY_POSTURE_TTL_MS = 30 * 24 * 60 * 60 * 1000;

/** Is this posture both permissive and current? Both, or publishing refuses. */
export function isPostureCurrent(
  posture: Pick<RedditCommunityPosture, "posture" | "decidedAt">,
  now: Date,
  ttlMs: number = DEFAULT_COMMUNITY_POSTURE_TTL_MS,
): boolean {
  if (!permitsPublishing(posture.posture)) return false;
  if (posture.decidedAt === null) return false;
  return now.getTime() - new Date(posture.decidedAt).getTime() <= ttlMs;
}

/* -------------------------------------------------------------------------- */
/* Rate budget                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The provider-global request budget.
 *
 * Keyed on the OAuth client, not on an organization, because that is how
 * Reddit meters: the limit is consumed by every tenant at once and exceeding
 * it takes down the deployment rather than one customer. This is the one piece
 * of Reddit state in the system that is deliberately not tenant-scoped, and it
 * carries no customer data — which is why it can be, and why it lives behind
 * the service role with no RLS policy at all.
 *
 * In Postgres rather than in memory because serverless has no shared memory: a
 * per-instance limiter on a platform that runs many instances is not a limit,
 * it is a multiplier.
 */
export const redditRateLimitStateSchema = z.object({
  id: uuidSchema,
  /** Which OAuth client this budget belongs to. Not the secret. */
  clientKeyId: z.string().min(1).max(120),
  remaining: z.number().int().min(0),
  resetAt: timestampSchema.nullable(),
  observedAt: timestampSchema,
  /**
   * Requests handed out but not yet reported back by a response header.
   *
   * Subtracted from `remaining` when deciding whether a call may proceed, so
   * concurrent workers cannot each see the same headroom and all spend it.
   */
  reserved: z.number().int().min(0),
  updatedAt: timestampSchema,
});

export type RedditRateLimitState = z.infer<typeof redditRateLimitStateSchema>;

/* -------------------------------------------------------------------------- */
/* Normalised source metadata                                                  */
/* -------------------------------------------------------------------------- */

/**
 * The named, reviewed subset of a Reddit object that Lia stores.
 *
 * This type is the data-minimisation contract. The repository's standing rule
 * is that `rawPayload` holds the provider response verbatim so a connector
 * change never loses data normalisation did not anticipate — and Reddit is the
 * documented exception. A Reddit object carries far more about a person than
 * Lia has any reason to hold, under retention terms Lia has to honour, so the
 * connector stores this shape and discards the rest rather than keeping a
 * verbatim copy and promising not to look at it.
 */
export const redditSourceMetadataSchema = z.object({
  subreddit: subredditNameSchema,
  /** Reddit's own score. Volatile; refreshed, never trusted as history. */
  score: z.number().int(),
  commentCount: z.number().int().min(0),
  isLocked: z.boolean(),
  isArchived: z.boolean(),
  isNsfw: z.boolean(),
  /** The provider said the author edited it. */
  isEdited: z.boolean(),
  /** Depth below the root post. Zero for the post itself. */
  depth: z.number().int().min(0),
});

export type RedditSourceMetadata = z.infer<typeof redditSourceMetadataSchema>;
