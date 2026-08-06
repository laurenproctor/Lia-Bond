import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  createMonitoringQueryInputSchema,
  DEFAULT_POLL_INTERVAL_MINUTES,
  DEFAULT_RELEVANCE_THRESHOLD,
  NO_CAPABILITIES,
  onboardingNewsMonitoringInputSchema,
  updateMonitoringQueryInputSchema,
  type MonitoringQuery,
} from "@/domain";
import { getConnector } from "@/integrations/registry";
import { ConfigurationError } from "@/lib/env";
import {
  ensureOnboardingLocationQueries,
  findOnboardingNewsQuery,
  lastSuccessfulNewsPollAt,
  saveOnboardingNewsQuery,
  summarizeNewsMonitoring,
} from "@/lib/onboarding/news";
import { LOC_HARBOR_HOUSE, LOC_SOHO, MQ_HARBOR_BRAND } from "@/lib/seed/dataset";
import type { NewsMonitor } from "@/news/monitor";
import { freshDataSource, harbor, ushg } from "./helpers/scope";

/**
 * Step 2's three-source model: the truthfulness rules.
 *
 * The News side must ride the real monitoring-query architecture — one
 * organization-wide brand query that repeated saves edit rather than
 * duplicate, counts derived from persisted rows, defaults that satisfy the
 * real schema. The Reddit side must reflect the fact that no Reddit provider
 * exists in this repository: the capability check here asks the actual
 * connector registry, and the source assertions hold the card to showing
 * nothing a persisted operational record cannot back.
 */

const NOW = "2026-08-06T12:00:00.000Z";

function fakeMonitor(): NewsMonitor {
  return {
    platform: "news_media",
    capabilities: () => ({ ...NO_CAPABILITIES, canReadMentions: true }),
    search: async () => ({
      articles: [],
      requestsSpent: 0,
      truncated: false,
      malformedCount: 0,
    }),
  };
}

const SAVE_INPUT = {
  name: "Brand watch",
  keywords: ["Harbor & Vine", "Harbor House"],
  exclusions: ["harbor freight"],
  sourceCountry: "us",
  language: "en",
  enabled: true,
};

function source(relativePath: string): string {
  return readFileSync(join(process.cwd(), relativePath), "utf8");
}

/** The file with its comments removed, for assertions about rendered output. */
function code(relativePath: string): string {
  return source(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\{\/\*[\s\S]*?\*\/\}/g, "")
    .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

/* -------------------------------------------------------------------------- */
/* Choosing the onboarding-managed query                                       */
/* -------------------------------------------------------------------------- */

describe("findOnboardingNewsQuery", () => {
  function query(overrides: Partial<MonitoringQuery>): MonitoringQuery {
    return {
      id: "00000000-0000-4000-8000-000000000001",
      organizationId: "00000000-0000-4000-8000-0000000000aa",
      locationId: null,
      name: "Brand watch",
      queryType: "brand",
      keywords: ["Acme"],
      exclusions: [],
      allowedDomains: [],
      deniedDomains: [],
      sourceCountry: "us",
      language: "en",
      relevanceThreshold: 0.35,
      enabled: true,
      pollIntervalMinutes: 240,
      origin: "user",
      lastPolledAt: null,
      createdAt: "2026-08-01T00:00:00.000Z",
      updatedAt: "2026-08-01T00:00:00.000Z",
      ...overrides,
    };
  }

  it("picks the oldest organization-wide brand query", () => {
    const older = query({
      id: "00000000-0000-4000-8000-000000000002",
      createdAt: "2026-07-01T00:00:00.000Z",
    });
    const newer = query({ id: "00000000-0000-4000-8000-000000000003" });

    expect(findOnboardingNewsQuery([newer, older])?.id).toBe(older.id);
    // Order of the input list must not change the answer.
    expect(findOnboardingNewsQuery([older, newer])?.id).toBe(older.id);
  });

  it("breaks a created-at tie deterministically, by id", () => {
    const a = query({ id: "00000000-0000-4000-8000-00000000000a" });
    const b = query({ id: "00000000-0000-4000-8000-00000000000b" });
    expect(findOnboardingNewsQuery([b, a])?.id).toBe(a.id);
    expect(findOnboardingNewsQuery([a, b])?.id).toBe(a.id);
  });

  it("never picks a location-bound or non-brand query", () => {
    const locationBound = query({
      id: "00000000-0000-4000-8000-000000000004",
      locationId: "00000000-0000-4000-8000-0000000000bb",
    });
    const topic = query({
      id: "00000000-0000-4000-8000-000000000005",
      queryType: "topic",
    });

    expect(findOnboardingNewsQuery([locationBound, topic])).toBeNull();
  });

  it("identifies by persisted structure, not by display name", () => {
    // A renamed brand query is still the onboarding-managed one: editing it
    // is what stops a second "Brand watch" appearing beside it.
    const renamed = query({ name: "Something my admin typed" });
    expect(findOnboardingNewsQuery([renamed])?.id).toBe(renamed.id);
  });

  it("prefers the persisted origin marker over age", () => {
    // The exact marker beats the structural heuristic: the wizard's own
    // query wins even when a hand-created brand query is older.
    const older = query({
      id: "00000000-0000-4000-8000-000000000006",
      createdAt: "2026-06-01T00:00:00.000Z",
    });
    const wizards = query({
      id: "00000000-0000-4000-8000-000000000007",
      origin: "onboarding",
    });
    expect(findOnboardingNewsQuery([older, wizards])?.id).toBe(wizards.id);
  });

  it("drops a wizard query the user rebound or retyped", () => {
    // Rebinding to a location, or changing the type, is a person's decision;
    // the wizard must not keep editing that row over it.
    const rebound = query({
      id: "00000000-0000-4000-8000-000000000008",
      origin: "onboarding",
      locationId: "00000000-0000-4000-8000-0000000000cc",
    });
    expect(findOnboardingNewsQuery([rebound])).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Saving through the real architecture                                        */
/* -------------------------------------------------------------------------- */

describe("saveOnboardingNewsQuery", () => {
  it("creates one organization-scoped query and provisions the news connection", async () => {
    const dataSource = freshDataSource();
    const scope = harbor.owner();
    // Harbor's seeded brand query is removed so this exercises the true
    // first-save path of a brand-new organization.
    await dataSource.monitoringQueries.remove(scope, MQ_HARBOR_BRAND);
    expect(await dataSource.platformConnections.getByPlatform(scope, "news_media")).toBeNull();

    const created = await saveOnboardingNewsQuery(
      { dataSource, scope },
      SAVE_INPUT,
      fakeMonitor(),
      NOW,
    );

    expect(created.organizationId).toBe(scope.organizationId);
    expect(created.keywords).toEqual(SAVE_INPUT.keywords);
    expect(created.exclusions).toEqual(SAVE_INPUT.exclusions);
    expect(created.sourceCountry).toBe("us");
    expect(created.language).toBe("en");

    // The implicit news_media connection, exactly as a save from the News &
    // Media screen would provision it.
    const connection = await dataSource.platformConnections.getByPlatform(scope, "news_media");
    expect(connection?.status).toBe("connected");
    expect(connection?.connectedByUserId).toBe(scope.userId);
  });

  it("fills the advanced fields with the documented defaults on create", async () => {
    const dataSource = freshDataSource();
    const scope = harbor.owner();
    await dataSource.monitoringQueries.remove(scope, MQ_HARBOR_BRAND);

    const created = await saveOnboardingNewsQuery(
      { dataSource, scope },
      SAVE_INPUT,
      fakeMonitor(),
      NOW,
    );

    expect(created.queryType).toBe("brand");
    expect(created.origin).toBe("onboarding");
    expect(created.locationId).toBeNull();
    expect(created.allowedDomains).toEqual([]);
    expect(created.deniedDomains).toEqual([]);
    expect(created.relevanceThreshold).toBe(DEFAULT_RELEVANCE_THRESHOLD);
    expect(created.pollIntervalMinutes).toBe(DEFAULT_POLL_INTERVAL_MINUTES);
  });

  it("keeps those defaults inside the real monitoring schema", () => {
    const merged = createMonitoringQueryInputSchema.parse({
      ...onboardingNewsMonitoringInputSchema.parse(SAVE_INPUT),
      queryType: "brand",
      locationId: null,
      allowedDomains: [],
      deniedDomains: [],
      relevanceThreshold: DEFAULT_RELEVANCE_THRESHOLD,
      pollIntervalMinutes: DEFAULT_POLL_INTERVAL_MINUTES,
    });
    expect(merged.enabled).toBe(true);
  });

  it("updates the existing brand query on a repeated save rather than duplicating", async () => {
    const dataSource = freshDataSource();
    const scope = harbor.owner();
    await dataSource.monitoringQueries.remove(scope, MQ_HARBOR_BRAND);

    const first = await saveOnboardingNewsQuery(
      { dataSource, scope },
      SAVE_INPUT,
      fakeMonitor(),
      NOW,
    );
    const second = await saveOnboardingNewsQuery(
      { dataSource, scope },
      { ...SAVE_INPUT, keywords: ["Harbor & Vine", "Harbor House", "Sofia Reyes"] },
      fakeMonitor(),
      NOW,
    );

    expect(second.id).toBe(first.id);
    const all = await dataSource.monitoringQueries.list(scope);
    expect(all.filter((query) => query.queryType === "brand" && query.locationId === null)).toHaveLength(1);
    expect(second.keywords).toContain("Sofia Reyes");
  });

  it("edits a pre-existing brand query instead of shadowing it", async () => {
    // Harbor's seed already has an organization-wide brand query. A save from
    // onboarding must land on it, not beside it.
    const dataSource = freshDataSource();
    const scope = harbor.owner();

    const before = await dataSource.monitoringQueries.list(scope);
    const saved = await saveOnboardingNewsQuery(
      { dataSource, scope },
      SAVE_INPUT,
      fakeMonitor(),
      NOW,
    );

    expect(saved.id).toBe(MQ_HARBOR_BRAND);
    const after = await dataSource.monitoringQueries.list(scope);
    expect(after).toHaveLength(before.length);
  });

  it("leaves user-tuned advanced fields alone on update", async () => {
    const dataSource = freshDataSource();
    const scope = harbor.owner();

    await dataSource.monitoringQueries.update(scope, MQ_HARBOR_BRAND, {
      relevanceThreshold: 0.6,
      allowedDomains: ["eater.com"],
    });

    const saved = await saveOnboardingNewsQuery(
      { dataSource, scope },
      SAVE_INPUT,
      fakeMonitor(),
      NOW,
    );

    expect(saved.relevanceThreshold).toBe(0.6);
    expect(saved.allowedDomains).toEqual(["eater.com"]);
  });

  it("records the audit trail for both paths", async () => {
    const dataSource = freshDataSource();
    const scope = harbor.owner();

    await saveOnboardingNewsQuery({ dataSource, scope }, SAVE_INPUT, fakeMonitor(), NOW);
    const events = await dataSource.auditEvents.list(scope, { limit: 100 });
    const updated = events.find(
      (event) =>
        event.eventType === "monitoring_query.updated" &&
        event.entityId === MQ_HARBOR_BRAND,
    );
    expect(updated).toBeDefined();
    expect(updated?.metadata).toMatchObject({ source: "onboarding" });

    await dataSource.monitoringQueries.remove(scope, MQ_HARBOR_BRAND);
    const created = await saveOnboardingNewsQuery(
      { dataSource, scope },
      SAVE_INPUT,
      fakeMonitor(),
      NOW,
    );
    const createdEvent = (await dataSource.auditEvents.list(scope, { limit: 100 })).find(
      (event) =>
        event.eventType === "monitoring_query.created" && event.entityId === created.id,
    );
    expect(createdEvent).toBeDefined();
  });

  it("cannot reach another organization's queries", async () => {
    const dataSource = freshDataSource();

    // A save under Harbor's scope must not touch USHG's rows, whatever the
    // list happens to contain.
    const ushgBefore = await dataSource.monitoringQueries.list(ushg.owner());
    await saveOnboardingNewsQuery(
      { dataSource, scope: harbor.owner() },
      SAVE_INPUT,
      fakeMonitor(),
      NOW,
    );
    const ushgAfter = await dataSource.monitoringQueries.list(ushg.owner());

    expect(ushgAfter).toEqual(ushgBefore);
  });

  it("refuses input the monitoring schema refuses", () => {
    expect(
      onboardingNewsMonitoringInputSchema.safeParse({ ...SAVE_INPUT, keywords: [] }).success,
    ).toBe(false);
    expect(
      onboardingNewsMonitoringInputSchema.safeParse({ ...SAVE_INPUT, keywords: ["a"] })
        .success,
    ).toBe(false);
    expect(
      onboardingNewsMonitoringInputSchema.safeParse({
        ...SAVE_INPUT,
        sourceCountry: "usa",
      }).success,
    ).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Location queries after step 3                                               */
/* -------------------------------------------------------------------------- */

describe("ensureOnboardingLocationQueries", () => {
  it("creates one query per uncovered location, inheriting the brand query's market", async () => {
    const dataSource = freshDataSource();
    const scope = harbor.owner();

    const outcome = await ensureOnboardingLocationQueries(
      { dataSource, scope },
      [LOC_HARBOR_HOUSE],
      fakeMonitor(),
      NOW,
    );

    expect(outcome).toEqual({ created: 1, skipped: 0, failed: 0 });
    const queries = await dataSource.monitoringQueries.list(scope);
    const locationQuery = queries.find((query) => query.locationId === LOC_HARBOR_HOUSE);
    expect(locationQuery).toBeDefined();
    expect(locationQuery?.queryType).toBe("location");
    expect(locationQuery?.origin).toBe("onboarding");
    // The persisted location's own name and city — nothing invented.
    expect(locationQuery?.name).toBe("Harbor House watch");
    expect(locationQuery?.keywords).toEqual(["Harbor House", "San Francisco"]);
    // Inherited from the seeded brand query, so the organization's queries
    // agree on where and in which language to search.
    const brand = queries.find((query) => query.id === MQ_HARBOR_BRAND);
    expect(locationQuery?.sourceCountry).toBe(brand?.sourceCountry);
    expect(locationQuery?.language).toBe(brand?.language);
  });

  it("is idempotent: a retried step 3 creates nothing new", async () => {
    const dataSource = freshDataSource();
    const scope = harbor.owner();

    await ensureOnboardingLocationQueries({ dataSource, scope }, [LOC_HARBOR_HOUSE], fakeMonitor(), NOW);
    const second = await ensureOnboardingLocationQueries(
      { dataSource, scope },
      [LOC_HARBOR_HOUSE],
      fakeMonitor(),
      NOW,
    );

    expect(second).toEqual({ created: 0, skipped: 1, failed: 0 });
    const queries = await dataSource.monitoringQueries.list(scope);
    expect(queries.filter((query) => query.locationId === LOC_HARBOR_HOUSE)).toHaveLength(1);
  });

  it("never touches a location a person already covered", async () => {
    // USHG's SoHo location has a hand-created query. The pass must neither
    // duplicate it nor edit it — including its enabled flag.
    const dataSource = freshDataSource();
    const scope = ushg.owner();
    const before = (await dataSource.monitoringQueries.list(scope)).find(
      (query) => query.locationId === LOC_SOHO,
    );
    expect(before).toBeDefined();

    const outcome = await ensureOnboardingLocationQueries(
      { dataSource, scope },
      [LOC_SOHO],
      fakeMonitor(),
      NOW,
    );

    expect(outcome).toEqual({ created: 0, skipped: 1, failed: 0 });
    const after = (await dataSource.monitoringQueries.list(scope)).filter(
      (query) => query.locationId === LOC_SOHO,
    );
    expect(after).toHaveLength(1);
    expect(after[0]).toEqual(before);
  });

  it("creates nothing without the step-2 opt-in", async () => {
    // No enabled organization-wide brand query means the person never
    // configured News monitoring — the pass must not configure it for them.
    const dataSource = freshDataSource();
    const scope = harbor.owner();
    await dataSource.monitoringQueries.remove(scope, MQ_HARBOR_BRAND);

    const outcome = await ensureOnboardingLocationQueries(
      { dataSource, scope },
      [LOC_HARBOR_HOUSE],
      fakeMonitor(),
      NOW,
    );

    expect(outcome).toEqual({ created: 0, skipped: 1, failed: 0 });
    expect(await dataSource.monitoringQueries.list(scope)).toHaveLength(0);
  });

  it("respects a paused brand query the same way", async () => {
    const dataSource = freshDataSource();
    const scope = harbor.owner();
    await dataSource.monitoringQueries.update(scope, MQ_HARBOR_BRAND, { enabled: false });

    const outcome = await ensureOnboardingLocationQueries(
      { dataSource, scope },
      [LOC_HARBOR_HOUSE],
      fakeMonitor(),
      NOW,
    );

    expect(outcome.created).toBe(0);
  });

  it("refuses a location outside the caller's organization", async () => {
    // A location id from another tenant resolves to nothing through the
    // caller's scope, so no query is created for it.
    const dataSource = freshDataSource();
    const scope = harbor.owner();

    const outcome = await ensureOnboardingLocationQueries(
      { dataSource, scope },
      [LOC_SOHO],
      fakeMonitor(),
      NOW,
    );

    expect(outcome).toEqual({ created: 0, skipped: 1, failed: 0 });
    const queries = await dataSource.monitoringQueries.list(scope);
    expect(queries.some((query) => query.locationId === LOC_SOHO)).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Origin is provenance, not a preference                                      */
/* -------------------------------------------------------------------------- */

describe("query origin", () => {
  it("cannot be set through the public update input", () => {
    const parsed = updateMonitoringQueryInputSchema.parse({ origin: "onboarding" });
    expect("origin" in parsed).toBe(false);
  });

  it("is forced to user by the public create action", () => {
    const actions = source("src/app/actions/monitoring.ts");
    expect(actions).toContain('origin: "user"');
  });

  it("defaults to user for callers that predate it", () => {
    const parsed = createMonitoringQueryInputSchema.parse({
      locationId: null,
      name: "Hand-made",
      queryType: "topic",
      keywords: ["tasting menu"],
      exclusions: [],
      allowedDomains: [],
      deniedDomains: [],
      sourceCountry: null,
      language: null,
      relevanceThreshold: 0.35,
      enabled: true,
      pollIntervalMinutes: 240,
    });
    expect(parsed.origin).toBe("user");
  });
});

/* -------------------------------------------------------------------------- */
/* Truthful status                                                             */
/* -------------------------------------------------------------------------- */

describe("summarizeNewsMonitoring", () => {
  it("derives every number from persisted queries", async () => {
    const dataSource = freshDataSource();
    const queries = await dataSource.monitoringQueries.list(ushg.owner());

    const summary = summarizeNewsMonitoring(queries);

    const enabled = queries.filter((query) => query.enabled);
    const uniqueKeywords = new Set(enabled.flatMap((query) => query.keywords));
    expect(summary.enabledQueryCount).toBe(enabled.length);
    expect(summary.keywordCount).toBe(uniqueKeywords.size);
    expect(summary.configured).toBe(true);
  });

  it("reports zeros — never placeholders — when nothing is configured", () => {
    const summary = summarizeNewsMonitoring([]);
    expect(summary).toEqual({
      configured: false,
      enabledQueryCount: 0,
      keywordCount: 0,
      language: null,
      country: null,
    });
  });

  it("reports language and country only when consistent", async () => {
    const dataSource = freshDataSource();
    const scope = ushg.owner();
    const queries = await dataSource.monitoringQueries.list(scope);
    // Seeded USHG queries agree on en/us.
    expect(summarizeNewsMonitoring(queries).language).toBe("en");
    expect(summarizeNewsMonitoring(queries).country).toBe("us");

    const first = queries[0];
    if (!first) throw new Error("the seed carries USHG monitoring queries");
    const mixed = await dataSource.monitoringQueries.update(scope, first.id, {
      language: "fr",
    });
    const withMixed = queries.map((query) => (query.id === mixed.id ? mixed : query));
    expect(summarizeNewsMonitoring(withMixed).language).toBeNull();
  });

  it("has no poll time until a poll has actually completed", async () => {
    const dataSource = freshDataSource();
    const scope = harbor.owner();
    const queries = await dataSource.monitoringQueries.list(scope);
    // Harbor's query has never been polled; there is no run to point at.
    expect(await lastSuccessfulNewsPollAt(dataSource, scope, queries)).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Reddit — capability reflects the actual repository                          */
/* -------------------------------------------------------------------------- */

describe("Reddit capability", () => {
  it("has no connector in the registry", () => {
    // The view model states `unavailable` as a fact about the codebase; this
    // is the fact. The registry throws for reddit rather than returning a
    // provider, so there is nothing a configuration form could configure.
    expect(() => getConnector("reddit")).toThrow(ConfigurationError);
  });

  it("renders no configuration write path", () => {
    const card = source("src/components/onboarding/reddit-source-card.tsx");
    // No action import, no fetch, no form: the disabled control is the only
    // control, and nothing on the card can persist anything.
    expect(card).not.toContain("useTransition");
    expect(card).not.toContain("@/app/actions");
    expect(card).not.toContain("fetch(");
    expect(card).not.toContain("<form");
  });

  it("is labeled available-after-setup, never active", () => {
    const badge = source("src/components/onboarding/source-status-badge.tsx");
    expect(badge).toContain('unavailable: "Available after setup"');
    expect(code("src/components/onboarding/source-status-badge.tsx")).not.toMatch(
      /"Active"|"Live"/,
    );

    const card = source("src/components/onboarding/reddit-source-card.tsx");
    expect(card).toContain('status="unavailable"');
  });
});

/* -------------------------------------------------------------------------- */
/* Step completion stays gated on Google                                       */
/* -------------------------------------------------------------------------- */

describe("step 2 completion", () => {
  it("keeps Google as the only prerequisite in the completion action", () => {
    const actions = source("src/app/actions/onboarding.ts");
    const start = actions.indexOf("export async function completeOnboardingSourceAction");
    const end = actions.indexOf("export async function", start + 1);
    const body = actions.slice(start, end);

    // The action re-reads the Google connection server-side and refuses
    // without one. News and Reddit configuration appear nowhere in the
    // decision, so neither can falsely satisfy the prerequisite.
    expect(body).toContain('"google_business_profile"');
    expect(body).toContain("throw conflict");
    expect(body).not.toContain("monitoringQueries");
    expect(body).not.toContain("news");
    expect(body).not.toContain("reddit");
  });

  it("does not let the news save touch onboarding progress", () => {
    const actions = source("src/app/actions/onboarding.ts");
    const start = actions.indexOf(
      "export async function saveOnboardingNewsMonitoringAction",
    );
    const end = actions.indexOf("export async function", start + 1);
    const body = actions.slice(start, end);

    expect(body).toContain('authorize("monitoring.manage_queries")');
    expect(body).not.toContain("completeSourceStep");
    expect(body).not.toContain("skipSourceStep");
  });

  it("offers Back to step 1 and never renders fake counts", () => {
    const step = source("src/components/onboarding/connect-sources-step.tsx");
    expect(step).toContain('href="/onboarding/organization"');

    for (const path of [
      "src/components/onboarding/connect-sources-step.tsx",
      "src/components/onboarding/news-source-card.tsx",
      "src/components/onboarding/reddit-source-card.tsx",
      "src/app/onboarding/connect-sources/page.tsx",
    ]) {
      const text = source(path);
      // The tell-tale of a mocked-up card: a literal count in the markup.
      expect(text, path).not.toMatch(/12 names|8 communities|Monitoring 8/);
    }
  });
});
