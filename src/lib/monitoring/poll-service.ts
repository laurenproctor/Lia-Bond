import "server-only";

import {
  MAX_ARTICLES_PER_POLL,
  NO_CAPABILITIES,
  REJECTION_RETENTION_MS,
  SYNDICATION_WINDOW_MS,
  type ConnectorCapabilities,
  type MonitoringQuery,
  type NewsPollRun,
  type NewsRejectedCandidate,
  type PlatformConnection,
  type SyncTrigger,
} from "@/domain";
import { recordAuditEvent } from "@/lib/audit/record";
import { PollRunInProgressError } from "@/lib/data/errors";
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
 *    articles.
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

/** A monitoring query has no connection yet, and no person is behind this run. */
const NOT_CONNECTED_MESSAGE =
  "News monitoring is not connected for this organization yet. Poll it manually once to connect it.";

/* -------------------------------------------------------------------------- */
/* The news_media connection                                                  */
/* -------------------------------------------------------------------------- */

const NEWS_CONNECTION_CAPABILITIES: ConnectorCapabilities = {
  ...NO_CAPABILITIES,
  canReadMentions: true,
  canReadFullText: true,
  supportsWebhooks: true,
};

/**
 * Find, or create, the organization's `news_media` connection.
 *
 * `mentions.platform_connection_id` is `not null`, and news has no OAuth flow
 * or credential to hang a connection off (D61) — so it is created implicitly
 * the first time a poll needs the row, one per organization, status
 * `connected`, no credential row (D62).
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
  actorUserId: string | null,
  now: string,
): Promise<PlatformConnection | null> {
  const existing = await dataSource.platformConnections.getByPlatform(scope, "news_media");
  if (existing) return existing;
  if (!actorUserId) return null;

  return dataSource.platformConnections.upsert(scope, {
    platform: "news_media",
    externalAccountId: `news-monitor-${scope.organizationId}`,
    externalAccountName: "News and media monitoring",
    status: "connected",
    capabilities: NEWS_CONNECTION_CAPABILITIES,
    tokenExpiresAt: null,
    grantedScopes: [],
    providerMetadata: {},
    connectedByUserId: actorUserId,
    connectedAt: now,
  });
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

const SKIPPED_OUTCOME: PollOutcome = {
  status: "skipped",
  runId: null,
  accepted: 0,
  rejected: 0,
  candidatesEvaluated: 0,
  requestsSpent: 0,
  errorCode: "poll_in_progress",
};

/** All-zero counters for a run that failed before or during the search. */
function zeroFinishInput(errorCode: string, errorMessage: string) {
  return {
    status: "failed" as const,
    candidatesEvaluated: 0,
    acceptedCount: 0,
    rejectedCount: 0,
    requestsSpent: 0,
    truncated: false,
    gateScoreMin: null,
    gateScoreMean: null,
    gateScoreMax: null,
    errorCode,
    errorMessage,
  };
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
    if (error instanceof PollRunInProgressError) return SKIPPED_OUTCOME;
    throw error;
  }

  // Resolved before spending a request: an unconnected organization should
  // not burn budget on a search whose results could never be stored.
  const connection = await ensureNewsConnection(dataSource, scope, actorUserId, now);
  if (!connection) {
    const finished = await dataSource.newsPollRuns.finish(
      scope,
      run.id,
      zeroFinishInput("not_configured", NOT_CONNECTED_MESSAGE),
    );
    await auditPollRun(dataSource, scope, query, finished, trigger, {
      accepted: 0,
      rejected: 0,
      requestsSpent: 0,
    });
    return {
      status: finished.status,
      runId: finished.id,
      accepted: 0,
      rejected: 0,
      candidatesEvaluated: 0,
      requestsSpent: 0,
      errorCode: finished.errorCode,
    };
  }

  const searchQuery: NewsSearchQuery = {
    keywords: query.keywords,
    exclusions: query.exclusions,
    sourceCountry: query.sourceCountry,
    language: query.language,
    // The incremental cursor (D66). Null on a query's first ever poll.
    publishedAfter: query.lastPolledAt,
    maxResults: MAX_ARTICLES_PER_POLL,
  };

  let batch: NewsSearchBatch;
  try {
    batch = await monitor.search(searchQuery);
  } catch (error) {
    if (!(error instanceof NewsError)) throw error;

    // Never `error.message` — it can quote the provider's response or the
    // request URL, and one of those can contain the API key.
    const finished = await dataSource.newsPollRuns.finish(
      scope,
      run.id,
      zeroFinishInput(error.code, NEWS_ERROR_MESSAGES[error.code]),
    );
    await auditPollRun(dataSource, scope, query, finished, trigger, {
      accepted: 0,
      rejected: 0,
      requestsSpent: 0,
    });
    // The cursor is not advanced: `markPolled` is never reached on this path,
    // so a failed poll is retried from the same `publishedAfter`.
    return {
      status: finished.status,
      runId: finished.id,
      accepted: 0,
      rejected: 0,
      candidatesEvaluated: 0,
      requestsSpent: 0,
      errorCode: finished.errorCode,
    };
  }

  /* ------------------------------------------------------------------------ */
  /* The gate                                                                  */
  /* ------------------------------------------------------------------------ */

  // Seeded from mentions already admitted within the syndication window, then
  // grown in place as this run admits its own candidates — so two syndicated
  // copies arriving in the same batch still collapse to one.
  const priorMentions = await dataSource.mentions.list(scope, {
    sourceTypes: ["news_article"],
    publishedAfter: new Date(nowMs - SYNDICATION_WINDOW_MS).toISOString(),
    limit: 200,
  });
  const recentHeadlines: SeenHeadline[] = priorMentions.map((mention) => ({
    headline: normaliseHeadline(mention.title ?? ""),
    seenAt: mention.publishedAt,
  }));

  const rejections: PendingRejection[] = [];
  const scores: number[] = [];
  let accepted = 0;
  let rejected = 0;

  for (const article of batch.articles) {
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

    accepted += 1;
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

    // Grows the same list `evaluateCandidate` reads, so a second syndicated
    // copy later in this batch is rejected too.
    recentHeadlines.push({
      headline: normaliseHeadline(article.title),
      seenAt: article.publishedAt,
    });
  }

  /* ------------------------------------------------------------------------ */
  /* Close out                                                                 */
  /* ------------------------------------------------------------------------ */

  const evaluated = batch.articles.length;
  const gateScoreMin = scores.length > 0 ? Math.min(...scores) : null;
  const gateScoreMax = scores.length > 0 ? Math.max(...scores) : null;
  const gateScoreMean =
    scores.length > 0
      ? Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 1000) / 1000
      : null;

  // Only a successful search advances the cursor. Both `markPolled` and
  // `finish` are best-effort from here on — the provider was already asked
  // and answered, so a failure past this point is a storage problem, not a
  // reason to re-ask the same question on the next poll.
  await dataSource.monitoringQueries.markPolled(scope, query.id, now);

  // The provider capped the page or sent items that could not be normalised:
  // recorded as `partial` so a truncated poll never reads as a quiet news day.
  const status: NewsPollRun["status"] =
    batch.truncated || batch.malformedCount > 0 ? "partial" : "completed";

  const finished = await dataSource.newsPollRuns.finish(scope, run.id, {
    status,
    candidatesEvaluated: evaluated,
    acceptedCount: accepted,
    rejectedCount: rejected,
    requestsSpent: batch.requestsSpent,
    truncated: batch.truncated,
    gateScoreMin,
    gateScoreMean,
    gateScoreMax,
    errorCode: null,
    errorMessage: null,
  });

  if (rejections.length > 0) {
    await dataSource.newsRejectedCandidates.recordMany(scope, rejections);
  }

  // Runs here, not in its own job: this is the only code path that writes
  // `news_rejected_candidates`, so it cannot fall behind what it is trimming.
  await dataSource.newsRejectedCandidates.purgeOlderThan(
    scope,
    new Date(nowMs - REJECTION_RETENTION_MS).toISOString(),
  );

  await auditPollRun(dataSource, scope, query, finished, trigger, {
    accepted,
    rejected,
    requestsSpent: batch.requestsSpent,
  });

  return {
    status: finished.status,
    runId: finished.id,
    accepted,
    rejected,
    candidatesEvaluated: evaluated,
    requestsSpent: batch.requestsSpent,
    errorCode: null,
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

    const outcome = await pollMonitoringQuery({
      dataSource,
      scope,
      query,
      monitor,
      trigger: "scheduled",
      actorUserId: null,
      now,
    });

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
