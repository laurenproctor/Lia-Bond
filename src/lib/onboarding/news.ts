import "server-only";

import {
  createMonitoringQueryInputSchema,
  DEFAULT_POLL_INTERVAL_MINUTES,
  DEFAULT_RELEVANCE_THRESHOLD,
  MAX_MONITORING_QUERY_NAME_LENGTH,
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
 * The identification is the persisted `origin` column first — the exact
 * marker, written when the wizard creates a query — with a structural
 * fallback for rows that predate it: **the oldest organization-wide brand
 * query** (`queryType = 'brand'`, `locationId IS NULL`), persisted and
 * validated fields rather than a display name somebody can edit. The
 * fallback is also semantically right: an organization has one brand, and a
 * second organization-wide brand watch is a duplicate whether the wizard or
 * a person created it — so a hand-created brand query is *adopted* (edited)
 * rather than shadowed with a fresh row. A query the user has since renamed,
 * paused, or re-keyed is still that same row.
 */

/**
 * The persisted query Step 2 edits, or null when the organization has none.
 *
 * Candidates are organization-wide brand queries; among them the wizard's
 * own (`origin: "onboarding"`) wins outright, then the oldest by
 * `createdAt`, id as the tiebreak — so two calls over the same rows always
 * name the same query regardless of list order. An onboarding-created query
 * that a person has since rebound to a location or retyped is no longer a
 * candidate: it stopped being an organization-wide brand watch, and editing
 * it from the wizard would undo their decision.
 */
export function findOnboardingNewsQuery(
  queries: readonly MonitoringQuery[],
): MonitoringQuery | null {
  const candidates = queries
    .filter((query) => query.queryType === "brand" && query.locationId === null)
    .sort(
      (a, b) =>
        Number(b.origin === "onboarding") - Number(a.origin === "onboarding") ||
        Date.parse(a.createdAt) - Date.parse(b.createdAt) ||
        a.id.localeCompare(b.id),
    );
  return candidates[0] ?? null;
}

const WATCH_SUFFIX = " watch";
/** Used only when a subject has no usable name, which the schemas forbid. */
const FALLBACK_WATCH_NAME = "Brand watch";

/**
 * What a generated monitoring query is called: the subject's own name, plus
 * "watch".
 *
 * The brand query takes the organization's name, and step 3's location
 * queries take the location's — one rule, so an organization's queries read
 * as a set ("Ember & Oak watch", "Ember & Oak Soho watch") instead of the
 * generic "Brand watch" nobody would recognise in a list.
 *
 * Names are longer than a query name may be (160 against
 * `MAX_MONITORING_QUERY_NAME_LENGTH`), so a long one is shortened on the
 * subject and never on the suffix: cutting the composed string would leave
 * "Some Very Long Restaurant Group Incorpo" with no indication of what the
 * row is.
 */
export function watchQueryName(subject: string): string {
  const name = subject.trim();
  if (name.length === 0) return FALLBACK_WATCH_NAME;

  const composed = `${name}${WATCH_SUFFIX}`;
  if (composed.length <= MAX_MONITORING_QUERY_NAME_LENGTH) return composed;

  const room = MAX_MONITORING_QUERY_NAME_LENGTH - WATCH_SUFFIX.length;
  return `${name.slice(0, room).trimEnd()}${WATCH_SUFFIX}`;
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

    // An event only when something moved. Under the configurator's autosave
    // nobody presses anything, so a write that changes no field is not a
    // decision somebody made — it is a timer firing, and recording it would
    // put an entry saying nothing into an append-only trail that can never be
    // cleaned up. Every event that survives this still carries its real
    // before-and-after, so the chain stays continuous.
    if (Object.keys(changes.newState).length > 0) {
      await recordAuditEvent(context, {
        eventType: "monitoring_query.updated",
        entityType: "monitoring_query",
        entityId: existing.id,
        previousState: changes.previousState,
        newState: changes.newState,
        metadata: { source: "onboarding" },
      });
    }

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
    origin: "onboarding",
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
 * What step 3's best-effort location-query pass did, for logging.
 */
export interface LocationQueryOutcome {
  created: number;
  skipped: number;
  failed: number;
}

/**
 * Create one News query per newly configured location — safely, or not at
 * all.
 *
 * Runs after step 3 maps or creates locations, and only when the
 * organization opted into News monitoring at step 2: an **enabled**
 * onboarding-managed brand query is the opt-in signal. Without one, this
 * creates nothing — somebody who skipped the News card must not find
 * monitoring queries (and an implicit `news_media` connection) they never
 * asked for.
 *
 * The idempotence and no-overwrite rules, in order of precedence:
 *
 * - A location that already has *any* location-bound query is skipped —
 *   whether a person created it or a previous run of this pass did. This is
 *   what makes a retried step-3 submission safe, and what guarantees a
 *   user-edited or user-paused query is never touched, re-enabled, or
 *   duplicated: existing rows are never written at all.
 * - Each location id is resolved through the caller's scope before use, the
 *   same rule `assertLocationInScope` enforces on the public action.
 * - Keywords are the location's persisted name, plus its persisted city when
 *   that adds a distinct term. Nothing invented.
 * - Language and country are inherited from the brand query, so the
 *   organization's queries agree; everything else takes the documented
 *   defaults, `origin: "onboarding"`.
 *
 * Failures are per location and never propagate: the locations step has
 * already succeeded, and a monitoring-query hiccup must not un-succeed it.
 */
export async function ensureOnboardingLocationQueries(
  context: OnboardingNewsServiceContext,
  locationIds: readonly string[],
  monitor: NewsMonitor,
  now: string,
): Promise<LocationQueryOutcome> {
  const outcome: LocationQueryOutcome = { created: 0, skipped: 0, failed: 0 };
  if (locationIds.length === 0) return outcome;

  const queries = await context.dataSource.monitoringQueries.list(context.scope);
  const brand = findOnboardingNewsQuery(queries);
  if (!brand || !brand.enabled) {
    outcome.skipped = locationIds.length;
    return outcome;
  }

  const covered = new Set(
    queries
      .map((query) => query.locationId)
      .filter((locationId): locationId is string => locationId !== null),
  );

  for (const locationId of new Set(locationIds)) {
    if (covered.has(locationId)) {
      outcome.skipped += 1;
      continue;
    }

    try {
      const location = await context.dataSource.locations.get(context.scope, locationId);
      if (!location) {
        outcome.skipped += 1;
        continue;
      }

      const keywords = [location.name];
      const city = location.city.trim();
      if (city.length >= 2 && !keywords.includes(city)) keywords.push(city);

      const createInput = createMonitoringQueryInputSchema.parse({
        name: watchQueryName(location.name),
        queryType: "location",
        locationId: location.id,
        keywords,
        exclusions: [],
        allowedDomains: [],
        deniedDomains: [],
        sourceCountry: brand.sourceCountry,
        language: brand.language,
        relevanceThreshold: DEFAULT_RELEVANCE_THRESHOLD,
        pollIntervalMinutes: DEFAULT_POLL_INTERVAL_MINUTES,
        enabled: true,
        origin: "onboarding",
      });

      await createMonitoringQuery(context, createInput, monitor, now);
      covered.add(location.id);
      outcome.created += 1;
    } catch (error) {
      console.error("[onboarding:news] location query not created", error);
      outcome.failed += 1;
    }
  }

  return outcome;
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
