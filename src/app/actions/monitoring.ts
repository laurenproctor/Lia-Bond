"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import {
  createMonitoringQueryInputSchema,
  updateMonitoringQueryInputSchema,
  uuidSchema,
  type MonitoringQuery,
} from "@/domain";
import { authorize } from "@/lib/actions/guard";
import { runAction, type ActionResult } from "@/lib/actions/result";
import { diff, recordAuditEvent } from "@/lib/audit/record";
import { DataError, notFound } from "@/lib/data/errors";
import type { OrganizationScope, LiaDataSource } from "@/lib/data/types";
import { NEWS_ERROR_MESSAGES, pollMonitoringQuery, type PollOutcome } from "@/lib/monitoring/poll-service";
import { createMonitoringQuery } from "@/lib/monitoring/query-service";
import { NewsError } from "@/news/errors";
import type { NewsMonitor } from "@/news/monitor";
import { getNewsMonitor } from "@/news/registry";

/**
 * Monitoring-query server actions.
 *
 * Thin, like `automation.ts` and `locations.ts`: authorise, touch the
 * repository, audit, revalidate. Creation is the one exception — it also has
 * to provision the organization's `news_media` connection the first time,
 * which is why it delegates to `createMonitoringQuery` in `query-service.ts`
 * rather than calling the repository directly, the same split
 * `syncGoogleReviewsAction` makes for `syncGoogleReviews`.
 */

const MONITORING_PATH = "/integrations/news-media";

const queryIdSchema = z.object({ queryId: uuidSchema });

const updateMonitoringQuerySchema = z
  .object({ queryId: uuidSchema })
  .extend(updateMonitoringQueryInputSchema.shape);

/**
 * Resolve the news monitor, translating a `NewsError` into Lia's own
 * sentence for its code.
 *
 * Never `error.message` — `NewsError` is provider-facing vocabulary, and one
 * of its codes (`unauthorized`) exists specifically because a raw provider
 * message can quote a request URL or a key.
 */
function resolveMonitor(): NewsMonitor {
  try {
    return getNewsMonitor();
  } catch (error) {
    if (error instanceof NewsError) {
      throw new DataError("unavailable", NEWS_ERROR_MESSAGES[error.code]);
    }
    throw error;
  }
}

/**
 * Resolve a caller-supplied `locationId` through the caller's own scope
 * before it is bound to a monitoring query.
 *
 * RLS on `monitoring_queries` checks `organization_id` only, and the foreign
 * key to `locations` does not enforce same-organization — so without this,
 * org A can bind a query to org B's location id, and every mention that
 * query ingests would inherit it. `locations.get()` filters by the caller's
 * scope the same way `updateLocationManagerAction`
 * (`src/app/actions/locations.ts`) already resolves a caller-supplied
 * location before trusting it; this is the same check, made mandatory here
 * because `monitoringQueries` is new in this branch and had never had it.
 */
async function assertLocationInScope(
  dataSource: LiaDataSource,
  scope: OrganizationScope,
  locationId: string | null,
): Promise<void> {
  if (locationId === null) return;
  const location = await dataSource.locations.get(scope, locationId);
  if (!location) throw notFound("Location");
}

/* -------------------------------------------------------------------------- */
/* Create                                                                      */
/* -------------------------------------------------------------------------- */

export async function createMonitoringQueryAction(
  input: unknown,
): Promise<ActionResult<MonitoringQuery>> {
  return runAction("monitoring.manage_queries", async () => {
    const parsed = createMonitoringQueryInputSchema.parse(input);
    const context = await authorize("monitoring.manage_queries");
    await assertLocationInScope(context.dataSource, context.scope, parsed.locationId);
    const monitor = resolveMonitor();

    const created = await createMonitoringQuery(
      context,
      parsed,
      monitor,
      new Date().toISOString(),
    );

    revalidatePath(MONITORING_PATH);
    return created;
  });
}

/* -------------------------------------------------------------------------- */
/* Update                                                                      */
/* -------------------------------------------------------------------------- */

export async function updateMonitoringQueryAction(
  input: unknown,
): Promise<ActionResult<MonitoringQuery>> {
  return runAction("monitoring.manage_queries", async () => {
    const { queryId, ...fields } = updateMonitoringQuerySchema.parse(input);
    const context = await authorize("monitoring.manage_queries");

    // `locationId` is optional on an update (the field may be absent
    // entirely, meaning "leave it alone"). Only validate when the caller
    // actually supplied one — `undefined` skips the check, `null` (clearing
    // to organization-wide) short-circuits inside the helper.
    if (fields.locationId !== undefined) {
      await assertLocationInScope(context.dataSource, context.scope, fields.locationId);
    }

    const existing = await context.dataSource.monitoringQueries.get(context.scope, queryId);
    if (!existing) throw notFound("Monitoring query");

    const updated = await context.dataSource.monitoringQueries.update(
      context.scope,
      queryId,
      fields,
    );

    const changes = diff(existing, updated, [
      "name",
      "queryType",
      "keywords",
      "exclusions",
      "allowedDomains",
      "deniedDomains",
      "sourceCountry",
      "language",
      "relevanceThreshold",
      "enabled",
      "pollIntervalMinutes",
      "locationId",
    ]);
    await recordAuditEvent(context, {
      eventType: "monitoring_query.updated",
      entityType: "monitoring_query",
      entityId: queryId,
      previousState: changes.previousState,
      newState: changes.newState,
      metadata: {},
    });

    revalidatePath(MONITORING_PATH);
    return updated;
  });
}

/* -------------------------------------------------------------------------- */
/* Delete                                                                      */
/* -------------------------------------------------------------------------- */

export async function deleteMonitoringQueryAction(
  input: unknown,
): Promise<ActionResult<{ queryId: string }>> {
  return runAction("monitoring.manage_queries", async () => {
    const { queryId } = queryIdSchema.parse(input);
    const context = await authorize("monitoring.manage_queries");

    const existing = await context.dataSource.monitoringQueries.get(context.scope, queryId);
    if (!existing) throw notFound("Monitoring query");

    await context.dataSource.monitoringQueries.remove(context.scope, queryId);

    await recordAuditEvent(context, {
      eventType: "monitoring_query.deleted",
      entityType: "monitoring_query",
      entityId: queryId,
      previousState: { name: existing.name, queryType: existing.queryType },
      newState: null,
      metadata: {},
    });

    revalidatePath(MONITORING_PATH);
    return { queryId };
  });
}

/* -------------------------------------------------------------------------- */
/* Poll now                                                                    */
/* -------------------------------------------------------------------------- */

export interface ManualPollOutcome {
  status: string;
  runId: string | null;
  accepted: number;
  rejected: number;
  candidatesEvaluated: number;
  errorCode: string | null;
  /** What to tell the user. Never a provider's own words. */
  message: string;
  /** True when the outcome needs the amber treatment rather than the green. */
  degraded: boolean;
}

export async function pollMonitoringQueryAction(
  input: unknown,
): Promise<ActionResult<ManualPollOutcome>> {
  return runAction("monitoring.poll_now", async () => {
    const { queryId } = queryIdSchema.parse(input);
    const context = await authorize("monitoring.poll_now");

    const query = await context.dataSource.monitoringQueries.get(context.scope, queryId);
    if (!query) throw notFound("Monitoring query");

    const monitor = resolveMonitor();

    const outcome = await pollMonitoringQuery({
      dataSource: context.dataSource,
      scope: context.scope,
      query,
      monitor,
      trigger: "manual",
      actorUserId: context.userId,
      now: new Date().toISOString(),
    });

    revalidatePath(MONITORING_PATH);

    return {
      status: outcome.status,
      runId: outcome.runId,
      accepted: outcome.accepted,
      rejected: outcome.rejected,
      candidatesEvaluated: outcome.candidatesEvaluated,
      errorCode: outcome.errorCode,
      message: describePollOutcome(outcome),
      degraded: outcome.status !== "completed",
    };
  });
}

/**
 * One sentence about what a manual poll did.
 *
 * `pollMonitoringQuery` already computed Lia's own wording for whatever went
 * wrong (`outcome.errorMessage`) and records its own audit event — this only
 * describes the happy path, the same split `describeSyncOutcome` and
 * `describeAnalysisOutcome` make for their services.
 */
function describePollOutcome(outcome: PollOutcome): string {
  if (outcome.status === "skipped" || outcome.status === "failed") {
    return (
      outcome.errorMessage ?? "Lia could not poll this query. Try again shortly."
    );
  }

  const parts = [`${outcome.accepted} new article${outcome.accepted === 1 ? "" : "s"}`];
  if (outcome.rejected > 0) parts.push(`${outcome.rejected} filtered out`);
  const summary = `Found ${parts.join(", ")}.`;

  if (outcome.status === "partial") {
    return `${summary} ${outcome.errorMessage ?? "Some parts of this poll did not complete."}`;
  }
  return summary;
}
