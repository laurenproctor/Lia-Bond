import { describe, expect, it } from "vitest";
import { gateRejectionReasonSchema } from "@/domain/enums";
import {
  createMonitoringQueryInputSchema,
  monitoringQuerySchema,
  newsPollRunSchema,
  newsRejectedCandidateSchema,
  updateMonitoringQueryInputSchema,
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
  postalCode: null,
  localityCity: null,
  localityRegion: null,
  language: "en",
  relevanceThreshold: 0.35,
  enabled: true,
  pollIntervalMinutes: 360,
  origin: "user",
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

  it("keeps the locality a query was given", () => {
    const parsed = monitoringQuerySchema.parse({
      ...BASE,
      sourceCountry: "us",
      postalCode: " 10012 ",
      localityCity: "New York",
      localityRegion: "NY",
    });

    expect(parsed.postalCode).toBe("10012");
    expect(parsed.localityCity).toBe("New York");
    expect(parsed.localityRegion).toBe("NY");
  });

  it("accepts a postal format no US regex would allow", () => {
    // A Dutch postcode, an Irish Eircode, a Canadian FSA. Format is the
    // lookup's problem, not the schema's — rejecting these here would block a
    // save for everybody outside the United States.
    for (const postalCode of ["1012 AB", "D02 XY45", "M5V 3L9"]) {
      expect(
        monitoringQuerySchema.parse({ ...BASE, postalCode }).postalCode,
      ).toBe(postalCode);
    }
  });

  it("rejects a blank locality rather than storing an empty string", () => {
    // Null means "nobody has said". An empty string would be a third state
    // that renders as a gap and compares as a value.
    for (const field of ["postalCode", "localityCity", "localityRegion"]) {
      expect(() => monitoringQuerySchema.parse({ ...BASE, [field]: "   " })).toThrow();
    }
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

  it("defaults the locality to null when a caller says nothing about it", () => {
    const { postalCode, localityCity, localityRegion, ...withoutLocality } = BASE;
    void postalCode;
    void localityCity;
    void localityRegion;

    const parsed = createMonitoringQueryInputSchema.parse(withoutLocality);

    expect(parsed.postalCode).toBeNull();
    expect(parsed.localityCity).toBeNull();
    expect(parsed.localityRegion).toBeNull();
  });
});

describe("updateMonitoringQueryInputSchema", () => {
  it("strips lastPolledAt: only the poll service may advance the cursor", () => {
    const parsed = updateMonitoringQueryInputSchema.parse({
      ...BASE,
      lastPolledAt: "2026-08-04T00:00:00.000Z",
    });
    expect(parsed).not.toHaveProperty("lastPolledAt");
  });

  it("leaves an omitted locality field absent rather than nulling it", () => {
    // The reason `monitoringQuerySchema` carries no "a postal code needs a
    // country" refinement: a patch that changes only the name has no country
    // in it to check the stored postal code against, and the repository must
    // be able to tell "not mentioned" from "cleared".
    const parsed = updateMonitoringQueryInputSchema.parse({ name: "Renamed" });

    expect(parsed).not.toHaveProperty("postalCode");
    expect(parsed).not.toHaveProperty("localityCity");
    expect(parsed).not.toHaveProperty("localityRegion");
  });

  it("carries an explicit null through, so a locality can be cleared", () => {
    const parsed = updateMonitoringQueryInputSchema.parse({
      postalCode: null,
      localityCity: null,
      localityRegion: null,
    });

    expect(parsed.postalCode).toBeNull();
    expect(parsed.localityCity).toBeNull();
    expect(parsed.localityRegion).toBeNull();
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

describe("newsRejectedCandidateSchema", () => {
  it("rejects a score outside 0 to 1", () => {
    expect(() =>
      newsRejectedCandidateSchema.parse({
        id: BASE.id,
        organizationId: BASE.organizationId,
        monitoringQueryId: BASE.id,
        newsPollRunId: BASE.id,
        externalId: "article-123",
        url: "https://example.com/article",
        title: "A headline",
        publisherDomain: "example.com",
        reason: "below_threshold",
        score: 1.5,
        publishedAt: BASE.createdAt,
        createdAt: BASE.createdAt,
        updatedAt: BASE.updatedAt,
      }),
    ).toThrow();
  });
});

describe("gateRejectionReasonSchema", () => {
  it("accepts each of the four valid reasons", () => {
    for (const reason of [
      "excluded_term",
      "probable_syndication",
      "domain_denied",
      "below_threshold",
    ] as const) {
      expect(gateRejectionReasonSchema.parse(reason)).toBe(reason);
    }
  });

  it("rejects an unknown reason", () => {
    expect(() => gateRejectionReasonSchema.parse("made_up_reason")).toThrow();
  });
});
