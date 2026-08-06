import { describe, expect, it } from "vitest";
import { NO_CAPABILITIES } from "@/domain";
import type { LiaDataSource } from "@/lib/data/types";
import { createMonitoringQuery } from "@/lib/monitoring/query-service";
import type { NewsMonitor } from "@/news/monitor";
import { freshDataSource, harbor, ushg } from "./helpers/scope";

/**
 * `createMonitoringQuery` — the server-action side of D80's implicit
 * `news_media` connection.
 *
 * Task 10 gave the poll service its own `ensureNewsConnection`, but a
 * scheduled poll's actor is always null (D88), so it can never create that
 * first connection itself. Without this call, a brand-new organization's
 * first monitoring query would sit unconnected and every scheduled poll
 * against it would fail with `not_connected` forever — the gap this closes.
 */

let dataSource: LiaDataSource;

const QUERY_INPUT = {
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

const NOW = "2026-08-04T12:00:00.000Z";

/** A real capability set, matching what `GNewsMonitor` actually reports. */
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

describe("createMonitoringQuery", () => {
  it("creates the news_media connection when the organization has none", async () => {
    dataSource = freshDataSource();
    const scope = harbor.owner();

    expect(await dataSource.platformConnections.getByPlatform(scope, "news_media")).toBeNull();

    const query = await createMonitoringQuery(
      { dataSource, scope },
      QUERY_INPUT,
      fakeMonitor(),
      NOW,
    );

    expect(query.organizationId).toBe(scope.organizationId);

    const connection = await dataSource.platformConnections.getByPlatform(scope, "news_media");
    expect(connection).not.toBeNull();
    // Whatever the monitor honestly claims — never a hand-written guess that
    // could imply a capability a free-tier search API does not have.
    expect(connection?.capabilities).toEqual(fakeMonitor().capabilities());
    expect(connection?.status).toBe("connected");
    expect(connection?.connectedByUserId).toBe(scope.userId);
  });

  it("records who connected it, because a person — not the scheduled sweep — did", async () => {
    dataSource = freshDataSource();
    const scope = harbor.owner();

    await createMonitoringQuery({ dataSource, scope }, QUERY_INPUT, fakeMonitor(), NOW);

    const connection = await dataSource.platformConnections.getByPlatform(scope, "news_media");
    const events = await dataSource.auditEvents.list(scope, {
      eventTypes: ["integration.connected"],
    });

    expect(events.some((event) => event.entityId === connection?.id)).toBe(true);
    expect(events.find((event) => event.entityId === connection?.id)?.actorUserId).toBe(
      scope.userId,
    );
  });

  it("does not create a second connection when one already exists", async () => {
    dataSource = freshDataSource();
    const scope = ushg.admin();

    const before = await dataSource.platformConnections.getByPlatform(scope, "news_media");
    expect(before).not.toBeNull();

    await createMonitoringQuery({ dataSource, scope }, QUERY_INPUT, fakeMonitor(), NOW);

    const all = await dataSource.platformConnections.list(scope);
    expect(all.filter((row) => row.platform === "news_media")).toHaveLength(1);
    const after = await dataSource.platformConnections.getByPlatform(scope, "news_media");
    expect(after?.id).toBe(before?.id);
  });

  it("records the query's own creation in the audit trail", async () => {
    dataSource = freshDataSource();
    const scope = harbor.owner();

    const query = await createMonitoringQuery(
      { dataSource, scope },
      QUERY_INPUT,
      fakeMonitor(),
      NOW,
    );

    const events = await dataSource.auditEvents.list(scope, { limit: 100 });
    const created = events.find(
      (event) =>
        event.eventType === "monitoring_query.created" && event.entityId === query.id,
    );
    expect(created).toBeDefined();
  });
});
