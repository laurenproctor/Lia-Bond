import { beforeEach, describe, expect, it } from "vitest";
import type { LiaDataSource } from "@/lib/data/types";
import { DataError, PollRunInProgressError } from "@/lib/data/errors";
import { freshDataSource, harbor, ushg } from "./helpers/scope";

let dataSource: LiaDataSource;

const QUERY = {
  locationId: null,
  name: "Brand mentions",
  queryType: "brand" as const,
  keywords: ["Gramercy Tavern"],
  exclusions: [],
  allowedDomains: [],
  deniedDomains: [],
  sourceCountry: "us",
  language: "en",
  relevanceThreshold: 0.35,
  enabled: true,
  pollIntervalMinutes: 360,
};

beforeEach(() => {
  dataSource = freshDataSource();
});

describe("monitoringQueries", () => {
  it("creates a query inside the caller's organization", async () => {
    const created = await dataSource.monitoringQueries.create(ushg.admin(), QUERY);
    expect(created.organizationId).toBe(ushg.admin().organizationId);
    expect(created.lastPolledAt).toBeNull();
  });

  it("does not leak a query across tenants", async () => {
    await dataSource.monitoringQueries.create(ushg.admin(), QUERY);
    const theirs = await dataSource.monitoringQueries.list(harbor.owner());
    expect(theirs.every((q) => q.name !== "Brand mentions")).toBe(true);
  });

  it("lists only due queries", async () => {
    const created = await dataSource.monitoringQueries.create(ushg.admin(), QUERY);
    const due = await dataSource.monitoringQueries.listDue(
      "2026-08-04T12:00:00.000Z",
      50,
    );
    expect(due.map((q) => q.id)).toContain(created.id);

    await dataSource.monitoringQueries.markPolled(
      ushg.admin(),
      created.id,
      "2026-08-04T12:00:00.000Z",
    );
    const after = await dataSource.monitoringQueries.listDue(
      "2026-08-04T13:00:00.000Z",
      50,
    );
    expect(after.map((q) => q.id)).not.toContain(created.id);
  });

  it("excludes a disabled query from the due list", async () => {
    const created = await dataSource.monitoringQueries.create(ushg.admin(), {
      ...QUERY,
      enabled: false,
    });
    const due = await dataSource.monitoringQueries.listDue(
      "2026-08-04T12:00:00.000Z",
      50,
    );
    expect(due.map((q) => q.id)).not.toContain(created.id);
  });
});

describe("newsPollRuns", () => {
  it("refuses to start a run against another tenant's query", async () => {
    const theirs = await dataSource.monitoringQueries.create(harbor.owner(), QUERY);

    await expect(
      dataSource.newsPollRuns.start(ushg.admin(), {
        monitoringQueryId: theirs.id,
        trigger: "manual",
        actorUserId: ushg.admin().userId,
      }),
    ).rejects.toBeInstanceOf(DataError);
  });

  it("refuses a second concurrent run for one query", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY);
    await dataSource.newsPollRuns.start(ushg.admin(), {
      monitoringQueryId: query.id,
      trigger: "scheduled",
      actorUserId: null,
    });

    await expect(
      dataSource.newsPollRuns.start(ushg.admin(), {
        monitoringQueryId: query.id,
        trigger: "manual",
        actorUserId: ushg.admin().userId,
      }),
    ).rejects.toBeInstanceOf(PollRunInProgressError);
  });

  it("allows a new run once the previous one finished", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY);
    const first = await dataSource.newsPollRuns.start(ushg.admin(), {
      monitoringQueryId: query.id,
      trigger: "scheduled",
      actorUserId: null,
    });
    await dataSource.newsPollRuns.finish(ushg.admin(), first.id, {
      status: "completed",
      candidatesEvaluated: 3,
      acceptedCount: 1,
      rejectedCount: 2,
      requestsSpent: 1,
      truncated: false,
      gateScoreMin: 0.1,
      gateScoreMean: 0.4,
      gateScoreMax: 0.8,
      errorCode: null,
      errorMessage: null,
    });

    const second = await dataSource.newsPollRuns.start(ushg.admin(), {
      monitoringQueryId: query.id,
      trigger: "manual",
      actorUserId: ushg.admin().userId,
    });
    expect(second.status).toBe("running");
  });

  it("sums requests spent since an instant", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY);
    const run = await dataSource.newsPollRuns.start(ushg.admin(), {
      monitoringQueryId: query.id,
      trigger: "scheduled",
      actorUserId: null,
    });
    await dataSource.newsPollRuns.finish(ushg.admin(), run.id, {
      status: "completed",
      candidatesEvaluated: 1,
      acceptedCount: 1,
      rejectedCount: 0,
      requestsSpent: 4,
      truncated: false,
      gateScoreMin: 0.5,
      gateScoreMean: 0.5,
      gateScoreMax: 0.5,
      errorCode: null,
      errorMessage: null,
    });

    const spent = await dataSource.newsPollRuns.requestsSpentSince(
      "2026-01-01T00:00:00.000Z",
    );
    expect(spent).toBeGreaterThanOrEqual(4);
  });
});

describe("newsRejectedCandidates", () => {
  it("records rejections and reads them back for the query", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY);
    const run = await dataSource.newsPollRuns.start(ushg.admin(), {
      monitoringQueryId: query.id,
      trigger: "scheduled",
      actorUserId: null,
    });

    await dataSource.newsRejectedCandidates.recordMany(ushg.admin(), [
      {
        monitoringQueryId: query.id,
        newsPollRunId: run.id,
        externalId: "article-1",
        url: "https://example.com/article-1",
        title: "A story that missed the bar",
        publisherDomain: "example.com",
        reason: "below_threshold",
        score: 0.2,
        publishedAt: "2026-08-01T10:00:00.000Z",
      },
    ]);

    const rows = await dataSource.newsRejectedCandidates.listForQuery(
      ushg.admin(),
      query.id,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]?.organizationId).toBe(ushg.admin().organizationId);
    expect(rows[0]?.reason).toBe("below_threshold");
  });

  it("does nothing on an empty batch", async () => {
    await expect(
      dataSource.newsRejectedCandidates.recordMany(ushg.admin(), []),
    ).resolves.toBeUndefined();
  });

  it("refuses to record a rejection against another tenant's query", async () => {
    const theirs = await dataSource.monitoringQueries.create(harbor.owner(), QUERY);

    await expect(
      dataSource.newsRejectedCandidates.recordMany(ushg.admin(), [
        {
          monitoringQueryId: theirs.id,
          newsPollRunId: theirs.id,
          externalId: "article-2",
          url: "https://example.com/article-2",
          title: "Not this tenant's story",
          publisherDomain: "example.com",
          reason: "domain_denied",
          score: 0.1,
          publishedAt: "2026-08-01T10:00:00.000Z",
        },
      ]),
    ).rejects.toBeInstanceOf(DataError);
  });

  it("purges rows older than the cutoff and keeps newer ones", async () => {
    const query = await dataSource.monitoringQueries.create(ushg.admin(), QUERY);
    const run = await dataSource.newsPollRuns.start(ushg.admin(), {
      monitoringQueryId: query.id,
      trigger: "scheduled",
      actorUserId: null,
    });

    await dataSource.newsRejectedCandidates.recordMany(ushg.admin(), [
      {
        monitoringQueryId: query.id,
        newsPollRunId: run.id,
        externalId: "article-3",
        url: "https://example.com/article-3",
        title: "Recorded on the seed clock",
        publisherDomain: "example.com",
        reason: "excluded_term",
        score: 0.15,
        publishedAt: "2026-08-01T10:00:00.000Z",
      },
    ]);

    // Every row this test creates lands on the frozen demo clock, so a cutoff
    // before it removes nothing and a cutoff after it removes everything.
    const removedBeforeCutoff = await dataSource.newsRejectedCandidates.purgeOlderThan(
      ushg.admin(),
      "2000-01-01T00:00:00.000Z",
    );
    expect(removedBeforeCutoff).toBe(0);
    expect(
      await dataSource.newsRejectedCandidates.listForQuery(ushg.admin(), query.id),
    ).toHaveLength(1);

    const removedAfterCutoff = await dataSource.newsRejectedCandidates.purgeOlderThan(
      ushg.admin(),
      "2100-01-01T00:00:00.000Z",
    );
    expect(removedAfterCutoff).toBe(1);
    expect(
      await dataSource.newsRejectedCandidates.listForQuery(ushg.admin(), query.id),
    ).toHaveLength(0);
  });
});
