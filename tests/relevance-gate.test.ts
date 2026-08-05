import { describe, expect, it } from "vitest";
import { evaluateCandidate, normaliseHeadline } from "@/lib/monitoring/gate";
import type { MonitoringQuery } from "@/domain";
import type { ExternalArticle } from "@/news/monitor";

const NOW = "2026-08-04T12:00:00.000Z";

const QUERY: MonitoringQuery = {
  id: "11111111-1111-4111-8111-111111111111",
  organizationId: "22222222-2222-4222-8222-222222222222",
  locationId: null,
  name: "Brand mentions",
  queryType: "brand",
  keywords: ["Gramercy Tavern"],
  exclusions: ["obituary"],
  allowedDomains: [],
  deniedDomains: ["contentfarm.example"],
  sourceCountry: "us",
  language: "en",
  relevanceThreshold: 0.35,
  enabled: true,
  pollIntervalMinutes: 360,
  lastPolledAt: null,
  createdAt: NOW,
  updatedAt: NOW,
};

function article(overrides: Partial<ExternalArticle> = {}): ExternalArticle {
  return {
    externalId: "https://paper.example/a",
    url: "https://paper.example/a",
    title: "Gramercy Tavern reopens after renovation",
    description: "The restaurant welcomes diners back this week.",
    publisherName: "Paper",
    publisherDomain: "paper.example",
    authorName: null,
    publishedAt: "2026-08-04T09:00:00.000Z",
    language: "en",
    metadata: {},
    ...overrides,
  };
}

function context(overrides: Partial<Parameters<typeof evaluateCandidate>[1]> = {}) {
  return { query: QUERY, now: NOW, recentHeadlines: [], ...overrides };
}

describe("normaliseHeadline", () => {
  it("collapses case, punctuation, and whitespace", () => {
    expect(normaliseHeadline("Gramercy Tavern  Reopens!")).toBe(
      "gramercy tavern reopens",
    );
  });

  it("makes two syndicated copies of one story identical", () => {
    expect(normaliseHeadline("Chef named 'Best in City'")).toBe(
      normaliseHeadline("Chef Named “Best in City”"),
    );
  });
});

describe("hard rejections", () => {
  it("rejects an excluded term found in the title", () => {
    const verdict = evaluateCandidate(
      article({ title: "Gramercy Tavern founder obituary" }),
      context(),
    );
    expect(verdict).toMatchObject({ admitted: false, reason: "excluded_term" });
  });

  it("rejects an excluded term found in the description", () => {
    const verdict = evaluateCandidate(
      article({ description: "A full obituary follows." }),
      context(),
    );
    expect(verdict).toMatchObject({ admitted: false, reason: "excluded_term" });
  });

  it("rejects a denied domain", () => {
    const verdict = evaluateCandidate(
      article({ publisherDomain: "contentfarm.example" }),
      context(),
    );
    expect(verdict).toMatchObject({ admitted: false, reason: "domain_denied" });
  });

  it("rejects a headline already seen inside the syndication window", () => {
    const verdict = evaluateCandidate(
      article(),
      context({
        recentHeadlines: [
          {
            headline: normaliseHeadline("Gramercy Tavern reopens after renovation"),
            seenAt: "2026-08-03T09:00:00.000Z",
          },
        ],
      }),
    );
    expect(verdict).toMatchObject({
      admitted: false,
      reason: "probable_syndication",
    });
  });

  it("admits a repeat once the syndication window has passed", () => {
    const verdict = evaluateCandidate(
      article(),
      context({
        recentHeadlines: [
          {
            headline: normaliseHeadline("Gramercy Tavern reopens after renovation"),
            seenAt: "2026-07-20T09:00:00.000Z",
          },
        ],
      }),
    );
    expect(verdict.admitted).toBe(true);
  });

  it("checks exclusions before syndication, so the reason is the strongest one", () => {
    const verdict = evaluateCandidate(
      article({ title: "Gramercy Tavern obituary" }),
      context({
        recentHeadlines: [
          { headline: normaliseHeadline("Gramercy Tavern obituary"), seenAt: NOW },
        ],
      }),
    );
    expect(verdict).toMatchObject({ admitted: false, reason: "excluded_term" });
  });
});

describe("scoring", () => {
  it("admits a title match", () => {
    const verdict = evaluateCandidate(article(), context());
    expect(verdict.admitted).toBe(true);
    expect(verdict.score).toBeGreaterThanOrEqual(0.5);
  });

  it("scores a description-only match below a title match", () => {
    const titleOnly = evaluateCandidate(article(), context());
    const descriptionOnly = evaluateCandidate(
      article({
        title: "A restaurant reopens downtown",
        description: "Gramercy Tavern welcomes diners back.",
      }),
      context(),
    );
    expect(descriptionOnly.score).toBeLessThan(titleOnly.score);
  });

  it("rejects an article matching nothing", () => {
    const verdict = evaluateCandidate(
      article({ title: "City council debates parking", description: "No mention." }),
      context(),
    );
    expect(verdict).toMatchObject({ admitted: false, reason: "below_threshold" });
    expect(verdict.score).toBe(0);
  });

  it("penalises a short single-word brand matched only once", () => {
    const ambiguous: MonitoringQuery = { ...QUERY, keywords: ["Bond"] };
    const verdict = evaluateCandidate(
      article({ title: "Bond markets rally", description: "Yields fell." }),
      context({ query: ambiguous }),
    );
    expect(verdict.admitted).toBe(false);
  });

  it("does not penalise a short brand when a second keyword also matches", () => {
    const ambiguous: MonitoringQuery = {
      ...QUERY,
      keywords: ["Bond", "Union Square"],
    };
    const verdict = evaluateCandidate(
      article({
        title: "Bond opens in Union Square",
        description: "The new restaurant debuts.",
      }),
      context({ query: ambiguous }),
    );
    expect(verdict.admitted).toBe(true);
  });

  it("boosts a location query published by an allowed local outlet", () => {
    const local: MonitoringQuery = {
      ...QUERY,
      queryType: "location",
      allowedDomains: ["paper.example"],
    };
    const boosted = evaluateCandidate(article(), context({ query: local }));
    const plain = evaluateCandidate(article(), context());
    expect(boosted.score).toBeGreaterThan(plain.score);
  });

  it("never returns a score outside 0 to 1", () => {
    const everything: MonitoringQuery = {
      ...QUERY,
      queryType: "location",
      keywords: ["Gramercy Tavern", "renovation", "diners"],
      allowedDomains: ["paper.example"],
    };
    const verdict = evaluateCandidate(article(), context({ query: everything }));
    expect(verdict.score).toBeLessThanOrEqual(1);
    expect(verdict.score).toBeGreaterThanOrEqual(0);
  });

  it("respects a raised threshold", () => {
    const strict: MonitoringQuery = { ...QUERY, relevanceThreshold: 0.95 };
    const verdict = evaluateCandidate(article(), context({ query: strict }));
    expect(verdict).toMatchObject({ admitted: false, reason: "below_threshold" });
  });
});
