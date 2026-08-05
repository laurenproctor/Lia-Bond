import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("resolveNewsMode", () => {
  it("returns mock when the mode says so outside production", async () => {
    vi.stubEnv("LIA_NEWS_MODE", "mock");
    vi.stubEnv("NODE_ENV", "development");
    const { resolveNewsMode } = await import("@/lib/env");
    expect(resolveNewsMode()).toBe("mock");
  });

  it("refuses the mock in production", async () => {
    vi.stubEnv("LIA_NEWS_MODE", "mock");
    vi.stubEnv("NODE_ENV", "production");
    // Refused at environment parse (see the schema refinement in
    // `src/lib/env.ts`): the module throws on import, before `resolveNewsMode`
    // is ever reached, the same way `google-mock-mode.test.ts` verifies
    // `GOOGLE_INTEGRATION_MODE=mock`. The brief's verbatim version of this
    // test (`const { resolveNewsMode } = await import(...)` then
    // `expect(() => resolveNewsMode()).toThrow()`) cannot pass alongside that
    // refinement, since the import itself rejects first — this is corrected to
    // match the established idiom rather than weakened to hide the throw.
    await expect(import("@/lib/env")).rejects.toThrow(
      /LIA_NEWS_MODE=mock is refused in production/,
    );
  });

  it("reports unconfigured when no mode and no key are set", async () => {
    vi.stubEnv("LIA_NEWS_MODE", "");
    vi.stubEnv("GNEWS_API_KEY", "");
    const { resolveNewsMode } = await import("@/lib/env");
    expect(resolveNewsMode()).toBe("unconfigured");
  });
});

describe("MockNewsMonitor", () => {
  it("returns the same articles for the same query", async () => {
    const { MockNewsMonitor } = await import("@/news/mock-monitor");
    const monitor = new MockNewsMonitor();
    const query = {
      keywords: ["Gramercy Tavern"],
      exclusions: [],
      sourceCountry: "us",
      language: "en",
      publishedAfter: null,
      maxResults: 10,
    };

    const first = await monitor.search(query);
    const second = await monitor.search(query);

    expect(first.articles.map((a) => a.externalId)).toEqual(
      second.articles.map((a) => a.externalId),
    );
    expect(first.articles.length).toBeGreaterThan(0);
  });

  it("returns a mix the gate will both admit and reject", async () => {
    const { MockNewsMonitor } = await import("@/news/mock-monitor");
    const batch = await new MockNewsMonitor().search({
      keywords: ["Gramercy Tavern"],
      exclusions: [],
      sourceCountry: "us",
      language: "en",
      publishedAfter: null,
      maxResults: 10,
    });

    const titles = batch.articles.map((a) => a.title.toLowerCase());
    expect(titles.some((t) => t.includes("gramercy tavern"))).toBe(true);
    expect(titles.some((t) => !t.includes("gramercy tavern"))).toBe(true);
  });
});
