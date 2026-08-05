import { beforeEach, describe, expect, it } from "vitest";
import type { LiaDataSource } from "@/lib/data/types";
import { PollRunInProgressError } from "@/lib/data/errors";
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
