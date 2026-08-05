import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GNewsMonitor } from "@/news/gnews/monitor";
import { buildGNewsQuery, normaliseGNewsArticle } from "@/news/gnews/normalise";
import { NewsError } from "@/news/errors";

const ARTICLE = {
  title: "Gramercy Tavern reopens after renovation",
  description: "The Union Square restaurant welcomes diners back.",
  content: "truncated on the free tier...",
  url: "https://example-paper.com/food/gramercy-reopens",
  image: "https://example-paper.com/img.jpg",
  publishedAt: "2026-08-03T09:00:00Z",
  source: { name: "Example Paper", url: "https://example-paper.com" },
};

const QUERY = {
  keywords: ["Gramercy Tavern"],
  exclusions: ["obituary"],
  sourceCountry: "us",
  language: "en",
  publishedAfter: "2026-08-01T00:00:00.000Z",
  maxResults: 10,
};

function stubFetch(status: number, body: unknown) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.stubEnv("GNEWS_API_KEY", "test-key");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("buildGNewsQuery", () => {
  it("quotes multi-word keywords and negates exclusions", () => {
    expect(buildGNewsQuery(QUERY)).toBe('"Gramercy Tavern" NOT obituary');
  });

  it("joins several keywords with OR", () => {
    expect(
      buildGNewsQuery({ ...QUERY, keywords: ["Gramercy Tavern", "Maialino"], exclusions: [] }),
    ).toBe('"Gramercy Tavern" OR Maialino');
  });

  it("groups a multi-keyword disjunction before negating, so NOT cannot bind to the last term alone", () => {
    expect(
      buildGNewsQuery({ ...QUERY, keywords: ["Gramercy Tavern", "Maialino"], exclusions: ["obituary"] }),
    ).toBe('("Gramercy Tavern" OR Maialino) NOT obituary');
  });
});

describe("normaliseGNewsArticle", () => {
  it("maps a well-formed article", () => {
    const result = normaliseGNewsArticle(ARTICLE);
    expect(result).not.toBeNull();
    expect(result?.externalId).toBe(ARTICLE.url);
    expect(result?.publisherDomain).toBe("example-paper.com");
    expect(result?.publisherName).toBe("Example Paper");
    expect(result?.publishedAt).toBe("2026-08-03T09:00:00.000Z");
  });

  it("returns null rather than throwing on a missing url", () => {
    expect(normaliseGNewsArticle({ ...ARTICLE, url: undefined })).toBeNull();
  });

  it("does not carry the truncated content field through", () => {
    const result = normaliseGNewsArticle(ARTICLE);
    expect(JSON.stringify(result?.metadata)).not.toContain("truncated on the free tier");
  });
});

describe("GNewsMonitor.search", () => {
  it("returns normalised articles and counts one request", async () => {
    const fetchStub = stubFetch(200, { totalArticles: 1, articles: [ARTICLE] });
    const monitor = new GNewsMonitor(fetchStub as unknown as typeof fetch);

    const batch = await monitor.search(QUERY);

    expect(batch.articles).toHaveLength(1);
    expect(batch.requestsSpent).toBe(1);
    expect(batch.malformedCount).toBe(0);
  });

  it("counts a malformed article without losing the others", async () => {
    const fetchStub = stubFetch(200, {
      totalArticles: 2,
      articles: [ARTICLE, { title: "no url here" }],
    });
    const monitor = new GNewsMonitor(fetchStub as unknown as typeof fetch);

    const batch = await monitor.search(QUERY);

    expect(batch.articles).toHaveLength(1);
    expect(batch.malformedCount).toBe(1);
  });

  it("flags truncation when the provider filled the page", async () => {
    const fetchStub = stubFetch(200, {
      totalArticles: 57,
      articles: Array.from({ length: 10 }, () => ARTICLE),
    });
    const monitor = new GNewsMonitor(fetchStub as unknown as typeof fetch);

    expect((await monitor.search(QUERY)).truncated).toBe(true);
  });

  it("throws not_configured before any request when the api key is missing", async () => {
    vi.stubEnv("GNEWS_API_KEY", "");
    const fetchStub = vi.fn();
    const monitor = new GNewsMonitor(fetchStub as unknown as typeof fetch);

    await expect(monitor.search(QUERY)).rejects.toMatchObject({
      code: "not_configured",
      retryable: false,
    });
    expect(fetchStub).not.toHaveBeenCalled();
  });

  it("maps 400 to invalid_query and does not retry", async () => {
    const fetchStub = stubFetch(400, { errors: ["invalid query syntax"] });
    const monitor = new GNewsMonitor(fetchStub as unknown as typeof fetch);

    await expect(monitor.search(QUERY)).rejects.toMatchObject({
      code: "invalid_query",
      retryable: false,
    });
  });

  it("maps an unmapped 4xx status to a non-retryable error", async () => {
    const fetchStub = stubFetch(404, { errors: ["not found"] });
    const monitor = new GNewsMonitor(fetchStub as unknown as typeof fetch);

    await expect(monitor.search(QUERY)).rejects.toMatchObject({
      retryable: false,
    });
  });

  it("wraps a rejected fetch as a retryable provider error without leaking its message", async () => {
    const fetchStub = vi.fn().mockRejectedValue(new Error("getaddrinfo ENOTFOUND gnews.io"));
    const monitor = new GNewsMonitor(fetchStub as unknown as typeof fetch);

    const error = await monitor.search(QUERY).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(NewsError);
    expect((error as NewsError).code).toBe("provider_error");
    expect((error as NewsError).retryable).toBe(true);
    expect((error as NewsError).message).not.toContain("ENOTFOUND");
    expect((error as NewsError).message).not.toContain("gnews.io");
  });

  it("treats a response that fails the envelope schema as a retryable provider error", async () => {
    const fetchStub = stubFetch(200, { unexpected: "shape" });
    const monitor = new GNewsMonitor(fetchStub as unknown as typeof fetch);

    await expect(monitor.search(QUERY)).rejects.toMatchObject({
      code: "provider_error",
      retryable: true,
    });
  });

  it("maps 401 to unauthorized and does not retry", async () => {
    const fetchStub = stubFetch(401, { errors: ["invalid api key"] });
    const monitor = new GNewsMonitor(fetchStub as unknown as typeof fetch);

    await expect(monitor.search(QUERY)).rejects.toMatchObject({
      code: "unauthorized",
      retryable: false,
    });
    expect(fetchStub).toHaveBeenCalledTimes(1);
  });

  it("maps 429 to rate_limited and marks it retryable", async () => {
    const fetchStub = stubFetch(429, { errors: ["too many requests"] });
    const monitor = new GNewsMonitor(fetchStub as unknown as typeof fetch);

    await expect(monitor.search(QUERY)).rejects.toMatchObject({
      code: "rate_limited",
      retryable: true,
    });
  });

  it("never puts the api key in the error message", async () => {
    const fetchStub = stubFetch(500, { errors: ["boom"] });
    const monitor = new GNewsMonitor(fetchStub as unknown as typeof fetch);

    const error = await monitor.search(QUERY).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NewsError);
    expect((error as NewsError).message).not.toContain("test-key");
    expect((error as NewsError).message).not.toContain("boom");
  });
});
