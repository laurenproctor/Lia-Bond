import "server-only";

import type { SupabaseClient } from "@supabase/supabase-js";
import {
  createMonitoringQueryInputSchema,
  updateMonitoringQueryInputSchema,
} from "@/domain";
import { conflict, DataError, notFound, PollRunInProgressError } from "@/lib/data/errors";
import {
  POLL_RUN_STALE_AFTER_MS,
  type MonitoringQueryRepository,
  type NewsPollRunRepository,
  type NewsRejectedCandidateRepository,
  type OrganizationScope,
} from "@/lib/data/types";
import { createSupabaseServiceClient } from "@/lib/supabase/server";
import {
  toMonitoringQuery,
  toNewsPollRun,
  toNewsRejectedCandidate,
} from "@/lib/data/supabase/mappers";

/**
 * The Supabase adapter for news monitoring.
 *
 * Its own file rather than more lines in `supabase/index.ts`, which is
 * already the largest module in the data layer — see the equivalent
 * decision for the demo adapter in `demo/monitoring.ts`, which this mirrors
 * behaviourally. `platformSyncRuns` in `index.ts` is the closest analogue
 * for the run-locking shape; the `23505` → typed-error translation here
 * follows the same idea, applied to `PollRunInProgressError`.
 *
 * NOTE: this adapter has not been executed against a live database, for the
 * same reason noted at the top of `index.ts`.
 */

type Row = Record<string, unknown>;

/**
 * `rows` and `fail` are duplicated from `index.ts` rather than imported from
 * it. `index.ts` imports `createMonitoringRepositories` from this file to
 * wire it into the returned data source, so importing back from `index.ts`
 * would be a circular module dependency. Both copies are a handful of lines
 * and change together only if PostgREST's error shape does.
 */
function rows(data: unknown): Row[] {
  return Array.isArray(data) ? (data as Row[]) : [];
}

/** Turn a PostgREST error into a domain error without leaking driver detail. */
function fail(error: { message: string; code?: string }, action: string): never {
  if (error.code === "23505") {
    throw conflict("That record already exists.");
  }
  if (error.code === "42501" || error.code === "PGRST301") {
    throw new DataError("forbidden", "You don't have permission to do that.");
  }
  throw new DataError("unavailable", `Could not ${action}. Please try again.`);
}

export function createMonitoringRepositories(client: SupabaseClient): {
  monitoringQueries: MonitoringQueryRepository;
  newsPollRuns: NewsPollRunRepository;
  newsRejectedCandidates: NewsRejectedCandidateRepository;
} {
  /** Base selector for an organization-owned table. */
  const from = (table: string, scope: OrganizationScope) =>
    client.from(table).select("*").eq("organization_id", scope.organizationId);

  /**
   * The privileged client, built on first use.
   *
   * `listDue` and `requestsSpentSince` span every tenant — cron holds no
   * membership and cannot construct an `OrganizationScope` — so RLS would
   * return an empty result for them under any user session. Built lazily so
   * a deployment with no service-role key still runs everything else, same
   * as the equivalent lazy client in `index.ts`.
   */
  let privileged: SupabaseClient | null = null;
  const serviceClient = (): SupabaseClient => {
    privileged ??= createSupabaseServiceClient();
    return privileged;
  };

  return {
    monitoringQueries: {
      async list(scope) {
        const { data, error } = await from("monitoring_queries", scope).order("name");
        if (error) fail(error, "load monitoring queries");
        return rows(data).map(toMonitoringQuery);
      },

      async get(scope, queryId) {
        const { data, error } = await from("monitoring_queries", scope)
          .eq("id", queryId)
          .maybeSingle();

        if (error) fail(error, "load the monitoring query");
        return data ? toMonitoringQuery(data as Row) : null;
      },

      async create(scope, input) {
        const value = createMonitoringQueryInputSchema.parse(input);

        const { data, error } = await client
          .from("monitoring_queries")
          .insert({
            organization_id: scope.organizationId,
            location_id: value.locationId,
            name: value.name,
            query_type: value.queryType,
            keywords: value.keywords,
            exclusions: value.exclusions,
            allowed_domains: value.allowedDomains,
            denied_domains: value.deniedDomains,
            source_country: value.sourceCountry,
            language: value.language,
            relevance_threshold: value.relevanceThreshold,
            enabled: value.enabled,
            poll_interval_minutes: value.pollIntervalMinutes,
          })
          .select("*")
          .single();

        if (error) fail(error, "create the monitoring query");
        return toMonitoringQuery(data as Row);
      },

      async update(scope, queryId, input) {
        const value = updateMonitoringQueryInputSchema.parse(input);

        // Only the fields the caller actually supplied are written. `value`
        // is a `Partial`, so building the patch by omitted-if-undefined
        // keeps an unset field from clobbering the stored one with null.
        const patch: Row = {};
        if (value.locationId !== undefined) patch.location_id = value.locationId;
        if (value.name !== undefined) patch.name = value.name;
        if (value.queryType !== undefined) patch.query_type = value.queryType;
        if (value.keywords !== undefined) patch.keywords = value.keywords;
        if (value.exclusions !== undefined) patch.exclusions = value.exclusions;
        if (value.allowedDomains !== undefined) patch.allowed_domains = value.allowedDomains;
        if (value.deniedDomains !== undefined) patch.denied_domains = value.deniedDomains;
        if (value.sourceCountry !== undefined) patch.source_country = value.sourceCountry;
        if (value.language !== undefined) patch.language = value.language;
        if (value.relevanceThreshold !== undefined) {
          patch.relevance_threshold = value.relevanceThreshold;
        }
        if (value.enabled !== undefined) patch.enabled = value.enabled;
        if (value.pollIntervalMinutes !== undefined) {
          patch.poll_interval_minutes = value.pollIntervalMinutes;
        }

        const { data, error } = await client
          .from("monitoring_queries")
          .update(patch)
          .eq("organization_id", scope.organizationId)
          .eq("id", queryId)
          .select("*")
          .maybeSingle();

        if (error) fail(error, "update the monitoring query");
        if (!data) throw notFound("Monitoring query");
        return toMonitoringQuery(data as Row);
      },

      async remove(scope, queryId) {
        const { data, error } = await client
          .from("monitoring_queries")
          .delete()
          .eq("organization_id", scope.organizationId)
          .eq("id", queryId)
          .select("id")
          .maybeSingle();

        if (error) fail(error, "remove the monitoring query");
        if (!data) throw notFound("Monitoring query");
      },

      async markPolled(scope, queryId, polledAt) {
        const { data, error } = await client
          .from("monitoring_queries")
          .update({ last_polled_at: polledAt })
          .eq("organization_id", scope.organizationId)
          .eq("id", queryId)
          .select("*")
          .maybeSingle();

        if (error) fail(error, "update the poll cursor");
        if (!data) throw notFound("Monitoring query");
        return toMonitoringQuery(data as Row);
      },

      // Deliberately unscoped and run under the service-role client — see the
      // doc comment on `listDue` in types.ts and on `serviceClient` above.
      async listDue(now, limit) {
        const nowMs = Date.parse(now);

        const { data, error } = await serviceClient()
          .from("monitoring_queries")
          .select("*")
          .eq("enabled", true)
          .order("last_polled_at", { ascending: true, nullsFirst: true });

        if (error) fail(error, "load queries due for polling");

        // `lastPolledAt + pollIntervalMinutes <= now` compares two columns on
        // the same row, which PostgREST has no filter for, so the due check
        // happens here — same as the demo adapter. The order-by above still
        // does the useful part: rows arrive oldest-cursor-first, matching
        // `monitoring_queries_due_idx`, so the slice below is a true "most
        // overdue first" cut rather than an arbitrary one.
        return rows(data)
          .map(toMonitoringQuery)
          .filter(
            (query) =>
              query.lastPolledAt === null ||
              Date.parse(query.lastPolledAt) + query.pollIntervalMinutes * 60_000 <= nowMs,
          )
          .slice(0, limit);
      },
    },

    newsPollRuns: {
      /**
       * Open a run.
       *
       * The lock is `news_poll_runs_one_active`, a partial unique index on
       * `monitoring_query_id` where `status = 'running'`. A stale run (one
       * left `running` by a process that died) is reclaimed first, in a
       * single conditional `UPDATE` scoped to exactly that row shape — not a
       * read-then-write check, which two concurrent reclaims could both
       * pass. The insert that follows is then the whole of the concurrency
       * control: a second concurrent start gets a `23505`.
       */
      async start(scope, input) {
        // The scope filter is what stops a caller opening a poll run against
        // another organization's monitoring query by supplying its id —
        // RLS would also refuse the eventual insert, but this refuses it
        // with a clear message, the same guard `platformSyncRuns.start`
        // applies against `platform_profiles`.
        const { data: query, error: queryError } = await from(
          "monitoring_queries",
          scope,
        )
          .eq("id", input.monitoringQueryId)
          .maybeSingle();

        if (queryError) fail(queryError, "start the poll");
        if (!query) throw notFound("Monitoring query");

        const startedAt = new Date().toISOString();
        const staleBefore = new Date(Date.now() - POLL_RUN_STALE_AFTER_MS).toISOString();

        const { error: reclaimError } = await client
          .from("news_poll_runs")
          .update({
            status: "failed",
            completed_at: startedAt,
            error_code: "stale_reclaimed",
            error_message:
              "This poll stopped without finishing. It was closed so a new one could start.",
          })
          .eq("organization_id", scope.organizationId)
          .eq("monitoring_query_id", input.monitoringQueryId)
          .eq("status", "running")
          .lt("started_at", staleBefore);

        if (reclaimError) fail(reclaimError, "start the poll");

        const { data, error } = await client
          .from("news_poll_runs")
          .insert({
            organization_id: scope.organizationId,
            monitoring_query_id: input.monitoringQueryId,
            trigger: input.trigger,
            actor_user_id: input.actorUserId,
            status: "running",
            started_at: startedAt,
          })
          .select("*")
          .single();

        if (!error) return toNewsPollRun(data as Row);
        if (error.code !== "23505") fail(error, "start the poll");

        // The lock rejected the insert. Look up the run holding it so the
        // caller has an id to point at.
        const { data: active, error: activeError } = await from(
          "news_poll_runs",
          scope,
        )
          .eq("monitoring_query_id", input.monitoringQueryId)
          .eq("status", "running")
          .maybeSingle();

        if (activeError) fail(activeError, "start the poll");
        if (!active) {
          // The unique index rejected the insert but no running row is
          // visible: the only benign explanation is that it finished between
          // the two statements. Vanishingly unlikely, and there is no run id
          // left to report, so this collapses to a generic conflict rather
          // than a fabricated one.
          throw conflict("A poll is already running for this monitoring query.");
        }

        throw new PollRunInProgressError(String(active.id), input.monitoringQueryId);
      },

      async finish(scope, runId, input) {
        const { data, error } = await client
          .from("news_poll_runs")
          .update({
            status: input.status,
            completed_at: new Date().toISOString(),
            candidates_evaluated: input.candidatesEvaluated,
            accepted_count: input.acceptedCount,
            rejected_count: input.rejectedCount,
            requests_spent: input.requestsSpent,
            truncated: input.truncated,
            gate_score_min: input.gateScoreMin,
            gate_score_mean: input.gateScoreMean,
            gate_score_max: input.gateScoreMax,
            error_code: input.errorCode,
            error_message: input.errorMessage,
          })
          .eq("organization_id", scope.organizationId)
          .eq("id", runId)
          .select("*")
          .maybeSingle();

        if (error) fail(error, "record the poll result");
        if (!data) throw notFound("Poll run");
        return toNewsPollRun(data as Row);
      },

      async listForQuery(scope, queryId, limit) {
        let query = from("news_poll_runs", scope)
          .eq("monitoring_query_id", queryId)
          .order("started_at", { ascending: false });

        if (limit !== undefined) query = query.limit(limit);

        const { data, error } = await query;
        if (error) fail(error, "load the poll history");
        return rows(data).map(toNewsPollRun);
      },

      // Deliberately unscoped and run under the service-role client — see
      // the doc comment on `requestsSpentSince` in types.ts and on
      // `serviceClient` above. The provider request budget is Lia's own
      // resource, shared across every tenant, not a per-tenant quota (D67).
      async requestsSpentSince(since) {
        const { data, error } = await serviceClient()
          .from("news_poll_runs")
          .select("requests_spent")
          .gte("started_at", since);

        if (error) fail(error, "load the request budget");
        return rows(data).reduce(
          (sum, row) => sum + Number(row.requests_spent ?? 0),
          0,
        );
      },
    },

    newsRejectedCandidates: {
      async recordMany(scope, candidates) {
        // Short-circuit rather than issuing an insert with no rows, which
        // PostgREST would otherwise accept as a no-op — but only after a
        // round trip this method has no reason to make.
        if (candidates.length === 0) return;

        const queryIds = [...new Set(candidates.map((c) => c.monitoringQueryId))];
        const { data: owned, error: ownedError } = await client
          .from("monitoring_queries")
          .select("id")
          .eq("organization_id", scope.organizationId)
          .in("id", queryIds);

        if (ownedError) fail(ownedError, "record the rejected articles");

        const ownedIds = new Set(rows(owned).map((row) => String(row.id)));
        // The scope filter is what stops a caller recording a rejection
        // against another organization's monitoring query by supplying its
        // id — the same guard `newsPollRuns.start` applies.
        for (const id of queryIds) {
          if (!ownedIds.has(id)) throw notFound("Monitoring query");
        }

        const { error } = await client.from("news_rejected_candidates").insert(
          candidates.map((candidate) => ({
            organization_id: scope.organizationId,
            monitoring_query_id: candidate.monitoringQueryId,
            news_poll_run_id: candidate.newsPollRunId,
            external_id: candidate.externalId,
            url: candidate.url,
            title: candidate.title,
            publisher_domain: candidate.publisherDomain,
            reason: candidate.reason,
            score: candidate.score,
            published_at: candidate.publishedAt,
          })),
        );

        if (error) fail(error, "record the rejected articles");
      },

      async listForQuery(scope, queryId, limit) {
        let query = from("news_rejected_candidates", scope)
          .eq("monitoring_query_id", queryId)
          .order("published_at", { ascending: false });

        if (limit !== undefined) query = query.limit(limit);

        const { data, error } = await query;
        if (error) fail(error, "load the rejected articles");
        return rows(data).map(toNewsRejectedCandidate);
      },

      async purgeOlderThan(scope, before) {
        const { count, error } = await client
          .from("news_rejected_candidates")
          .delete({ count: "exact" })
          .eq("organization_id", scope.organizationId)
          .lt("created_at", before);

        if (error) fail(error, "purge old rejected articles");
        return count ?? 0;
      },
    },
  };
}
