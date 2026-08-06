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

  it("collapses dash spacing so a spaced and unspaced em dash match", () => {
    expect(normaliseHeadline("Reopens—Again")).toBe(normaliseHeadline("Reopens — Again"));
  });

  it("normalises composed and decomposed accents to the same string", () => {
    const nfc = "Caf\u00e9 reopens"; // \u00e9 as a single precomposed code point
    const nfd = "Cafe\u0301 reopens"; // e + combining acute accent (U+0301)
    expect(normaliseHeadline(nfc)).toBe(normaliseHeadline(nfd));
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
    expect(verdict).toMatchObject({ admitted: false, reason: "no_keyword_match" });
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

describe("ambiguity corroboration", () => {
  const ambiguous: MonitoringQuery = { ...QUERY, keywords: ["Bond"] };

  it("rejects the ambiguous term even when it also matches in the description", () => {
    // The description is often the lede, so a real GNews summary of a bond-
    // market story says "bond" too. Matching in a second *field* is not a
    // second *term* — it must not cancel the rejection.
    const verdict = evaluateCandidate(
      article({
        title: "Bond markets rally",
        description: "Bond yields fell to a low.",
      }),
      context({ query: ambiguous }),
    );
    expect(verdict.admitted).toBe(false);
  });

  it("rejects the ambiguous term repeated across title and description in a different story", () => {
    const verdict = evaluateCandidate(
      article({
        title: "New James Bond film",
        description: "The Bond franchise returns to theaters this fall.",
      }),
      context({ query: ambiguous }),
    );
    expect(verdict.admitted).toBe(false);
  });

  it("still admits a second, distinct matching keyword", () => {
    const twoKeywords: MonitoringQuery = { ...QUERY, keywords: ["Bond", "Union Square"] };
    const verdict = evaluateCandidate(
      article({
        title: "Bond opens in Union Square",
        description: "The new restaurant debuts.",
      }),
      context({ query: twoKeywords }),
    );
    expect(verdict.admitted).toBe(true);
  });

  it("admits an ambiguous term corroborated by an allowed local outlet", () => {
    const local: MonitoringQuery = {
      ...QUERY,
      queryType: "location",
      keywords: ["Bond"],
      allowedDomains: ["paper.example"],
    };
    const verdict = evaluateCandidate(
      article({ title: "Bond opens today", description: "A new spot opens." }),
      context({ query: local }),
    );
    expect(verdict.admitted).toBe(true);
  });

  it("admits an ambiguous term corroborated by an allowed domain on a non-location query", () => {
    // Unlike LOCAL_OUTLET_BONUS, locality corroboration is not gated on
    // queryType === "location": an operator who explicitly allow-lists a
    // publisher has given corroborating evidence regardless of query type.
    const brandWithAllowedDomain: MonitoringQuery = {
      ...QUERY,
      queryType: "brand",
      keywords: ["Bond"],
      allowedDomains: ["paper.example"],
    };
    const verdict = evaluateCandidate(
      article({ title: "Bond opens today", description: "A new spot opens." }),
      context({ query: brandWithAllowedDomain }),
    );
    expect(verdict.admitted).toBe(true);
  });

  it("reports ambiguous_uncorroborated with a real score, not a non-match", () => {
    const verdict = evaluateCandidate(
      article({ title: "Bond markets rally", description: "Yields fell." }),
      context({ query: ambiguous }),
    );
    expect(verdict).toMatchObject({
      admitted: false,
      reason: "ambiguous_uncorroborated",
    });
    expect(verdict.score).toBeGreaterThan(0);
  });

  // The case no existing test covered, and the reason this change exists. A
  // lone ambiguous term can score well above the threshold and still be
  // rejected, because corroboration is a hard requirement rather than a
  // weight. Reported as `below_threshold` this reads as a contradiction and
  // sends an operator to tune a dial that is not connected to anything.
  //
  // Modelled on the live poll: an eight-character brand name matching in both
  // title and description scored 0.7 against a 0.35 threshold.
  it("rejects a high-scoring ambiguous match without calling it below threshold", () => {
    const verdict = evaluateCandidate(
      article({
        title: "Chipotle pulls jalapeños after outbreak",
        description: "Chipotle removed the peppers from some restaurants.",
      }),
      context({ query: { ...QUERY, keywords: ["Chipotle"] } }),
    );

    expect(verdict.admitted).toBe(false);
    expect(verdict.score).toBeGreaterThan(QUERY.relevanceThreshold);
    expect(verdict).toMatchObject({ reason: "ambiguous_uncorroborated" });
  });
});

describe("overlapping keyword evidence", () => {
  it("does not let a case-only duplicate keyword corroborate an ambiguous term", () => {
    const caseDuplicate: MonitoringQuery = { ...QUERY, keywords: ["Bond", "bond"] };
    const verdict = evaluateCandidate(
      article({ title: "Bond markets rally", description: "Yields fell." }),
      context({ query: caseDuplicate }),
    );
    expect(verdict.admitted).toBe(false);
  });

  it("does not award the multi-keyword bonus for a keyword that is a substring of another matched keyword", () => {
    const overlapping: MonitoringQuery = { ...QUERY, keywords: ["Bond", "Bond NYC"] };
    const withOverlap = evaluateCandidate(
      article({
        title: "Bond NYC opens for business",
        description: "The new restaurant debuts.",
      }),
      context({ query: overlapping }),
    );
    const singleKeyword: MonitoringQuery = { ...QUERY, keywords: ["Bond NYC"] };
    const withoutOverlap = evaluateCandidate(
      article({
        title: "Bond NYC opens for business",
        description: "The new restaurant debuts.",
      }),
      context({ query: singleKeyword }),
    );
    expect(withOverlap.score).toBe(withoutOverlap.score);
  });
});

describe("keyword text normalisation", () => {
  it("matches across doubled whitespace", () => {
    const verdict = evaluateCandidate(
      article({ title: "Gramercy  Tavern reopens", description: "" }),
      context(),
    );
    expect(verdict.admitted).toBe(true);
  });

  it("matches across a non-breaking space", () => {
    const verdict = evaluateCandidate(
      article({ title: "Gramercy Tavern reopens", description: "" }),
      context(),
    );
    expect(verdict.admitted).toBe(true);
  });

  it("matches a straight-quote keyword against a curly-quote headline", () => {
    // "Carbone's" is 9 characters (above AMBIGUOUS_TERM_MAX_LENGTH), so this
    // isolates quote folding from the separate ambiguity-corroboration rule.
    const query: MonitoringQuery = { ...QUERY, keywords: ["Carbone's"] };
    const verdict = evaluateCandidate(
      article({ title: "Carbone’s opens a second location", description: "" }),
      context({ query }),
    );
    expect(verdict.admitted).toBe(true);
  });

  it("still matches a keyword embedded in a longer word via case-insensitive substring", () => {
    const verdict = evaluateCandidate(
      article({ title: "GRAMERCY TAVERN'S NEW CHEF", description: "" }),
      context(),
    );
    expect(verdict.admitted).toBe(true);
  });

  it("matches a keyword and a title using different Unicode normalisation forms", () => {
    // Keyword is NFD (e + combining acute accent); title is NFC (precomposed
    // é). Explicit escapes, not literal accented characters, so the two
    // forms are unambiguous regardless of how this source file is encoded.
    // Has an internal space, so this is independent of the ambiguity rule.
    const nfdKeyword = "Café Loup";
    const nfcTitleFragment = "Caf\u00e9 Loup";
    const query: MonitoringQuery = { ...QUERY, keywords: [nfdKeyword] };
    const verdict = evaluateCandidate(
      article({ title: `${nfcTitleFragment} reopens downtown`, description: "" }),
      context({ query }),
    );
    expect(verdict.admitted).toBe(true);
  });
});

describe("exclusions", () => {
  it("does not reject a short exclusion term embedded in a longer word", () => {
    const query: MonitoringQuery = { ...QUERY, exclusions: ["bar"] };
    const verdict = evaluateCandidate(
      article({ title: "Gramercy Tavern's barbecue night", description: "" }),
      context({ query }),
    );
    expect(verdict.admitted).toBe(true);
  });

  it("does not reject an exclusion phrase that only matches across the title/description join", () => {
    const query: MonitoringQuery = { ...QUERY, exclusions: ["shut down"] };
    const verdict = evaluateCandidate(
      article({
        title: "Gramercy Tavern staff shut",
        description: "down for cleaning today.",
      }),
      context({ query }),
    );
    expect(verdict.admitted).toBe(true);
  });

  it("still rejects a whole-word exclusion found in a single field", () => {
    const query: MonitoringQuery = { ...QUERY, exclusions: ["renovation"] };
    const verdict = evaluateCandidate(article(), context({ query }));
    expect(verdict).toMatchObject({ admitted: false, reason: "excluded_term" });
  });

  it("rejects an accented exclusion term next to non-word boundaries", () => {
    // Regression for the ASCII-only `\b`: "é" is not an ASCII word character,
    // so the old boundary check silently failed to match "café" at all.
    const query: MonitoringQuery = { ...QUERY, exclusions: ["café"] };
    const verdict = evaluateCandidate(
      article({ title: "Gramercy Tavern café closes", description: "" }),
      context({ query }),
    );
    expect(verdict).toMatchObject({ admitted: false, reason: "excluded_term" });
  });

  it("rejects a non-Latin exclusion term", () => {
    const query: MonitoringQuery = { ...QUERY, exclusions: ["некролог"] };
    const verdict = evaluateCandidate(
      article({
        title: "Gramercy Tavern некролог today",
        description: "",
      }),
      context({ query }),
    );
    expect(verdict).toMatchObject({ admitted: false, reason: "excluded_term" });
  });

  it("rejects a punctuation-terminated exclusion term", () => {
    const query: MonitoringQuery = { ...QUERY, exclusions: ["R.I.P."] };
    const verdict = evaluateCandidate(
      article({ title: "Gramercy Tavern founder R.I.P.", description: "" }),
      context({ query }),
    );
    expect(verdict).toMatchObject({ admitted: false, reason: "excluded_term" });
  });

  // "bar"/"barbecue" and the "shut down" title/description join case are
  // already covered above — the properties round 1 bought — and the whole
  // block re-runs them under the round 2 Unicode-aware matcher, so no
  // separate "regression" duplicates are needed here.
});

describe("domain suffix matching", () => {
  it("rejects a subdomain of a denied domain", () => {
    const verdict = evaluateCandidate(
      article({ publisherDomain: "amp.contentfarm.example" }),
      context(),
    );
    expect(verdict).toMatchObject({ admitted: false, reason: "domain_denied" });
  });

  it("boosts a subdomain of an allowed local outlet", () => {
    const local: MonitoringQuery = {
      ...QUERY,
      queryType: "location",
      allowedDomains: ["paper.example"],
    };
    const boosted = evaluateCandidate(
      article({ publisherDomain: "blogs.paper.example" }),
      context({ query: local }),
    );
    const plain = evaluateCandidate(
      article({ publisherDomain: "blogs.paper.example" }),
      context(),
    );
    expect(boosted.score).toBeGreaterThan(plain.score);
  });
});

describe("syndication ordering", () => {
  it("reports no_keyword_match, not probable_syndication, for a non-matching article that shares a headline", () => {
    const verdict = evaluateCandidate(
      article({ title: "City council debates parking", description: "No mention." }),
      context({
        recentHeadlines: [
          {
            headline: normaliseHeadline("City council debates parking"),
            seenAt: "2026-08-03T09:00:00.000Z",
          },
        ],
      }),
    );
    expect(verdict).toMatchObject({ admitted: false, reason: "no_keyword_match" });
  });
});

describe("invalid timestamps", () => {
  it("throws rather than silently disabling syndication detection for an unparseable now", () => {
    expect(() =>
      evaluateCandidate(article(), context({ now: "not-a-timestamp" })),
    ).toThrow(/context\.now is not a valid ISO timestamp/);
  });

  it("throws rather than silently disabling syndication detection for an unparseable seenAt", () => {
    expect(() =>
      evaluateCandidate(
        article(),
        context({
          recentHeadlines: [{ headline: "whatever", seenAt: "not-a-timestamp" }],
        }),
      ),
    ).toThrow(/recentHeadlines\[\]\.seenAt is not a valid ISO timestamp/);
  });
});
