import { NO_CAPABILITIES, type ConnectorCapabilities, type Platform } from "@/domain";
import type { ExternalArticle, NewsMonitor, NewsSearchBatch, NewsSearchQuery } from "@/news/monitor";

/**
 * A news monitor that never touches the network.
 *
 * Exists so the ingestion pipeline, the relevance gate (Task 9), and the
 * mentions UI can be exercised end to end without a GNews API key — including
 * by anyone picking this repository up for the first time. Mirrors
 * `createMockGoogleConnector`'s three properties:
 *
 * - **Isolated.** Nothing outside `src/news/registry.ts` knows this exists.
 * - **Deterministic.** No `Math.random()`, no `Date.now()`, no bare `new
 *   Date()` — the same query returns the same articles, in the same order,
 *   forever. That is the entire point: a gate test asserting on this fixture
 *   set is asserting on a contract, not on today's date.
 * - **Refused in production.** `resolveNewsMode()` throws when
 *   `NODE_ENV=production`, so this module can never be the thing serving a
 *   customer.
 *
 * The fixture set is deliberately awkward, because a tidy one would leave the
 * cases Task 9's relevance gate exists to handle untested by anyone
 * developing against the mock:
 *
 * - three articles that genuinely cover the keyword, naming it in the title;
 * - two that only mention it in passing, inside the description, where a
 *   naive title-only match would miss them;
 * - two that do not concern the keyword at all, so the gate has something to
 *   reject;
 * - two wire-service pickups sharing one identical headline across different
 *   domains, so syndication collapsing has something to fold together.
 *
 * The keyword is woven into the titles/descriptions rather than hard-coded,
 * so the fixture set stays meaningful for whichever restaurant name or brand
 * term a location is actually watching, not just the one used in tests.
 */

const MOCK_CAPABILITIES: ConnectorCapabilities = {
  ...NO_CAPABILITIES,
  canReadMentions: true,
};

/** Lowercase, hyphenated — stable across calls, safe inside a URL path segment. */
function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "keyword"
  );
}

/**
 * The fixed fixture set for one primary keyword.
 *
 * Nine hand-written entries, each satisfying `ExternalArticle` exactly —
 * including explicit `null`s for fields a real provider might not supply,
 * rather than omitting them.
 */
function buildFixtureArticles(primaryKeyword: string): ExternalArticle[] {
  const slug = slugify(primaryKeyword);

  return [
    // -- Genuine matches: the keyword is in the headline. --------------------
    {
      externalId: `mock-news:${slug}:award-seasonal-menu`,
      url: `https://www.example-times.test/dining/${slug}-wins-award-seasonal-menu`,
      title: `${primaryKeyword} wins award for best seasonal menu`,
      description: `Critics praised ${primaryKeyword} for a tasting menu built around what the market had that week.`,
      publisherName: "The Example Times",
      publisherDomain: "example-times.test",
      authorName: "Priya Shah",
      publishedAt: "2026-06-02T14:00:00.000Z",
      language: "en",
      metadata: { imageUrl: null, sourceUrl: null },
    },
    {
      externalId: `mock-news:${slug}:opens-private-dining`,
      url: `https://www.example-eats.test/news/${slug}-opens-private-dining-room`,
      title: `${primaryKeyword} opens new private dining room`,
      description: `The expansion adds a twelve-seat room for private bookings starting next month.`,
      publisherName: "Example Eats",
      publisherDomain: "example-eats.test",
      authorName: "Marco Diaz",
      publishedAt: "2026-06-10T09:30:00.000Z",
      language: "en",
      metadata: { imageUrl: null, sourceUrl: null },
    },
    {
      externalId: `mock-news:${slug}:chef-farm-to-table`,
      url: `https://www.example-food-wine.test/features/${slug}-chef-farm-to-table`,
      title: `Chef at ${primaryKeyword} discusses farm-to-table sourcing`,
      description: `An interview about the relationships behind the restaurant's produce.`,
      publisherName: "Example Food & Wine",
      publisherDomain: "example-food-wine.test",
      // A byline the provider did not supply. Explicit null, not an omission.
      authorName: null,
      publishedAt: "2026-06-15T17:45:00.000Z",
      language: "en",
      metadata: { imageUrl: null, sourceUrl: null },
    },

    // -- Matches only in the description, where a title-only scan would miss.
    {
      externalId: `mock-news:${slug}:staffing-roundup`,
      url: "https://www.example-restaurant-business.test/labor/staffing-roundup",
      title: "Restaurant group navigates staffing shortages citywide",
      description: `Industry roundup features comments from ${primaryKeyword} and five other venues about hiring challenges.`,
      publisherName: "Example Restaurant Business",
      publisherDomain: "example-restaurant-business.test",
      authorName: "Jamie Lin",
      publishedAt: "2026-06-08T11:15:00.000Z",
      language: "en",
      metadata: { imageUrl: null, sourceUrl: null },
    },
    {
      externalId: `mock-news:${slug}:critics-talking-list`,
      url: "https://www.example-timeout.test/dining/ten-places-critics-talking-about",
      title: "Ten places critics are talking about this month",
      description: `The list includes ${primaryKeyword}, known for its seasonal tasting menu, alongside newcomers across the city.`,
      publisherName: "Example Time Out",
      publisherDomain: "example-timeout.test",
      authorName: null,
      publishedAt: "2026-06-12T08:00:00.000Z",
      language: "en",
      metadata: { imageUrl: null, sourceUrl: null },
    },

    // -- No match at all: the gate has something to reject. ------------------
    {
      externalId: "mock-news:unrelated:bike-lane-network",
      url: "https://www.example-city-news.test/transportation/bike-lane-network-approved",
      title: "City council approves new bike lane network",
      description: "The plan adds protected lanes to twelve corridors over the next two years.",
      publisherName: "The Example City",
      publisherDomain: "example-city-news.test",
      authorName: "Alex Chen",
      publishedAt: "2026-06-05T13:20:00.000Z",
      language: "en",
      metadata: { imageUrl: null, sourceUrl: null },
    },
    {
      externalId: "mock-news:unrelated:interest-rates",
      url: "https://www.example-wire.test/business/reserve-holds-rates-steady",
      title: "Federal Reserve holds interest rates steady",
      // A provider that supplies no summary at all — explicit null.
      description: null,
      publisherName: "Example Wire Service",
      publisherDomain: "example-wire.test",
      authorName: null,
      publishedAt: "2026-06-01T20:00:00.000Z",
      language: "en",
      metadata: { imageUrl: null, sourceUrl: null },
    },

    // -- Identical headline, two domains: syndication has something to collapse.
    {
      externalId: `mock-news:${slug}:romantic-list-wire`,
      url: `https://www.example-wire.test/lifestyle/${slug}-named-most-romantic-restaurants`,
      title: `${primaryKeyword} named to list of most romantic restaurants`,
      description: `The annual roundup includes ${primaryKeyword} among a dozen picks for date night.`,
      publisherName: "Example Wire Service",
      publisherDomain: "example-wire.test",
      // Wire copy: no byline carried through to the syndicating outlets.
      authorName: null,
      publishedAt: "2026-06-18T10:00:00.000Z",
      language: "en",
      metadata: { imageUrl: null, sourceUrl: null },
    },
    {
      externalId: `mock-news:${slug}:romantic-list-local-pickup`,
      url: `https://www.example-local-gazette.test/wire/${slug}-named-most-romantic-restaurants`,
      title: `${primaryKeyword} named to list of most romantic restaurants`,
      description: `The annual roundup includes ${primaryKeyword} among a dozen picks for date night.`,
      publisherName: "The Example Local Gazette",
      publisherDomain: "example-local-gazette.test",
      authorName: null,
      publishedAt: "2026-06-18T10:05:00.000Z",
      language: "en",
      metadata: { imageUrl: null, sourceUrl: null },
    },
  ];
}

export class MockNewsMonitor implements NewsMonitor {
  readonly platform: Platform = "news_media";

  capabilities(): ConnectorCapabilities {
    return MOCK_CAPABILITIES;
  }

  search(query: NewsSearchQuery): Promise<NewsSearchBatch> {
    // The first keyword drives the fixture text. A query always has at least
    // one — callers that build `NewsSearchQuery` are required to supply it —
    // but this falls back to a stable placeholder rather than throwing, since
    // a monitor's job is to return a batch, not to validate its caller.
    const primaryKeyword = query.keywords[0]?.trim() || "the property";
    const articles = buildFixtureArticles(primaryKeyword).slice(0, query.maxResults);

    return Promise.resolve({
      articles,
      requestsSpent: 1,
      truncated: false,
      malformedCount: 0,
    });
  }
}
