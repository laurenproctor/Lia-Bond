import { beforeEach, describe, expect, it, vi } from "vitest";
import type { LiaDataSource } from "@/lib/data/types";
import { pollMonitoringQuery } from "@/lib/monitoring/poll-service";
import type { NewsMonitor, NewsSearchBatch } from "@/news/monitor";
import { NewsError } from "@/news/errors";
import { freshDataSource, ushg } from "./helpers/scope";

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
    capabilities: () => ({}) as never,
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
      "below_threshold",
      "excluded_term",
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

    await pollMonitoringQuery({
      ...options,
      monitor: monitorReturning(batch(["Gramercy Tavern reopens"])),
    });
    await pollMonitoringQuery({
      ...options,
      monitor: monitorReturning(batch(["Gramercy Tavern reopens"])),
    });

    const mentions = await dataSource.mentions.list(ushg.admin(), {
      sourceTypes: ["news_article"],
      limit: 100,
    });
    const matching = mentions.filter((m) => m.title === "Gramercy Tavern reopens");
    expect(matching).toHaveLength(1);
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
  });
});
