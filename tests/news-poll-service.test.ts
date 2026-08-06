import { beforeEach, describe, expect, it, vi } from "vitest";
import { NO_CAPABILITIES } from "@/domain";
import type { LiaDataSource } from "@/lib/data/types";
import { DAILY_REQUEST_BUDGET } from "@/lib/monitoring/budget";
import { pollDueQueries, pollMonitoringQuery, SYSTEM_ACTOR_ID } from "@/lib/monitoring/poll-service";
import type { NewsMonitor, NewsSearchBatch } from "@/news/monitor";
import { NewsError } from "@/news/errors";
import { freshDataSource, harbor, ushg } from "./helpers/scope";

let dataSource: LiaDataSource;

const QUERY_INPUT = {
  locationId: null,
  name: "Brand mentions",
  queryType: "brand" as const,
  keywords: ["Gramercy Tavern"],
  exclusions: ["obituary"],
  allowedDomains: [],
  deniedDomains: [],
  sourceCountry: "us",
  language: "en",
  relevanceThreshold: 0.35,
  enabled: true,
  pollIntervalMinutes: 360,
};

function batch(titles: string[]): NewsSearchBatch {
  return {
    articles: titles.map((title, index) => ({
      externalId: `https://paper.example/${index}`,
      url: `https://paper.example/${index}`,
      title,
      description: "A description.",
      publisherName: "Paper",
      publisherDomain: "paper.example",
      authorName: null,
      publishedAt: "2026-08-04T09:00:00.000Z",
      language: "en",
      metadata: {},
    })),
    requestsSpent: 1,
    truncated: false,
    malformedCount: 0,
  };
}

function monitorReturning(result: NewsSearchBatch | Error): NewsMonitor {
  return {
    platform: "news_media",
    // A real capability set, matching what `GNewsMonitor` actually reports —
    // `ensureNewsConnection` persists whatever this returns onto
    // `platform_connections.capabilities`, so a placeholder here would mask
    // a regression where the wrong thing gets stored.
    capabilities: () => ({ ...NO_CAPABILITIES, canReadMentions: true }),
    search: vi.fn(async () => {
      if (result instanceof Error) throw result;
      return result;
    }),
  } as unknown as NewsMonitor;
}

beforeEach(() => {
  dataSource = freshDataSource();
});

describe("pollMonitoringQuery", () => {
  it("ingests admitted articles and records the rejected ones", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY_INPUT);

    const outcome = await pollMonitoringQuery({
      dataSource,
      scope: ushg.admin(),
      query,
      monitor: monitorReturning(
        batch([
          "Gramercy Tavern reopens",
          "City council debates parking",
          "Gramercy Tavern obituary notice",
        ]),
      ),
      trigger: "manual",
      actorUserId: ushg.admin().userId,
      now: "2026-08-04T12:00:00.000Z",
    });

    expect(outcome.accepted).toBe(1);
    expect(outcome.rejected).toBe(2);

    const rejections = await dataSource.newsRejectedCandidates.listForQuery(
      ushg.admin(),
      query.id,
    );
    expect(rejections.map((r) => r.reason).sort()).toEqual([
      "excluded_term",
      "no_keyword_match",
    ]);
  });

  it("creates mentions carrying the query and publisher", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY_INPUT);

    await pollMonitoringQuery({
      dataSource,
      scope: ushg.admin(),
      query,
      monitor: monitorReturning(batch(["Gramercy Tavern reopens"])),
      trigger: "manual",
      actorUserId: ushg.admin().userId,
      now: "2026-08-04T12:00:00.000Z",
    });

    const mentions = await dataSource.mentions.list(ushg.admin(), {
      sourceTypes: ["news_article"],
      limit: 100,
    });
    const created = mentions.find((m) => m.title === "Gramercy Tavern reopens");
    expect(created).toBeDefined();
    expect(created?.monitoringQueryId).toBe(query.id);
    expect(created?.publisherDomain).toBe("paper.example");
    expect(created?.sourceType).toBe("news_article");
  });

  it("leaves the mention unanalysed for the analysis layer", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY_INPUT);

    await pollMonitoringQuery({
      dataSource,
      scope: ushg.admin(),
      query,
      monitor: monitorReturning(batch(["Gramercy Tavern reopens"])),
      trigger: "manual",
      actorUserId: ushg.admin().userId,
      now: "2026-08-04T12:00:00.000Z",
    });

    const mentions = await dataSource.mentions.list(ushg.admin(), {
      sourceTypes: ["news_article"],
      limit: 100,
    });
    const created = mentions.find((m) => m.title === "Gramercy Tavern reopens");
    expect(created?.status).toBe("new");
    expect(created?.relevanceScore).toBeNull();
    expect(created?.sentiment).toBe("unknown");
  });

  it("advances the cursor on success", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY_INPUT);

    await pollMonitoringQuery({
      dataSource,
      scope: ushg.admin(),
      query,
      monitor: monitorReturning(batch(["Gramercy Tavern reopens"])),
      trigger: "scheduled",
      actorUserId: null,
      now: "2026-08-04T12:00:00.000Z",
    });

    const after = await dataSource.monitoringQueries.get(ushg.admin(), query.id);
    expect(after?.lastPolledAt).toBe("2026-08-04T12:00:00.000Z");
  });

  it("does not advance the cursor when the provider failed", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY_INPUT);

    await pollMonitoringQuery({
      dataSource,
      scope: ushg.admin(),
      query,
      monitor: monitorReturning(
        new NewsError("provider_error", "The news provider is unavailable.", true),
      ),
      trigger: "scheduled",
      actorUserId: null,
      now: "2026-08-04T12:00:00.000Z",
    });

    const after = await dataSource.monitoringQueries.get(ushg.admin(), query.id);
    expect(after?.lastPolledAt).toBeNull();
  });

  it("closes the run as failed and stores no provider text", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY_INPUT);

    await pollMonitoringQuery({
      dataSource,
      scope: ushg.admin(),
      query,
      monitor: monitorReturning(
        new NewsError("unauthorized", "GNews said: bad key sk-live-123", false),
      ),
      trigger: "scheduled",
      actorUserId: null,
      now: "2026-08-04T12:00:00.000Z",
    });

    const [run] = await dataSource.newsPollRuns.listForQuery(ushg.admin(), query.id, 1);
    expect(run?.status).toBe("failed");
    expect(run?.errorCode).toBe("unauthorized");
    expect(run?.errorMessage ?? "").not.toContain("sk-live-123");
  });

  it("re-polling the same article updates rather than duplicating", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY_INPUT);
    const options = {
      dataSource,
      scope: ushg.admin(),
      query,
      trigger: "manual" as const,
      actorUserId: ushg.admin().userId,
      now: "2026-08-04T12:00:00.000Z",
    };

    const first = await pollMonitoringQuery({
      ...options,
      monitor: monitorReturning(batch(["Gramercy Tavern reopens"])),
    });
    const second = await pollMonitoringQuery({
      ...options,
      monitor: monitorReturning(batch(["Gramercy Tavern reopens"])),
    });

    // The property this test exists to pin: the second poll must genuinely
    // reach `mentions.ingest` and update the existing row, not silently
    // reject the article as "probable syndication" of its own prior
    // mention — which would also leave `matching` at length 1, for the
    // wrong reason entirely.
    expect(first.accepted).toBe(1);
    expect(second.accepted).toBe(1);
    expect(second.rejected).toBe(0);

    const mentions = await dataSource.mentions.list(ushg.admin(), {
      sourceTypes: ["news_article"],
      limit: 100,
    });
    const matching = mentions.filter((m) => m.title === "Gramercy Tavern reopens");
    expect(matching).toHaveLength(1);
  });

  it("re-ingests rather than self-rejecting on a retry after a failed poll left the cursor unmoved", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY_INPUT);
    const options = {
      dataSource,
      scope: ushg.admin(),
      query,
      trigger: "manual" as const,
      actorUserId: ushg.admin().userId,
    };

    const first = await pollMonitoringQuery({
      ...options,
      now: "2026-08-04T12:00:00.000Z",
      monitor: monitorReturning(batch(["Gramercy Tavern reopens"])),
    });
    expect(first.accepted).toBe(1);

    // A failed poll does not advance the cursor, so the retry re-asks for
    // the same window and gets the same article back.
    const failed = await pollMonitoringQuery({
      ...options,
      now: "2026-08-04T13:00:00.000Z",
      monitor: monitorReturning(
        new NewsError("provider_error", "The news provider is unavailable.", true),
      ),
    });
    expect(failed.status).toBe("failed");

    const retry = await pollMonitoringQuery({
      ...options,
      now: "2026-08-04T14:00:00.000Z",
      monitor: monitorReturning(batch(["Gramercy Tavern reopens"])),
    });

    expect(retry.accepted).toBe(1);
    expect(retry.rejected).toBe(0);
  });

  it("collapses two syndicated copies arriving in the same batch", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY_INPUT);

    const outcome = await pollMonitoringQuery({
      dataSource,
      scope: ushg.admin(),
      query,
      // Two distinct articles (distinct externalId, from `batch`'s
      // index-based ids), identical headline — the within-batch case, not
      // the self-exclusion case above.
      monitor: monitorReturning(batch(["Gramercy Tavern reopens", "Gramercy Tavern reopens"])),
      trigger: "manual",
      actorUserId: ushg.admin().userId,
      now: "2026-08-04T12:00:00.000Z",
    });

    expect(outcome.accepted).toBe(1);
    expect(outcome.rejected).toBe(1);

    const rejections = await dataSource.newsRejectedCandidates.listForQuery(
      ushg.admin(),
      query.id,
    );
    expect(rejections.map((r) => r.reason)).toEqual(["probable_syndication"]);
  });

  it("returns a skipped outcome, opening no second run, when a poll is already in progress", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY_INPUT);
    await dataSource.newsPollRuns.start(ushg.admin(), {
      monitoringQueryId: query.id,
      trigger: "manual",
      actorUserId: ushg.admin().userId,
    });

    const monitor = monitorReturning(batch(["Gramercy Tavern reopens"]));
    const outcome = await pollMonitoringQuery({
      dataSource,
      scope: ushg.admin(),
      query,
      monitor,
      trigger: "manual",
      actorUserId: ushg.admin().userId,
      now: "2026-08-04T12:00:00.000Z",
    });

    expect(outcome.status).toBe("skipped");
    expect(outcome.runId).toBeNull();
    // The search was never even attempted.
    expect(monitor.search).not.toHaveBeenCalled();
  });

  it("records rejections in a single recordMany call", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY_INPUT);
    const recordMany = vi.spyOn(dataSource.newsRejectedCandidates, "recordMany");

    await pollMonitoringQuery({
      dataSource,
      scope: ushg.admin(),
      query,
      monitor: monitorReturning(
        batch(["City council debates parking", "The mayor's budget address"]),
      ),
      trigger: "manual",
      actorUserId: ushg.admin().userId,
      now: "2026-08-04T12:00:00.000Z",
    });

    expect(recordMany).toHaveBeenCalledTimes(1);
    expect(recordMany.mock.calls[0]?.[1]).toHaveLength(2);
  });

  it("keeps article titles, urls, and publisher names out of the audit trail", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY_INPUT);

    await pollMonitoringQuery({
      dataSource,
      scope: ushg.admin(),
      query,
      monitor: monitorReturning(batch(["Gramercy Tavern reopens"])),
      trigger: "manual",
      actorUserId: ushg.admin().userId,
      now: "2026-08-04T12:00:00.000Z",
    });

    const events = await dataSource.auditEvents.list(ushg.admin(), {
      entityType: "monitoring_query",
      entityId: query.id,
    });
    expect(events.length).toBeGreaterThan(0);

    const serialized = JSON.stringify(events);
    expect(serialized).not.toContain("Gramercy Tavern reopens");
    expect(serialized).not.toContain("paper.example");
    expect(serialized).not.toContain("Paper");
  });

  it("does not let one oversized candidate cost the batch its others", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY_INPUT);

    // The normaliser is the primary defence (see tests/gnews-client.test.ts),
    // but this proves the per-candidate isolation inside the poll service
    // itself: a candidate whose externalId would fail `mentions.ingest`'s own
    // validation must not abort the rest of the batch or orphan the run.
    const oversized = batch(["Gramercy Tavern reopens"]).articles[0]!;
    const withOversizedId = {
      ...oversized,
      externalId: `https://paper.example/${"a".repeat(310)}`,
    };
    const wellFormed = batch(["Gramercy Tavern wins an award"]).articles[0]!;

    const outcome = await pollMonitoringQuery({
      dataSource,
      scope: ushg.admin(),
      query,
      monitor: monitorReturning({
        articles: [withOversizedId, wellFormed],
        requestsSpent: 1,
        truncated: false,
        malformedCount: 0,
      }),
      trigger: "manual",
      actorUserId: ushg.admin().userId,
      now: "2026-08-04T12:00:00.000Z",
    });

    // The well-formed candidate still landed, and the failure is counted
    // and surfaced rather than swallowed: `partial`, not the outright
    // `failed` a run-level error would produce, and not a silent `completed`
    // either.
    expect(outcome.accepted).toBe(1);
    expect(outcome.status).toBe("partial");
    expect(outcome.errorCode).toBe("ingest_failed");

    const [run] = await dataSource.newsPollRuns.listForQuery(ushg.admin(), query.id, 1);
    expect(run?.status).toBe("partial");
    expect(run?.errorCode).toBe("ingest_failed");
  });

  it("reports a batch that fails ingest entirely as partial, not a clean completed", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY_INPUT);

    // Every candidate is well-formed enough to pass the gate — matching
    // keywords, no exclusions — but fails `mentions.ingest`'s own
    // `sourceUrl: z.url()` validation. This is the concrete scenario the
    // review named: a GNews payload the normaliser's `typeof` check accepts
    // but which is not a well-formed URL (now also caught at the normaliser,
    // see tests/gnews-client.test.ts — this proves the poll service does not
    // silently lose the batch even if that boundary is ever bypassed).
    const malformedUrl = batch(["Gramercy Tavern reopens"]).articles[0]!;
    const articles = [
      { ...malformedUrl, externalId: "malformed-1", url: "www.paper.example/story-1" },
      { ...malformedUrl, externalId: "malformed-2", url: "www.paper.example/story-2" },
    ];

    const outcome = await pollMonitoringQuery({
      dataSource,
      scope: ushg.admin(),
      query,
      monitor: monitorReturning({
        articles,
        requestsSpent: 1,
        truncated: false,
        malformedCount: 0,
      }),
      trigger: "manual",
      actorUserId: ushg.admin().userId,
      now: "2026-08-04T12:00:00.000Z",
    });

    // Total ingest loss must not read as a clean, uneventful poll.
    expect(outcome.accepted).toBe(0);
    expect(outcome.status).toBe("partial");
    expect(outcome.errorCode).not.toBeNull();

    const mentions = await dataSource.mentions.list(ushg.admin(), {
      sourceTypes: ["news_article"],
      limit: 100,
    });
    expect(mentions.filter((m) => m.title === "Gramercy Tavern reopens")).toHaveLength(0);
  });

  it("records min, mean, and max gate scores on the run", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY_INPUT);

    await pollMonitoringQuery({
      dataSource,
      scope: ushg.admin(),
      query,
      monitor: monitorReturning(
        batch(["Gramercy Tavern reopens", "City council debates parking"]),
      ),
      trigger: "manual",
      actorUserId: ushg.admin().userId,
      now: "2026-08-04T12:00:00.000Z",
    });

    const [run] = await dataSource.newsPollRuns.listForQuery(ushg.admin(), query.id, 1);
    expect(run?.gateScoreMax).toBeGreaterThan(0);
    expect(run?.gateScoreMin).toBe(0);
    // Mean was previously asserted nowhere — replacing its computation with
    // `null` in poll-service.ts left the suite green. "Gramercy Tavern
    // reopens" matches the query's only keyword in the title (score 0.5);
    // "City council debates parking" matches nothing (score 0, the
    // below_threshold case). (0.5 + 0) / 2 = 0.25 pins the exact arithmetic,
    // not just that a value exists.
    expect(run?.gateScoreMean).toBe(0.25);
  });
});

/* -------------------------------------------------------------------------- */
/* Implicit connection creation                                               */
/* -------------------------------------------------------------------------- */

describe("ensureNewsConnection", () => {
  // Harbor & Vine has no seeded `news_media` connection (only USHG's fixture
  // does), so it is the one tenant where this branch is reachable at all.

  it("creates the connection from the monitor's real capabilities and audits it", async () => {
    const scope = harbor.owner();
    const query = await dataSource.monitoringQueries.create(scope, QUERY_INPUT);
    expect(await dataSource.platformConnections.getByPlatform(scope, "news_media")).toBeNull();

    const outcome = await pollMonitoringQuery({
      dataSource,
      scope,
      query,
      monitor: monitorReturning(batch(["Gramercy Tavern reopens"])),
      trigger: "manual",
      actorUserId: scope.userId,
      now: "2026-08-04T12:00:00.000Z",
    });

    expect(outcome.status).toBe("completed");
    expect(outcome.accepted).toBe(1);

    const connection = await dataSource.platformConnections.getByPlatform(scope, "news_media");
    expect(connection).not.toBeNull();
    // Whatever the monitor honestly claims — never a hand-written guess that
    // could imply a capability a free-tier search API does not have.
    expect(connection?.capabilities.canReadMentions).toBe(true);
    expect(connection?.capabilities.canReadFullText).toBe(false);
    expect(connection?.capabilities.supportsWebhooks).toBe(false);
    expect(connection?.connectedByUserId).toBe(scope.userId);

    const events = await dataSource.auditEvents.list(scope, {
      eventTypes: ["integration.connected"],
    });
    expect(events.some((event) => event.entityId === connection?.id)).toBe(true);
  });

  it("fails the run rather than creating a connection with no person behind it", async () => {
    const scope = harbor.owner();
    const query = await dataSource.monitoringQueries.create(scope, QUERY_INPUT);

    const outcome = await pollMonitoringQuery({
      dataSource,
      scope,
      query,
      monitor: monitorReturning(batch(["Gramercy Tavern reopens"])),
      trigger: "scheduled",
      actorUserId: null,
      now: "2026-08-04T12:00:00.000Z",
    });

    expect(outcome.status).toBe("failed");
    expect(outcome.errorCode).toBe("not_connected");
    expect(await dataSource.platformConnections.getByPlatform(scope, "news_media")).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The sweep                                                                   */
/* -------------------------------------------------------------------------- */

describe("pollDueQueries", () => {
  // Task 13 seeded a handful of enabled monitoring queries so the demo has
  // something to show. `pollDueQueries` sweeps every organization with no
  // scope of its own (see MonitoringQueryRepository.listDue's own comment),
  // so at `now: "2026-08-04T12:00:00.000Z"` those seeded queries are legitimately
  // "due" too, and would throw off every exact `polled`/`skippedForBudget`
  // count below. Clearing them restores the "nothing exists yet but what
  // this test creates" precondition the counts are written against.
  beforeEach(async () => {
    for (const scope of [ushg.admin(), harbor.owner()]) {
      const existing = await dataSource.monitoringQueries.list(scope);
      for (const query of existing) {
        await dataSource.monitoringQueries.remove(scope, query.id);
      }
    }
  });

  it("never writes SYSTEM_ACTOR_ID to a stored row", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY_INPUT);

    const outcome = await pollDueQueries({
      dataSource,
      monitor: monitorReturning(batch(["Gramercy Tavern reopens"])),
      now: "2026-08-04T12:00:00.000Z",
      limit: 10,
    });

    expect(outcome.polled).toBe(1);

    const [run] = await dataSource.newsPollRuns.listForQuery(ushg.admin(), query.id, 1);
    expect(run?.actorUserId).toBeNull();
    expect(run?.actorUserId).not.toBe(SYSTEM_ACTOR_ID);

    const events = await dataSource.auditEvents.list(ushg.admin(), {
      entityType: "monitoring_query",
      entityId: query.id,
    });
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      expect(event.actorUserId).toBeNull();
      expect(event.actorUserId).not.toBe(SYSTEM_ACTOR_ID);
    }
  });

  it("constructs each row's scope from its own organization, not a shared one", async () => {
    // Harbor needs its own connection pre-provisioned: a scheduled run
    // cannot legitimately create one (see `ensureNewsConnection` above), and
    // this test is about scoping, not about that branch.
    await dataSource.platformConnections.upsert(harbor.owner(), {
      platform: "news_media",
      externalAccountId: "news-monitor-harbor",
      externalAccountName: "News and media monitoring",
      status: "connected",
      capabilities: { ...NO_CAPABILITIES, canReadMentions: true },
      tokenExpiresAt: null,
      grantedScopes: [],
      providerMetadata: {},
      connectedByUserId: harbor.owner().userId,
      connectedAt: "2026-08-04T00:00:00.000Z",
    });

    const ushgQuery = await dataSource.monitoringQueries.create(ushg.admin(), QUERY_INPUT);
    const harborQuery = await dataSource.monitoringQueries.create(harbor.owner(), QUERY_INPUT);

    await pollDueQueries({
      dataSource,
      monitor: monitorReturning(batch(["Gramercy Tavern reopens"])),
      now: "2026-08-04T12:00:00.000Z",
      limit: 10,
    });

    const ushgMentions = await dataSource.mentions.list(ushg.admin(), {
      sourceTypes: ["news_article"],
      limit: 100,
    });
    const harborMentions = await dataSource.mentions.list(harbor.owner(), {
      sourceTypes: ["news_article"],
      limit: 100,
    });

    expect(ushgMentions.some((m) => m.monitoringQueryId === ushgQuery.id)).toBe(true);
    expect(harborMentions.some((m) => m.monitoringQueryId === harborQuery.id)).toBe(true);
    // No cross-contamination: each query's article landed in its own tenant.
    expect(ushgMentions.some((m) => m.monitoringQueryId === harborQuery.id)).toBe(false);
    expect(harborMentions.some((m) => m.monitoringQueryId === ushgQuery.id)).toBe(false);
  });

  it("does not count a lock-conflicted query toward polled coverage", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY_INPUT);
    // Occupy the lock directly, bypassing `pollMonitoringQuery`.
    await dataSource.newsPollRuns.start(ushg.admin(), {
      monitoringQueryId: query.id,
      trigger: "manual",
      actorUserId: ushg.admin().userId,
    });

    const outcome = await pollDueQueries({
      dataSource,
      monitor: monitorReturning(batch(["Gramercy Tavern reopens"])),
      now: "2026-08-04T12:00:00.000Z",
      limit: 10,
    });

    expect(outcome.polled).toBe(0);
    expect(outcome.skippedForBudget).toBe(0);
  });

  it("stops the sweep once the scheduled budget is exhausted and reports what was skipped", async () => {
    await dataSource.monitoringQueries.create(ushg.admin(), { ...QUERY_INPUT, name: "Q1" });
    await dataSource.monitoringQueries.create(ushg.admin(), { ...QUERY_INPUT, name: "Q2" });

    // Budget already exhausted before the sweep starts.
    vi.spyOn(dataSource.newsPollRuns, "requestsSpentSince").mockResolvedValue(
      DAILY_REQUEST_BUDGET,
    );

    const outcome = await pollDueQueries({
      dataSource,
      monitor: monitorReturning(batch(["Gramercy Tavern reopens"])),
      now: "2026-08-04T12:00:00.000Z",
      limit: 10,
    });

    expect(outcome.polled).toBe(0);
    expect(outcome.skippedForBudget).toBe(2);
  });

  it("polls some queries before the budget runs out, not all or none", async () => {
    await dataSource.monitoringQueries.create(ushg.admin(), { ...QUERY_INPUT, name: "Q1" });
    await dataSource.monitoringQueries.create(ushg.admin(), { ...QUERY_INPUT, name: "Q2" });

    const spy = vi.spyOn(dataSource.newsPollRuns, "requestsSpentSince");
    spy.mockResolvedValueOnce(0); // Budget available before the first query.
    spy.mockResolvedValue(DAILY_REQUEST_BUDGET); // Exhausted before the second.

    const outcome = await pollDueQueries({
      dataSource,
      monitor: monitorReturning(batch(["Gramercy Tavern reopens"])),
      now: "2026-08-04T12:00:00.000Z",
      limit: 10,
    });

    expect(outcome.polled).toBe(1);
    expect(outcome.skippedForBudget).toBe(1);
  });

  it("survives one query's run failing to open and still polls the rest", async () => {
    await dataSource.monitoringQueries.create(ushg.admin(), { ...QUERY_INPUT, name: "Q1" });
    await dataSource.monitoringQueries.create(ushg.admin(), { ...QUERY_INPUT, name: "Q2" });

    const realStart = dataSource.newsPollRuns.start.bind(dataSource.newsPollRuns);
    const startSpy = vi.spyOn(dataSource.newsPollRuns, "start");
    // The one throw `pollMonitoringQuery` cannot itself absorb: a failure
    // opening the run means no row exists yet to close as `failed`.
    startSpy.mockImplementationOnce(() => {
      throw new Error("unexpected failure opening the run");
    });
    startSpy.mockImplementation(realStart);

    const outcome = await pollDueQueries({
      dataSource,
      monitor: monitorReturning(batch(["Gramercy Tavern reopens"])),
      now: "2026-08-04T12:00:00.000Z",
      limit: 10,
    });

    // One query blew up; the sweep still reached the other rather than
    // aborting for every tenant behind it.
    expect(outcome.polled).toBe(1);
  });
});
