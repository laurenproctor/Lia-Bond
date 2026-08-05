import {
  createMonitoringQueryInputSchema,
  monitoringQuerySchema,
  newsPollRunSchema,
  newsRejectedCandidateSchema,
  updateMonitoringQueryInputSchema,
  type MonitoringQuery,
  type NewsPollRun,
  type NewsRejectedCandidate,
} from "@/domain";
import { notFound, PollRunInProgressError } from "@/lib/data/errors";
import { demoRuntimeStore, replaceRow, scoped } from "@/lib/data/demo/store";
import {
  POLL_RUN_STALE_AFTER_MS,
  type MonitoringQueryRepository,
  type NewsPollRunRepository,
  type NewsRejectedCandidateRepository,
  type OrganizationScope,
} from "@/lib/data/types";
import { REFERENCE_NOW } from "@/lib/seed/clock";
import { seedId } from "@/lib/seed/ids";

/**
 * The demo adapter for news monitoring.
 *
 * Its own file rather than another few hundred lines in `demo/index.ts`,
 * which is already the largest module in the data layer. Filters, ordering,
 * and the poll lock mirror the Supabase adapter's behaviour deliberately —
 * see `PlatformSyncRunRepository` in `types.ts`, which this was modelled on.
 */

function nowIso(): string {
  // Demo mode runs on the seed clock so timestamps stay reproducible.
  return REFERENCE_NOW;
}

/** Rows the caller is entitled to see, for one table. */
function orgRows<T extends { organizationId: string }>(
  rows: T[],
  scope: OrganizationScope,
): T[] {
  return scoped(rows, scope.organizationId);
}

export function createMonitoringRepositories(): {
  monitoringQueries: MonitoringQueryRepository;
  newsPollRuns: NewsPollRunRepository;
  newsRejectedCandidates: NewsRejectedCandidateRepository;
} {
  return {
    monitoringQueries: {
      async list(scope) {
        return orgRows(demoRuntimeStore().monitoringQueries, scope).sort((a, b) =>
          a.name.localeCompare(b.name),
        );
      },

      async get(scope, queryId) {
        return (
          orgRows(demoRuntimeStore().monitoringQueries, scope).find(
            (row) => row.id === queryId,
          ) ?? null
        );
      },

      async create(scope, input) {
        const value = createMonitoringQueryInputSchema.parse(input);
        const runtime = demoRuntimeStore();
        runtime.monitoringQuerySequence += 1;

        const created: MonitoringQuery = monitoringQuerySchema.parse({
          ...value,
          id: seedId(
            `monitoring-query:${scope.organizationId}:${runtime.monitoringQuerySequence}`,
          ),
          organizationId: scope.organizationId,
          lastPolledAt: null,
          createdAt: nowIso(),
          updatedAt: nowIso(),
        });

        runtime.monitoringQueries.push(created);
        return created;
      },

      async update(scope, queryId, input) {
        const existing = orgRows(demoRuntimeStore().monitoringQueries, scope).find(
          (row) => row.id === queryId,
        );
        if (!existing) throw notFound("Monitoring query");

        const value = updateMonitoringQueryInputSchema.parse(input);
        const updated: MonitoringQuery = monitoringQuerySchema.parse({
          ...existing,
          ...value,
          updatedAt: nowIso(),
        });

        return replaceRow(demoRuntimeStore().monitoringQueries, updated);
      },

      async remove(scope, queryId) {
        const runtime = demoRuntimeStore();
        const existing = orgRows(runtime.monitoringQueries, scope).find(
          (row) => row.id === queryId,
        );
        if (!existing) throw notFound("Monitoring query");

        const keep = runtime.monitoringQueries.filter((row) => row.id !== queryId);
        runtime.monitoringQueries.length = 0;
        runtime.monitoringQueries.push(...keep);
      },

      async markPolled(scope, queryId, polledAt) {
        const existing = orgRows(demoRuntimeStore().monitoringQueries, scope).find(
          (row) => row.id === queryId,
        );
        if (!existing) throw notFound("Monitoring query");

        const updated: MonitoringQuery = {
          ...existing,
          lastPolledAt: polledAt,
          updatedAt: nowIso(),
        };
        return replaceRow(demoRuntimeStore().monitoringQueries, updated);
      },

      // Deliberately unscoped — see the doc comment on `listDue` in types.ts.
      // Cron holds no membership and cannot construct a scope, so this is the
      // one read in the repository layer that spans every tenant.
      async listDue(now, limit) {
        const nowMs = Date.parse(now);

        return demoRuntimeStore()
          .monitoringQueries.filter((row) => {
            if (!row.enabled) return false;
            if (row.lastPolledAt === null) return true;
            return Date.parse(row.lastPolledAt) + row.pollIntervalMinutes * 60_000 <= nowMs;
          })
          .sort((a, b) => {
            // Never-polled queries are the oldest possible cursor, so they sort first.
            const aTime = a.lastPolledAt === null ? -Infinity : Date.parse(a.lastPolledAt);
            const bTime = b.lastPolledAt === null ? -Infinity : Date.parse(b.lastPolledAt);
            return aTime - bTime;
          })
          .slice(0, limit);
      },
    },

    newsPollRuns: {
      async start(scope, input) {
        const runtime = demoRuntimeStore();
        const now = nowIso();
        const nowMs = Date.parse(now);

        const active = runtime.newsPollRuns.find(
          (row) =>
            row.monitoringQueryId === input.monitoringQueryId && row.status === "running",
        );

        if (active) {
          const startedMs = Date.parse(active.startedAt);
          const isStale = !Number.isFinite(startedMs) || nowMs - startedMs > POLL_RUN_STALE_AFTER_MS;

          // A run abandoned by a process that died must not block the query
          // forever, so a stale one is closed rather than honoured. Mirrors
          // the reclaim the Supabase adapter performs against the unique index.
          if (!isStale) {
            throw new PollRunInProgressError(active.monitoringQueryId);
          }

          replaceRow(runtime.newsPollRuns, {
            ...active,
            status: "failed",
            completedAt: now,
            errorCode: "stale_reclaimed",
            errorMessage:
              "This poll stopped without finishing. It was closed so a new one could start.",
            updatedAt: now,
          });
        }

        runtime.newsPollRunSequence += 1;
        const created: NewsPollRun = newsPollRunSchema.parse({
          id: seedId(
            `news-poll-run:${input.monitoringQueryId}:${runtime.newsPollRunSequence}`,
          ),
          organizationId: scope.organizationId,
          monitoringQueryId: input.monitoringQueryId,
          trigger: input.trigger,
          actorUserId: input.actorUserId,
          status: "running",
          startedAt: now,
          completedAt: null,
          candidatesEvaluated: 0,
          acceptedCount: 0,
          rejectedCount: 0,
          requestsSpent: 0,
          truncated: false,
          gateScoreMin: null,
          gateScoreMean: null,
          gateScoreMax: null,
          errorCode: null,
          errorMessage: null,
          createdAt: now,
          updatedAt: now,
        });

        runtime.newsPollRuns.push(created);
        return created;
      },

      async finish(scope, runId, input) {
        const runtime = demoRuntimeStore();
        const run = orgRows(runtime.newsPollRuns, scope).find((row) => row.id === runId);
        if (!run) throw notFound("Poll run");

        // Idempotent in effect: finishing a finished run is a no-op.
        if (run.status !== "running") return run;

        const now = nowIso();
        const updated: NewsPollRun = newsPollRunSchema.parse({
          ...run,
          ...input,
          completedAt: now,
          updatedAt: now,
        });

        return replaceRow(runtime.newsPollRuns, updated);
      },

      async listForQuery(scope, queryId, limit) {
        const rows = orgRows(demoRuntimeStore().newsPollRuns, scope)
          .filter((row) => row.monitoringQueryId === queryId)
          .sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));

        return limit === undefined ? rows : rows.slice(0, limit);
      },

      // Deliberately unscoped — see the doc comment on `requestsSpentSince` in
      // types.ts. The provider request budget is Lia's own resource, shared
      // across every tenant, not a per-tenant quota.
      async requestsSpentSince(since) {
        const sinceMs = Date.parse(since);
        return demoRuntimeStore()
          .newsPollRuns.filter((row) => Date.parse(row.startedAt) >= sinceMs)
          .reduce((sum, row) => sum + row.requestsSpent, 0);
      },
    },

    newsRejectedCandidates: {
      async recordMany(scope, candidates) {
        const runtime = demoRuntimeStore();
        const now = nowIso();

        for (const candidate of candidates) {
          runtime.newsRejectedCandidateSequence += 1;
          const created: NewsRejectedCandidate = newsRejectedCandidateSchema.parse({
            ...candidate,
            id: seedId(
              `news-rejected:${scope.organizationId}:${runtime.newsRejectedCandidateSequence}`,
            ),
            organizationId: scope.organizationId,
            createdAt: now,
            updatedAt: now,
          });
          runtime.newsRejectedCandidates.push(created);
        }
      },

      async listForQuery(scope, queryId, limit) {
        const rows = orgRows(demoRuntimeStore().newsRejectedCandidates, scope)
          .filter((row) => row.monitoringQueryId === queryId)
          .sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));

        return limit === undefined ? rows : rows.slice(0, limit);
      },

      async purgeOlderThan(scope, before) {
        const runtime = demoRuntimeStore();
        const cutoff = Date.parse(before);
        let removed = 0;

        const keep = runtime.newsRejectedCandidates.filter((row) => {
          if (row.organizationId !== scope.organizationId) return true;
          if (Date.parse(row.createdAt) < cutoff) {
            removed += 1;
            return false;
          }
          return true;
        });

        runtime.newsRejectedCandidates.length = 0;
        runtime.newsRejectedCandidates.push(...keep);
        return removed;
      },
    },
  };
}
