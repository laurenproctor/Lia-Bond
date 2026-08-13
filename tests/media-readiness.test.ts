import { describe, expect, it } from "vitest";
import type { MonitoringQuery } from "@/domain";
import { mediaReadiness } from "@/lib/integrations/media-readiness";

const NOW = "2026-08-04T12:00:00.000Z";

function query(overrides: Partial<MonitoringQuery> = {}): MonitoringQuery {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    organizationId: "22222222-2222-4222-8222-222222222222",
    locationId: null,
    name: "Brand mentions",
    queryType: "brand",
    keywords: ["Gramercy Tavern"],
    exclusions: [],
    allowedDomains: [],
    deniedDomains: [],
    sourceCountry: "us",
    language: "en",
    relevanceThreshold: 0.35,
    enabled: true,
    pollIntervalMinutes: 360,
    origin: "user",
    lastPolledAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  } satisfies MonitoringQuery;
}

describe("mediaReadiness", () => {
  it("blames the server, not the user, when no news provider is configured", () => {
    const readiness = mediaReadiness({ monitorAvailable: false, queries: [] });

    // The distinction matters: the action is hidden in this state, so copy
    // that told somebody to add a query would be a dead end.
    expect(readiness.state).toBe("not_configured");
    expect(readiness.description.toLowerCase()).toContain("administrator");
  });

  it("names the server even when queries already exist", () => {
    // A query saved before the key was removed is still unpollable, so the
    // deployment problem outranks anything the organization could do.
    expect(
      mediaReadiness({
        monitorAvailable: false,
        queries: [query({ lastPolledAt: NOW })],
      }).state,
    ).toBe("not_configured");
  });

  it("asks for a query when nothing is being watched", () => {
    const readiness = mediaReadiness({ monitorAvailable: true, queries: [] });

    expect(readiness.state).toBe("no_queries");
    expect(readiness.description.toLowerCase()).toContain("monitoring query");
  });

  it("never implies Lia sees everything published", () => {
    const readiness = mediaReadiness({ monitorAvailable: true, queries: [] });

    expect(readiness.description).toContain("does not see everything published");
  });

  it("reports a paused query rather than a missing one", () => {
    const readiness = mediaReadiness({
      monitorAvailable: true,
      queries: [query({ enabled: false })],
    });

    expect(readiness.state).toBe("all_paused");
    expect(readiness.description).toContain("The one monitoring query");
  });

  it("counts the paused queries when there is more than one", () => {
    const readiness = mediaReadiness({
      monitorAvailable: true,
      queries: [query({ enabled: false }), query({ enabled: false })],
    });

    expect(readiness.state).toBe("all_paused");
    expect(readiness.description).toContain("All 2 monitoring queries");
  });

  it("ignores paused queries when deciding whether a poll has run", () => {
    // The disabled query's cursor is stale by definition — it is not evidence
    // that the enabled one has ever searched.
    const readiness = mediaReadiness({
      monitorAvailable: true,
      queries: [query({ enabled: false, lastPolledAt: NOW }), query()],
    });

    expect(readiness.state).toBe("never_polled");
  });

  it("asks for a poll when an enabled query has never run", () => {
    const readiness = mediaReadiness({
      monitorAvailable: true,
      queries: [query()],
    });

    expect(readiness.state).toBe("never_polled");
    expect(readiness.description.toLowerCase()).toContain("poll");
  });

  it("explains the relevance gate once a poll has actually run", () => {
    const readiness = mediaReadiness({
      monitorAvailable: true,
      queries: [query({ lastPolledAt: NOW }), query()],
    });

    expect(readiness.state).toBe("no_articles");
    expect(readiness.description.toLowerCase()).toContain("relevance threshold");
  });
});
