import { afterEach, describe, expect, it, vi } from "vitest";
import { MockYelpProvider } from "@/yelp/mock-provider";
import type { YelpBusinessMatchQuery } from "@/yelp/places";

/**
 * The deterministic Yelp mock, and the gate that keeps it out of production.
 *
 * Mirrors `news-mock-mode.test.ts` and `google-mock-mode.test.ts`. The
 * production refusal matters more here than for either of those: the mock's
 * output is two numbers, and two fabricated numbers on a real listing produce a
 * "review activity detected" notice with nothing on screen to give the lie
 * away.
 */

afterEach(() => {
  delete process.env.LIA_YELP_MODE;
  delete process.env.YELP_API_KEY;
  vi.unstubAllEnvs();
  vi.resetModules();
});

const MATCH_QUERY: YelpBusinessMatchQuery = {
  name: "Maison Laurent",
  addressLine1: "118 Prince Street",
  addressLine2: null,
  city: "Brooklyn",
  region: "NY",
  postalCode: "11201",
  countryCode: "US",
  phone: "+15555550101",
  limit: 10,
};

describe("registry resolution", () => {
  async function loadRegistry(vars: Record<string, string | undefined>) {
    vi.resetModules();
    for (const [key, value] of Object.entries(vars)) {
      // `NODE_ENV` is typed read-only; `vi.stubEnv` is how the rest of the
      // suite sets it (see news-mock-mode.test.ts).
      if (key === "NODE_ENV") {
        vi.stubEnv("NODE_ENV", (value ?? "development") as "development" | "production");
      } else if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    return import("@/yelp/registry");
  }

  it("serves the mock when the mode asks for it", async () => {
    const registry = await loadRegistry({
      LIA_YELP_MODE: "mock",
      NODE_ENV: "development",
    });
    expect(registry.getYelpProvider().platform).toBe("yelp");
    expect(registry.isYelpAvailable()).toBe(true);
  });

  it("refuses to build any provider when nothing is configured", async () => {
    const registry = await loadRegistry({
      LIA_YELP_MODE: undefined,
      YELP_API_KEY: undefined,
    });
    expect(registry.isYelpAvailable()).toBe(false);
    expect(() => registry.getYelpProvider()).toThrow(/not configured/i);
  });

  it("cannot serve the mock in production, because the env parse refuses first", async () => {
    await expect(
      loadRegistry({ LIA_YELP_MODE: "mock", NODE_ENV: "production" }),
    ).rejects.toThrow(/LIA_YELP_MODE/);
  });

  it("reports unavailable rather than throwing from isYelpAvailable", async () => {
    // Callers on a render path need an answer, not an exception.
    const registry = await loadRegistry({ LIA_YELP_MODE: undefined });
    expect(() => registry.isYelpAvailable()).not.toThrow();
  });
});

describe("determinism", () => {
  it("returns the same candidates, in the same order, for the same query", async () => {
    const first = await new MockYelpProvider().matchBusinesses(MATCH_QUERY);
    const second = await new MockYelpProvider().matchBusinesses(MATCH_QUERY);

    expect(first.candidates).toEqual(second.candidates);
  });

  it("derives a stable business id from the name and city", async () => {
    const result = await new MockYelpProvider().matchBusinesses(MATCH_QUERY);
    expect(result.candidates[0]?.businessId).toBe("mock-yelp-maison-laurent-brooklyn");
  });

  it("returns a baseline for a listing nobody scripted", async () => {
    const listing = await new MockYelpProvider().getBusiness("mock-yelp-example");
    expect(listing.reviewCount).toBe(128);
    expect(listing.rating).toBe(4.5);
  });
});

describe("the candidate set is deliberately awkward", () => {
  it("offers a second branch of the same restaurant, which is the real failure mode", async () => {
    // A group with several nearby sites is exactly the case where a wrong
    // mapping routes one restaurant's complaints into another's queue.
    const result = await new MockYelpProvider().matchBusinesses(MATCH_QUERY);
    expect(result.candidates.length).toBeGreaterThan(1);
    expect(result.candidates[1]?.name).toContain("East");
  });

  it("includes a closed listing, which the UI has to mark rather than hide", async () => {
    const result = await new MockYelpProvider().matchBusinesses(MATCH_QUERY);
    expect(result.candidates.some((candidate) => candidate.isClosed)).toBe(true);
  });

  it("includes a listing with no phone at all, as an explicit null", async () => {
    const result = await new MockYelpProvider().matchBusinesses(MATCH_QUERY);
    expect(result.candidates.some((candidate) => candidate.phone === null)).toBe(true);
  });

  it("gives every candidate a URL that passes the trust check", async () => {
    const { isTrustedYelpUrl } = await import("@/yelp/urls");
    const result = await new MockYelpProvider().matchBusinesses(MATCH_QUERY);

    for (const candidate of result.candidates) {
      expect(candidate.profileUrl).not.toBeNull();
      expect(isTrustedYelpUrl(candidate.profileUrl as string)).toBe(true);
    }
  });
});

describe("scripted observations", () => {
  it("hands out staged observations in order, then reverts to the baseline", async () => {
    const provider = new MockYelpProvider().scriptListing("biz", [
      { reviewCount: 128, rating: 4.5 },
      { reviewCount: 129, rating: 4.5 },
    ]);

    expect((await provider.getBusiness("biz")).reviewCount).toBe(128);
    expect((await provider.getBusiness("biz")).reviewCount).toBe(129);
    // Script exhausted: back to the baseline, so "and then nothing else
    // changed" needs no explicit tail.
    expect((await provider.getBusiness("biz")).reviewCount).toBe(128);
  });

  it("distinguishes an unstated field from one Yelp omitted", async () => {
    // `undefined` means the script said nothing, so the baseline stands.
    // `null` means Yelp returned no counter — a different thing, and one the
    // check service has to refuse to read as a change.
    const provider = new MockYelpProvider().scriptListing("biz", [
      { reviewCount: 200 },
      { reviewCount: null },
    ]);

    const first = await provider.getBusiness("biz");
    expect(first.reviewCount).toBe(200);
    expect(first.rating).toBe(4.5);

    const second = await provider.getBusiness("biz");
    expect(second.reviewCount).toBeNull();
  });

  it("can stage a failure at a chosen point in the sequence", async () => {
    const provider = new MockYelpProvider().scriptListing("biz", [
      { reviewCount: 128 },
      { failWith: "rate_limited" },
      { reviewCount: 130 },
    ]);

    expect((await provider.getBusiness("biz")).reviewCount).toBe(128);
    await expect(provider.getBusiness("biz")).rejects.toHaveProperty(
      "code",
      "rate_limited",
    );
    expect((await provider.getBusiness("biz")).reviewCount).toBe(130);
  });

  it("keeps one listing's script separate from another's", async () => {
    const provider = new MockYelpProvider()
      .scriptListing("a", [{ reviewCount: 1 }])
      .scriptListing("b", [{ reviewCount: 2 }]);

    expect((await provider.getBusiness("a")).reviewCount).toBe(1);
    expect((await provider.getBusiness("b")).reviewCount).toBe(2);
  });
});

describe("fault injection", () => {
  it("can fail every call, for a rotated-key scenario", async () => {
    const provider = new MockYelpProvider({ failEveryCallWith: "unauthorized" });

    await expect(provider.matchBusinesses(MATCH_QUERY)).rejects.toHaveProperty(
      "code",
      "unauthorized",
    );
    await expect(provider.getBusiness("biz")).rejects.toHaveProperty(
      "code",
      "unauthorized",
    );
  });

  it("can return no address matches, so the search fallback is exercised", async () => {
    const provider = new MockYelpProvider({ matchReturnsNothing: true });

    const matched = await provider.matchBusinesses(MATCH_QUERY);
    expect(matched.candidates).toEqual([]);

    // The fallback still answers, which is the whole point of having one.
    const searched = await provider.searchBusinesses({
      term: "Maison Laurent",
      location: "Brooklyn",
      limit: 5,
    });
    expect(searched.candidates.length).toBeGreaterThan(0);
  });

  it("marks rate limits and provider errors retryable, and nothing else", async () => {
    for (const [code, retryable] of [
      ["rate_limited", true],
      ["provider_error", true],
      ["unauthorized", false],
      ["business_not_found", false],
    ] as const) {
      const provider = new MockYelpProvider({ failEveryCallWith: code });
      await expect(provider.getBusiness("biz")).rejects.toHaveProperty(
        "retryable",
        retryable,
      );
    }
  });
});

describe("capabilities", () => {
  it("claims exactly what the live client claims", async () => {
    const { YELP_ASSISTED_CAPABILITIES } = await import("@/yelp/capabilities");
    // The mock and the live client must not be able to disagree about what the
    // integration can do — a mock that claimed review reading would let a whole
    // feature be developed against a capability that does not exist.
    expect(new MockYelpProvider().capabilities()).toEqual(YELP_ASSISTED_CAPABILITIES);
  });
});
