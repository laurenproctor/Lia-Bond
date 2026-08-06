import "server-only";

import {
  createMonitoringQueryInputSchema,
  DEFAULT_POLL_INTERVAL_MINUTES,
  DEFAULT_RELEVANCE_THRESHOLD,
  type MonitoringQuery,
  type OnboardingNewsMonitoringInput,
} from "@/domain";
import { diff, recordAuditEvent } from "@/lib/audit/record";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import { createMonitoringQuery } from "@/lib/monitoring/query-service";
import type { NewsMonitor } from "@/news/monitor";

/**
 * The onboarding-managed News query.
 *
 * Step 2 offers one simplified News configuration, backed by the real
 * `monitoring_queries` table — there is no onboarding-only storage. Saving
 * twice must edit the same row rather than accrete "Brand watch", "Brand
 * watch 2", so this module owns the one question the wizard has to answer
 * deterministically: *which* persisted query does onboarding manage?
 *
 * `monitoring_queries` carries no origin column, and adding one for a badge
 * would be a migration in service of bookkeeping. The identification is
 * therefore structural: **the oldest organization-wide brand query** —
 * `queryType = 'brand'` and `locationId IS NULL`, which are persisted,
 * validated fields rather than a display name somebody can edit. That is
 * also semantically the right row to edit: an organization has one brand,
 * and a second organization-wide brand watch is a duplicate whether the
 * wizard or a person created it. A query the user has since renamed, paused,
 * or re-keyed is still that same row, so onboarding edits their version
 * rather than shadowing it with a fresh one. The limitation — a brand query
 * created by hand on the News screen is indistinguishable from one created
 * here — is documented in `docs/onboarding.md`.
 */

/**
 * The persisted query Step 2 edits, or null when the organization has none.
 *
 * Deterministic: oldest `createdAt` wins, id as the tiebreak, so two calls
 * over the same rows always name the same query regardless of list order.
 */
export function findOnboardingNewsQuery(
  queries: readonly MonitoringQuery[],
): MonitoringQuery | null {
  const candidates = queries
    .filter((query) => query.queryType === "brand" && query.locationId === null)
    .sort(
      (a, b) =>
        Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id),
    );
  return candidates[0] ?? null;
}

export interface OnboardingNewsServiceContext {
  dataSource: LiaDataSource;
  scope: OrganizationScope;
}

/**
 * Create or update the onboarding-managed News query.
 *
 * Create goes through the existing `createMonitoringQuery` service, so the
 * implicit `news_media` connection (D80) and the `monitoring_query.created`
 * audit event behave exactly as a save from the News & Media screen would.
 * Update writes through the repository with the same field-diff audit event
 * `updateMonitoringQueryAction` records — one vocabulary, either path.
 *
 * The advanced fields the wizard never shows are filled with the documented
 * defaults on create and **left untouched on update**: somebody who tuned
 * their threshold on the News screen and then revisited Step 2 must not have
 * that tuning silently reset.
 */
export async function saveOnboardingNewsQuery(
  context: OnboardingNewsServiceContext,
  input: OnboardingNewsMonitoringInput,
  monitor: NewsMonitor,
  now: string,
): Promise<MonitoringQuery> {
  const queries = await context.dataSource.monitoringQueries.list(context.scope);
  const existing = findOnboardingNewsQuery(queries);

  if (existing) {
    const updated = await context.dataSource.monitoringQueries.update(
      context.scope,
      existing.id,
      input,
    );

    const changes = diff(existing, updated, [
      "name",
      "keywords",
      "exclusions",
      "sourceCountry",
      "language",
      "enabled",
    ]);
    await recordAuditEvent(context, {
      eventType: "monitoring_query.updated",
      entityType: "monitoring_query",
      entityId: existing.id,
      previousState: changes.previousState,
      newState: changes.newState,
      metadata: { source: "onboarding" },
    });

    return updated;
  }

  // Parsed through the full schema rather than trusted: the merge below is
  // where a wizard default could silently fall out of range as the schema
  // evolves, and this is the line that would catch it.
  const createInput = createMonitoringQueryInputSchema.parse({
    ...input,
    queryType: "brand",
    locationId: null,
    allowedDomains: [],
    deniedDomains: [],
    relevanceThreshold: DEFAULT_RELEVANCE_THRESHOLD,
    pollIntervalMinutes: DEFAULT_POLL_INTERVAL_MINUTES,
  });

  return createMonitoringQuery(context, createInput, monitor, now);
}

/**
 * The truthful Step 2 summary of an organization's News monitoring.
 *
 * Every number is derived from persisted rows. Nothing here estimates,
 * rounds up, or invents: an organization with no queries gets zeros and
 * nulls, and the card renders "Not configured" rather than a placeholder.
 */
export interface NewsMonitoringSummary {
  /** At least one enabled query exists. What the "Configured" badge means. */
  configured: boolean;
  enabledQueryCount: number;
  /** Unique keywords across enabled queries. */
  keywordCount: number;
  /** The shared language, when every enabled query agrees and has one. */
  language: string | null;
  /** The shared source country, when every enabled query agrees and has one. */
  country: string | null;
}

export function summarizeNewsMonitoring(
  queries: readonly MonitoringQuery[],
): NewsMonitoringSummary {
  const enabled = queries.filter((query) => query.enabled);

  const keywords = new Set<string>();
  for (const query of enabled) {
    for (const keyword of query.keywords) keywords.add(keyword);
  }

  return {
    configured: enabled.length > 0,
    enabledQueryCount: enabled.length,
    keywordCount: keywords.size,
    language: consistentValue(enabled.map((query) => query.language)),
    country: consistentValue(enabled.map((query) => query.sourceCountry)),
  };
}

/** The one value everybody set, or null when absent or mixed. */
function consistentValue(values: readonly (string | null)[]): string | null {
  const set = new Set(values);
  if (set.size !== 1) return null;
  return values[0] ?? null;
}

/**
 * When News polling last actually succeeded for any of these queries.
 *
 * Read from `news_poll_runs`, the table the poll service writes — never
 * inferred from a query's own cursor, which advances on partial runs too.
 * Null when nothing has completed, which the card renders as "Not checked
 * yet" rather than a time it cannot prove.
 */
export async function lastSuccessfulNewsPollAt(
  dataSource: LiaDataSource,
  scope: OrganizationScope,
  queries: readonly MonitoringQuery[],
): Promise<string | null> {
  const RECENT_RUNS = 5;

  const perQuery = await Promise.all(
    queries.map((query) => dataSource.newsPollRuns.listForQuery(scope, query.id, RECENT_RUNS)),
  );

  let latest: string | null = null;
  for (const run of perQuery.flat()) {
    if (run.status !== "completed" || run.completedAt === null) continue;
    if (latest === null || Date.parse(run.completedAt) > Date.parse(latest)) {
      latest = run.completedAt;
    }
  }
  return latest;
}
