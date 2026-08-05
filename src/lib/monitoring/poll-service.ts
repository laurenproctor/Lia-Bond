import "server-only";

import {
  MAX_ARTICLES_PER_POLL,
  REJECTION_RETENTION_MS,
  SYNDICATION_WINDOW_MS,
  type MonitoringQuery,
  type NewsPollRun,
  type NewsRejectedCandidate,
  type PlatformConnection,
  type SyncTrigger,
} from "@/domain";
import { recordAuditEvent } from "@/lib/audit/record";
import { DataError, PollRunInProgressError } from "@/lib/data/errors";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import { remainingScheduledRequests } from "@/lib/monitoring/budget";
import {
  evaluateCandidate,
  normaliseHeadline,
  type SeenHeadline,
} from "@/lib/monitoring/gate";
import { NewsError, type NewsErrorCode } from "@/news/errors";
import type { NewsMonitor, NewsSearchBatch, NewsSearchQuery } from "@/news/monitor";

/**
 * Poll orchestration.
 *
 * Everything built in Tasks 1-9 meets here: the lock, the provider call, the
 * gate, the ingest, the budget, and the audit trail. One organization's one
 * monitoring query in, one recorded run out — the same shape `analyzeMentions`
 * (workflow 04) established, applied to a source with no account behind it.
 *
 * Properties the rest of the product depends on, each pinned by a test in
 * `tests/news-poll-service.test.ts`:
 *
 * 1. **The gate never writes `mentions.relevance_score`** (D65). Gate scores
 *    are persisted only on rejections and as min/mean/max on the run.
 * 2. **No provider text reaches a stored row.** A `NewsError` is translated
 *    through a fixed, Lia-authored message map keyed by code.
 * 3. **A failed poll does not advance the cursor.** `markPolled` runs only
 *    after a successful search.
 * 4. **A busy query does not fail a sweep.** `PollRunInProgressError` is
 *    caught and reported as a skipped outcome, never rethrown.
 * 5. **Syndication collapses within one batch**, not just across runs — the
 *    headline list seeded from existing mentions grows as this run admits
 *    articles — but never against the candidate's own prior mention, or a
 *    routine re-poll after a failed one (same window, cursor unmoved) would
 *    reject every article it previously admitted as a "duplicate" of itself.
 * 6. **A run is never orphaned.** From the moment `newsPollRuns.start`
 *    succeeds, exactly one `finish` call closes it, on every path — mirroring
 *    `syncGoogleReviews`'s single outer try/catch — so an unexpected error
 *    (a storage conflict, a schema surprise) is recorded as a failed run
 *    rather than leaving the row `running` and the query's lock held until
 *    the stale window reclaims it.
 */

/* -------------------------------------------------------------------------- */
/* Provider error translation                                                 */
/* -------------------------------------------------------------------------- */

/**
 * Lia's own sentence for each provider failure. Never `error.message`, which
 * can quote a request URL or an API key — the reason this map exists at all.
 */
const NEWS_ERROR_MESSAGES: Record<NewsErrorCode, string> = {
  unauthorized:
    "The news provider rejected Lia's credentials. An administrator needs to check the configuration.",
  rate_limited:
    "The news provider's daily limit was reached. Lia will try again on the next scheduled poll.",
  quota_exhausted:
    "Lia's own daily request budget was reached before this query could run.",
  provider_error:
    "The news provider is temporarily unavailable. Lia will try again on the next scheduled poll.",
  invalid_query:
    "The news provider rejected this query's search terms. Check the keywords and exclusions.",
  not_configured: "News monitoring is not configured for this environment.",
};

/**
 * A monitoring query has no connection yet, and no person is behind this run.
 *
 * Its own code, `not_connected`, distinct from `NewsError`'s `not_configured`
 * (no API key in the environment): an operator filtering run history by code
 * needs to tell "add a GNews key" from "poll this query once by hand" apart.
 */
const NOT_CONNECTED_CODE = "not_connected";
const NOT_CONNECTED_MESSAGE =
  "News monitoring is not connected for this organization yet. Poll it manually once to connect it.";

/** Cap on stored error text, matching the column and `syncGoogleReviews`'s. */
const MAX_ERROR_LENGTH = 400;

/** A normalised code for the run record. Lia's own vocabulary throughout. */
function codeFor(error: unknown): string {
  if (error instanceof NewsError) return error.code;
  if (error instanceof DataError) return error.code;
  return "unknown";
}

function messageFor(error: unknown): string {
  if (error instanceof NewsError) return NEWS_ERROR_MESSAGES[error.code];
  if (error instanceof DataError) return error.message;
  return "Lia could not finish polling this query. Try again shortly.";
}

/* -------------------------------------------------------------------------- */
/* The news_media connection                                                  */
/* -------------------------------------------------------------------------- */

/**
 * Find, or create, the organization's `news_media` connection.
 *
 * `mentions.platform_connection_id` is `not null`, and news has no OAuth flow
 * or credential to hang a connection off (D61) — so it is created implicitly
 * the first time a poll needs the row, one per organization, status
 * `connected`, no credential row (D62). Capabilities come from
 * `monitor.capabilities()`, never a hand-written guess — the same "whatever
 * the connector honestly claims today" rule `connectGoogleAccount` follows,
 * so the integrations screen never advertises full-text reading or webhooks a
 * free-tier search API does not have.
 *
 * Attribution needs a real person: `connectedByUserId` is not nullable, and
 * the system actor sentinel used under cron must never reach a foreign key
 * (D70). A scheduled poll that finds no connection and no human behind it
 * cannot create one — it returns `null`, and the caller finishes the run as
 * failed rather than inventing an owner.
 */
async function ensureNewsConnection(
  dataSource: LiaDataSource,
  scope: OrganizationScope,
  monitor: NewsMonitor,
  actorUserId: string | null,
  now: string,
): Promise<PlatformConnection | null> {
  const existing = await dataSource.platformConnections.getByPlatform(scope, "news_media");
  if (existing) return existing;
  if (!actorUserId) return null;

  const created = await dataSource.platformConnections.upsert(scope, {
    platform: "news_media",
    externalAccountId: `news-monitor-${scope.organizationId}`,
    externalAccountName: "News and media monitoring",
    status: "connected",
    capabilities: monitor.capabilities(),
    tokenExpiresAt: null,
    grantedScopes: [],
    providerMetadata: {},
    connectedByUserId: actorUserId,
    connectedAt: now,
  });

  // Every other connection creation records one (`connectGoogleAccount`); a
  // `news_media` row appearing on the integrations screen with no audit trail
  // of who created it or when would be the one silent exception.
  await recordAuditEvent(
    { dataSource, scope },
    {
      eventType: "integration.connected",
      entityType: "platform_connection",
      entityId: created.id,
      previousState: null,
      newState: {
        platform: "news_media",
        externalAccountId: created.externalAccountId,
      },
      metadata: {},
      actorType: "user",
    },
  );

  return created;
}

/* -------------------------------------------------------------------------- */
/* One query                                                                   */
/* -------------------------------------------------------------------------- */

export interface PollMonitoringQueryOptions {
  dataSource: LiaDataSource;
  scope: OrganizationScope;
  query: MonitoringQuery;
  monitor: NewsMonitor;
  trigger: SyncTrigger;
  /** Null on a scheduled run — no person is behind it. */
  actorUserId: string | null;
  now: string;
}

export interface PollOutcome {
  status: NewsPollRun["status"] | "skipped";
  /** Null only when the run never opened — a lock conflict. */
  runId: string | null;
  accepted: number;
  rejected: number;
  candidatesEvaluated: number;
  requestsSpent: number;
  errorCode: string | null;
}

/** A fresh object per call — nothing shared for a caller to mutate. */
function skippedOutcome(): PollOutcome {
  return {
    status: "skipped",
    runId: null,
    accepted: 0,
    rejected: 0,
    candidatesEvaluated: 0,
    requestsSpent: 0,
    errorCode: "poll_in_progress",
  };
}

/**
 * A headline already admitted, carrying the mention's own external id.
 *
 * `SeenHeadline` (the gate's own type) has no id: it is a syndication
 * signature, not a record. This wrapper exists only so the candidate's own
 * prior mention can be filtered out before the gate ever sees the list — see
 * the note on syndication self-exclusion below.
 */
interface TrackedHeadline extends SeenHeadline {
  externalId: string;
}

/**
 * Record what this run did.
 *
 * Attributed to the query rather than to any article it touched, and
 * deliberately thin: counts, a normalised error code, and the query id.
 * Never a title, a URL, or a publisher name — the metadata a reviewer of the
 * audit trail is never meant to learn from this event.
 */
async function auditPollRun(
  dataSource: LiaDataSource,
  scope: OrganizationScope,
  query: MonitoringQuery,
  run: NewsPollRun,
  trigger: SyncTrigger,
  counts: { accepted: number; rejected: number; requestsSpent: number },
): Promise<void> {
  await recordAuditEvent(
    { dataSource, scope },
    {
      eventType: run.status === "failed" ? "monitoring_query.poll_failed" : "monitoring_query.polled",
      entityType: "monitoring_query",
      entityId: query.id,
      previousState: null,
      newState: { status: run.status },
      metadata: {
        trigger,
        candidatesEvaluated: run.candidatesEvaluated,
        accepted: counts.accepted,
        rejected: counts.rejected,
        requestsSpent: counts.requestsSpent,
        truncated: run.truncated,
        errorCode: run.errorCode ?? "",
      },
      // A scheduled run has no person behind it; attributing one would be a
      // lie in the audit trail, the same reasoning `analyzeMentions` applies.
      actorType: trigger === "manual" ? "user" : "system",
    },
  );
}

type PendingRejection = Omit<
  NewsRejectedCandidate,
  "id" | "organizationId" | "createdAt" | "updatedAt"
>;

export async function pollMonitoringQuery(
  options: PollMonitoringQueryOptions,
): Promise<PollOutcome> {
  const { dataSource, scope, query, monitor, trigger, actorUserId, now } = options;
  const nowMs = Date.parse(now);

  let run: NewsPollRun;
  try {
    run = await dataSource.newsPollRuns.start(scope, {
      monitoringQueryId: query.id,
      trigger,
      actorUserId,
    });
  } catch (error) {
    // Losing this race is the system working, not a failure — a scheduled
    // sweep must not die because one query is already being polled. No run
    // row exists to report, so this stays out of the audit trail entirely,
    // the same way a refused analysis-run start does.
    if (error instanceof PollRunInProgressError) return skippedOutcome();
    throw error;
  }

  // From here on, every path funnels through exactly one `finish` call below
  // — mirroring `syncGoogleReviews`'s single outer try/catch. An unexpected
  // throw inside this block must become a failed run, not an orphaned one
  // still holding `news_poll_runs_one_active`.
  let runFailed = false;
  let errorCode: string | null = null;
  let errorMessage: string | null = null;

  const rejections: PendingRejection[] = [];
  const scores: number[] = [];
  let accepted = 0;
  let rejected = 0;
  let evaluated = 0;
  let requestsSpent = 0;
  let truncated = false;
  let malformedCount = 0;

  try {
    // Resolved before spending a request: an unconnected organization should
    // not burn budget on a search whose results could never be stored.
    const connection = await ensureNewsConnection(dataSource, scope, monitor, actorUserId, now);

    if (!connection) {
      runFailed = true;
      errorCode = NOT_CONNECTED_CODE;
      errorMessage = NOT_CONNECTED_MESSAGE;
    } else {
      const searchQuery: NewsSearchQuery = {
        keywords: query.keywords,
        exclusions: query.exclusions,
        sourceCountry: query.sourceCountry,
        language: query.language,
        // The incremental cursor (D66). Null on a query's first ever poll.
        publishedAfter: query.lastPolledAt,
        maxResults: MAX_ARTICLES_PER_POLL,
      };

      let batch: NewsSearchBatch | null = null;
      try {
        batch = await monitor.search(searchQuery);
      } catch (error) {
        // Never `error.message` — it can quote the provider's response or
        // the request URL, and one of those can contain the API key.
        if (!(error instanceof NewsError)) throw error;
        runFailed = true;
        errorCode = error.code;
        errorMessage = NEWS_ERROR_MESSAGES[error.code];
      }

      if (batch) {
        requestsSpent = batch.requestsSpent;
        truncated = batch.truncated;
        malformedCount = batch.malformedCount;
        evaluated = batch.articles.length;

        /* ------------------------------------------------------------------ */
        /* The gate                                                            */
        /* ------------------------------------------------------------------ */

        // Seeded from mentions already admitted within the syndication
        // window, then grown in place as this run admits its own candidates
        // — so two syndicated copies arriving in the same batch still
        // collapse to one. Bounded by `mentionFilterSchema`'s hard ceiling
        // (200): an organization admitting more than 200 news mentions in a
        // single 72-hour window would lose syndication detection against the
        // overflow. Not reachable at today's volumes.
        const priorMentions = await dataSource.mentions.list(scope, {
          sourceTypes: ["news_article"],
          publishedAfter: new Date(nowMs - SYNDICATION_WINDOW_MS).toISOString(),
          limit: 200,
        });
        const trackedHeadlines: TrackedHeadline[] = priorMentions.map((mention) => ({
          headline: normaliseHeadline(mention.title ?? ""),
          seenAt: mention.publishedAt,
          externalId: mention.externalId,
        }));

        for (const article of batch.articles) {
          try {
            // Excludes the candidate's own prior mention before the gate
            // ever sees the list. Without this, an article re-fetched
            // inside its own syndication window — the routine case after a
            // failed poll left the cursor unmoved — matches its own earlier
            // headline and rejects itself as "probable syndication" of
            // itself, and `mentions.ingest` is never reached to refresh it.
            const recentHeadlines: SeenHeadline[] = trackedHeadlines
              .filter((seen) => seen.externalId !== article.externalId)
              .map(({ headline, seenAt }) => ({ headline, seenAt }));

            const verdict = evaluateCandidate(article, { query, now, recentHeadlines });
            scores.push(verdict.score);

            if (!verdict.admitted) {
              rejected += 1;
              rejections.push({
                monitoringQueryId: query.id,
                newsPollRunId: run.id,
                externalId: article.externalId,
                url: article.url,
                title: article.title,
                publisherDomain: article.publisherDomain ?? "",
                reason: verdict.reason,
                score: verdict.score,
                publishedAt: article.publishedAt,
              });
              continue;
            }

            await dataSource.mentions.ingest(scope, {
              locationId: query.locationId,
              platformConnectionId: connection.id,
              platformProfileId: null,
              sourceType: "news_article",
              externalId: article.externalId,
              externalParentId: null,
              sourceUrl: article.url,
              title: article.title,
              content: article.description ?? article.title,
              authorName: article.authorName,
              authorExternalId: null,
              // News carries no star rating.
              rating: null,
              language: article.language,
              publishedAt: article.publishedAt,
              // The named fields above carry everything Lia uses; a verbatim
              // provider payload would duplicate it in an unmanaged copy.
              rawPayload: {},
              externalResourceName: null,
              authorAvatarUrl: null,
              authorIsAnonymous: false,
              sourceUpdatedAt: null,
              sourceReplyText: null,
              sourceReplyUpdatedAt: null,
              sourceMetadata: {},
              syncedAt: now,
              publisherName: article.publisherName,
              publisherDomain: article.publisherDomain,
              monitoringQueryId: query.id,
            });

            // Only counted once storage actually succeeds.
            accepted += 1;

            // Grows the same list `evaluateCandidate` reads, so a second
            // syndicated copy later in this batch is rejected too.
            trackedHeadlines.push({
              headline: normaliseHeadline(article.title),
              seenAt: article.publishedAt,
              externalId: article.externalId,
            });
          } catch {
            // One candidate's failure — a storage conflict, a schema
            // surprise the normaliser's own bounds did not anticipate — must
            // not cost the batch its others, the same reasoning
            // `syncGoogleReviews` applies per review. Neither accepted nor
            // rejected: the gate reached no stored verdict for it, so
            // `evaluated` and `accepted + rejected` disagreeing is the
            // honest record of what happened, in the absence of a counter
            // `news_poll_runs` has no column for.
          }
        }

        // Only a successful search reaches here, and only a query that
        // reaches here advances its cursor.
        await dataSource.monitoringQueries.markPolled(scope, query.id, now);
      }
    }
  } catch (error) {
    runFailed = true;
    errorCode = codeFor(error);
    errorMessage = messageFor(error).slice(0, MAX_ERROR_LENGTH);
  }

  /* -------------------------------------------------------------------------- */
  /* Close out — unconditional from here, exactly once                          */
  /* -------------------------------------------------------------------------- */

  if (rejections.length > 0) {
    try {
      await dataSource.newsRejectedCandidates.recordMany(scope, rejections);
    } catch (error) {
      // Recorded before `finish`, not after: if this throws, the run must
      // not close as a success with rejections it never actually stored.
      runFailed = true;
      errorCode = codeFor(error);
      errorMessage = messageFor(error).slice(0, MAX_ERROR_LENGTH);
    }
  }

  try {
    // Runs here, not in its own job: this is the only code path that writes
    // `news_rejected_candidates`, so it cannot fall behind what it is
    // trimming. Best-effort — a retention failure must not turn an
    // otherwise-successful poll into a failed one.
    await dataSource.newsRejectedCandidates.purgeOlderThan(
      scope,
      new Date(nowMs - REJECTION_RETENTION_MS).toISOString(),
    );
  } catch {
    // Swallowed deliberately; see comment above.
  }

  const gateScoreMin = scores.length > 0 ? Math.min(...scores) : null;
  const gateScoreMax = scores.length > 0 ? Math.max(...scores) : null;
  const gateScoreMean =
    scores.length > 0
      ? Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 1000) / 1000
      : null;

  // The provider capped the page, sent items that could not be normalised,
  // or something failed after the search succeeded: recorded as `partial` so
  // a degraded poll never reads as either a quiet news day or a clean run.
  const status: NewsPollRun["status"] = runFailed
    ? "failed"
    : truncated || malformedCount > 0
      ? "partial"
      : "completed";

  const finished = await dataSource.newsPollRuns.finish(scope, run.id, {
    status,
    candidatesEvaluated: evaluated,
    acceptedCount: accepted,
    rejectedCount: rejected,
    requestsSpent,
    truncated,
    gateScoreMin,
    gateScoreMean,
    gateScoreMax,
    errorCode,
    errorMessage,
  });

  await auditPollRun(dataSource, scope, query, finished, trigger, {
    accepted,
    rejected,
    requestsSpent,
  });

  return {
    status: finished.status,
    runId: finished.id,
    accepted,
    rejected,
    candidatesEvaluated: evaluated,
    requestsSpent,
    errorCode: finished.errorCode,
  };
}

/* -------------------------------------------------------------------------- */
/* The sweep                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Stands in for a real user on the one write path with no session behind it.
 *
 * Cron holds no membership, so it cannot construct a verified
 * `OrganizationScope` the way `getOrganizationContext()` does for every other
 * caller (D70). This sentinel exists only to satisfy `OrganizationScope`'s
 * `userId: string` — widening that field to `string | null` would weaken the
 * tenancy type for every call site in the codebase to accommodate this one.
 *
 * It must never reach the database: `public.users` has no row for it, so an
 * audit event or a connection carrying it as a foreign key would fail. The
 * scheduled path records audit with `actorType: "system"` and
 * `actorUserId: null` instead, and `ensureNewsConnection` refuses to create a
 * connection when `actorUserId` (not `scope.userId`) is null.
 */
export const SYSTEM_ACTOR_ID = "00000000-0000-0000-0000-000000000000";

export interface PollDueQueriesOptions {
  dataSource: LiaDataSource;
  monitor: NewsMonitor;
  now: string;
  limit: number;
}

export interface PollSweepOutcome {
  polled: number;
  accepted: number;
  rejected: number;
  /** Queries that were due but never attempted because the budget ran out. */
  skippedForBudget: number;
}

/**
 * Poll every query whose interval has elapsed, across every tenant.
 *
 * Stops as soon as `remainingScheduledRequests` is exhausted and reports the
 * unpolled remainder rather than silently truncating the sweep, so "8 of 40
 * queries polled" cannot be read as full coverage (D67).
 */
export async function pollDueQueries(
  options: PollDueQueriesOptions,
): Promise<PollSweepOutcome> {
  const { dataSource, monitor, now, limit } = options;
  const due = await dataSource.monitoringQueries.listDue(now, limit);

  let polled = 0;
  let accepted = 0;
  let rejected = 0;

  for (let index = 0; index < due.length; index += 1) {
    const remaining = await remainingScheduledRequests(dataSource, now);
    if (remaining <= 0) {
      return { polled, accepted, rejected, skippedForBudget: due.length - index };
    }

    const query = due[index]!;
    const scope: OrganizationScope = {
      organizationId: query.organizationId,
      userId: SYSTEM_ACTOR_ID,
      role: "owner",
    };

    let outcome: PollOutcome;
    try {
      outcome = await pollMonitoringQuery({
        dataSource,
        scope,
        query,
        monitor,
        trigger: "scheduled",
        actorUserId: null,
        now,
      });
    } catch {
      // `pollMonitoringQuery` closes its own run on every path it knows
      // about; this is the backstop for the path it does not — one query's
      // unexpected failure must not abort a sweep touching every other
      // tenant's queries too.
      continue;
    }

    // A lock conflict means another process is already polling this query,
    // not that this sweep failed to reach it — it does not count against
    // coverage, and the budget it would have spent was never spent.
    if (outcome.status === "skipped") continue;

    polled += 1;
    accepted += outcome.accepted;
    rejected += outcome.rejected;
  }

  return { polled, accepted, rejected, skippedForBudget: 0 };
}
