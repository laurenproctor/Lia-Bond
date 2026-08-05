import { describe, expect, it } from "vitest";
import {
  createMonitoringQueryInputSchema,
  monitoringQuerySchema,
  newsPollRunSchema,
} from "@/domain/entities/monitoring";

const BASE = {
  id: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  locationId: null,
  name: "Brand mentions",
  queryType: "brand" as const,
  keywords: ["Gramercy Tavern"],
  exclusions: [],
  allowedDomains: [],
  deniedDomains: [],
  sourceCountry: null,
  language: "en",
  relevanceThreshold: 0.35,
  enabled: true,
  pollIntervalMinutes: 360,
  lastPolledAt: null,
  createdAt: "2026-08-04T00:00:00.000Z",
  updatedAt: "2026-08-04T00:00:00.000Z",
};

describe("monitoringQuerySchema", () => {
  it("accepts a well-formed query", () => {
    expect(monitoringQuerySchema.parse(BASE).name).toBe("Brand mentions");
  });

  it("requires at least one keyword", () => {
    expect(() => monitoringQuerySchema.parse({ ...BASE, keywords: [] })).toThrow();
  });

  it("rejects a threshold outside 0 to 1", () => {
    expect(() =>
      monitoringQuerySchema.parse({ ...BASE, relevanceThreshold: 1.5 }),
    ).toThrow();
  });

  it("rejects a poll interval below the floor", () => {
    expect(() =>
      monitoringQuerySchema.parse({ ...BASE, pollIntervalMinutes: 5 }),
    ).toThrow();
  });
});

describe("createMonitoringQueryInputSchema", () => {
  it("cannot carry an organizationId", () => {
    const parsed = createMonitoringQueryInputSchema.parse({
      ...BASE,
      organizationId: "33333333-3333-4333-8333-333333333333",
    });
    expect(parsed).not.toHaveProperty("organizationId");
  });
});

describe("newsPollRunSchema", () => {
  it("rejects negative counters", () => {
    expect(() =>
      newsPollRunSchema.parse({
        id: BASE.id,
        organizationId: BASE.organizationId,
        monitoringQueryId: BASE.id,
        trigger: "scheduled",
        actorUserId: null,
        status: "running",
        startedAt: BASE.createdAt,
        completedAt: null,
        candidatesEvaluated: -1,
        acceptedCount: 0,
        rejectedCount: 0,
        requestsSpent: 0,
        truncated: false,
        gateScoreMin: null,
        gateScoreMean: null,
        gateScoreMax: null,
        errorCode: null,
        errorMessage: null,
        createdAt: BASE.createdAt,
        updatedAt: BASE.updatedAt,
      }),
    ).toThrow();
  });
});
