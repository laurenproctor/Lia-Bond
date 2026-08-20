import { afterEach, describe, expect, it, vi } from "vitest";
import { YelpError } from "@/yelp/errors";
import type { YelpBusinessMatchQuery, YelpPlacesProvider } from "@/yelp/places";

/**
 * The Yelp HTTP boundary, against a stubbed `fetch`.
 *
 * Same position `google-review-client.test.ts` and `gnews-client.test.ts` are
 * in: the live endpoint has never been called from this repository, so every
 * assertion here is about the request Lia builds and what it does with the
 * response — not about Yelp's behaviour.
 *
 * The client is imported dynamically rather than at the top of the file. It
 * reads the API key through `@/lib/env`, which parses `process.env` once at
 * module load, and a static import would run that parse before any case could
 * set the key — so every request would be built with none, and the suite would
 * be asserting on an unconfigured client. Same reason `env-yelp.test.ts`
 * re-imports per case.
 */

const API_KEY = "yelp-secret-key-value";

interface ClientConstructor {
  new (fetchImpl?: typeof fetch): YelpPlacesProvider;
}

async function loadClientConstructor(): Promise<ClientConstructor> {
  vi.resetModules();
  process.env.YELP_API_KEY = API_KEY;
  process.env.LIA_YELP_MODE = "live";
  const clientModule = await import("@/yelp/client");
  return clientModule.YelpFusionClient as unknown as ClientConstructor;
}

type FetchStub = ReturnType<typeof vi.fn>;

/** A configured client wired to a stubbed `fetch`. */
async function clientWith(fetchImpl: FetchStub): Promise<YelpPlacesProvider> {
  const YelpFusionClient = await loadClientConstructor();
  return new YelpFusionClient(fetchImpl as unknown as typeof fetch);
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** A stub answering every call with one canned response. */
function respondWith(body: unknown, status = 200): FetchStub {
  return vi.fn(async () => jsonResponse(body, status));
}

afterEach(() => {
  delete process.env.YELP_API_KEY;
  delete process.env.LIA_YELP_MODE;
  vi.restoreAllMocks();
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
  limit: 5,
};

const BUSINESS = {
  id: "yelp-business-1",
  alias: "maison-laurent-brooklyn",
  name: "Maison Laurent",
  url: "https://www.yelp.com/biz/maison-laurent-brooklyn?adjust_creative=abc",
  phone: "+15555550101",
  display_phone: "(555) 555-0101",
  is_closed: false,
  review_count: 128,
  rating: 4.5,
  price: "$$",
  location: {
    address1: "118 Prince Street",
    city: "Brooklyn",
    state: "NY",
    zip_code: "11201",
    country: "US",
    display_address: ["118 Prince Street", "Brooklyn, NY 11201"],
  },
  categories: [{ alias: "french", title: "French" }],
};

/* -------------------------------------------------------------------------- */
/* Key secrecy                                                                 */
/* -------------------------------------------------------------------------- */

describe("API key handling", () => {
  it("sends the key in an Authorization header and never in the URL", async () => {
    // GNews takes its key as a query parameter, which is how tokens end up in
    // request logs and error messages by default. This one must not.
    const fetchImpl = respondWith({ businesses: [BUSINESS] });
    const client = await clientWith(fetchImpl);
    await client.matchBusinesses(MATCH_QUERY);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).not.toContain(API_KEY);
    expect((init.headers as Record<string, string>).Authorization).toBe(
      `Bearer ${API_KEY}`,
    );
  });

  it("keeps the key out of every thrown error", async () => {
    const client = await clientWith(respondWith({ error: "bad" }, 401));

    await expect(client.getBusiness("yelp-business-1")).rejects.toSatisfy(
      (error: unknown) => !String((error as Error).message).includes(API_KEY),
    );
  });

  it("keeps Yelp's own response body out of every thrown error", async () => {
    // A Yelp 400 quotes the request back, and for a match call the request is a
    // customer's address.
    const client = await clientWith(
      respondWith(
        { error: { description: "Invalid address 118 Prince Street Brooklyn" } },
        400,
      ),
    );

    await expect(client.matchBusinesses(MATCH_QUERY)).rejects.toSatisfy(
      (error: unknown) => !String((error as Error).message).includes("Prince Street"),
    );
  });

  it("reports a missing key as a configuration error, not as an unreachable provider", async () => {
    // The bug this pins: `headers()` throws a ConfigurationError when no key is
    // set, and building it inside the transport try/catch turned that into
    // "Lia could not reach Yelp" — sending an operator to debug a network
    // problem that does not exist.
    vi.resetModules();
    delete process.env.YELP_API_KEY;
    process.env.LIA_YELP_MODE = "live";
    const clientModule = await import("@/yelp/client");
    const client = new clientModule.YelpFusionClient(respondWith(BUSINESS) as unknown as typeof fetch);

    await expect(client.getBusiness("yelp-business-1")).rejects.toSatisfy(
      (error: unknown) =>
        (error as { name?: string }).name === "ConfigurationError" &&
        Array.isArray((error as { missing?: string[] }).missing) &&
        (error as { missing: string[] }).missing.includes("YELP_API_KEY"),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Error classification                                                        */
/* -------------------------------------------------------------------------- */

describe("error classification", () => {
  const cases: ReadonlyArray<[number, string, boolean]> = [
    [401, "unauthorized", false],
    [403, "plan_restricted", false],
    [404, "business_not_found", false],
    [429, "rate_limited", true],
    [400, "invalid_query", false],
    [500, "provider_error", true],
    [503, "provider_error", true],
  ];

  for (const [status, code, retryable] of cases) {
    it(`maps ${status} to ${code} (retryable: ${retryable})`, async () => {
      const client = await clientWith(respondWith({}, status));

      try {
        await client.getBusiness("yelp-business-1");
        expect.unreachable(`status ${status} should have thrown`);
      } catch (error) {
        // `name`, not `instanceof`. Each case re-imports the client through
        // `vi.resetModules()`, which gives it a fresh copy of `@/yelp/errors` —
        // so the error it throws is a structurally identical class with a
        // different identity from the one this file imported. The code and the
        // retryable flag are the contract anyway; the class is not.
        expect((error as Error).name).toBe("YelpError");
        expect((error as YelpError).code).toBe(code);
        expect((error as YelpError).retryable).toBe(retryable);
      }
    });
  }

  it("treats an unmapped 4xx as permanent, not as retry-forever", async () => {
    const client = await clientWith(respondWith({}, 418));

    try {
      await client.getBusiness("yelp-business-1");
      expect.unreachable("418 should have thrown");
    } catch (error) {
      expect((error as YelpError).retryable).toBe(false);
    }
  });

  it("treats a transport failure as a retryable provider error", async () => {
    const client = await clientWith(
      vi.fn(async () => {
        throw new Error("ECONNRESET");
      }),
    );

    try {
      await client.getBusiness("yelp-business-1");
      expect.unreachable("a transport failure should have thrown");
    } catch (error) {
      expect((error as YelpError).code).toBe("provider_error");
      expect((error as YelpError).retryable).toBe(true);
      expect((error as Error).message).not.toContain("ECONNRESET");
    }
  });

  it("separates a rejected key from a plan restriction", async () => {
    // Both arrive as a refusal, and the operator's next action differs: paste
    // the key again, or go and read what the plan covers.
    const unauthorized = await clientWith(respondWith({}, 401));
    const restricted = await clientWith(respondWith({}, 403));

    await expect(unauthorized.getBusiness("x")).rejects.toHaveProperty(
      "code",
      "unauthorized",
    );
    await expect(restricted.getBusiness("x")).rejects.toHaveProperty(
      "code",
      "plan_restricted",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Normalisation                                                               */
/* -------------------------------------------------------------------------- */

describe("candidate normalisation", () => {
  it("normalises a business and canonicalises its Yelp URL", async () => {
    const client = await clientWith(respondWith({ businesses: [BUSINESS] }));
    const result = await client.matchBusinesses(MATCH_QUERY);

    expect(result.candidates).toHaveLength(1);
    const candidate = result.candidates[0];
    expect(candidate?.businessId).toBe("yelp-business-1");
    // The tracking parameter Yelp attached is gone.
    expect(candidate?.profileUrl).toBe(
      "https://www.yelp.com/biz/maison-laurent-brooklyn",
    );
    expect(candidate?.addressLines).toEqual([
      "118 Prince Street",
      "Brooklyn, NY 11201",
    ]);
    expect(candidate?.metadata).toEqual({
      displayPhone: "(555) 555-0101",
      price: "$$",
      categories: ["French"],
    });
  });

  it("falls back to the alias-built URL when Yelp returns an untrusted one", async () => {
    const client = await clientWith(
      respondWith({
        businesses: [{ ...BUSINESS, url: "https://yelp.evil.test/biz/spoof" }],
      }),
    );
    const result = await client.matchBusinesses(MATCH_QUERY);

    expect(result.candidates[0]?.profileUrl).toBe(
      "https://www.yelp.com/biz/maison-laurent-brooklyn",
    );
  });

  it("counts an unreadable business rather than losing the whole batch", async () => {
    const client = await clientWith(
      respondWith({
        businesses: [BUSINESS, { id: "no-name-business" }, { nonsense: true }],
      }),
    );
    const result = await client.matchBusinesses(MATCH_QUERY);

    expect(result.candidates).toHaveLength(1);
    expect(result.malformedCount).toBe(2);
  });

  it("reports one request spent per call, for the shared budget", async () => {
    const client = await clientWith(respondWith({ businesses: [] }));
    const result = await client.matchBusinesses(MATCH_QUERY);

    expect(result.requestsSpent).toBe(1);
  });

  it("returns no candidates rather than throwing when Yelp matches nothing", async () => {
    // The connect flow's "try a wider search" branch depends on this being an
    // empty result rather than an error.
    const client = await clientWith(respondWith({ businesses: [] }));
    const result = await client.matchBusinesses(MATCH_QUERY);

    expect(result.candidates).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* Request construction                                                        */
/* -------------------------------------------------------------------------- */

describe("request construction", () => {
  it("omits state where the country has none, rather than sending an empty one", async () => {
    const fetchImpl = respondWith({ businesses: [] });
    const client = await clientWith(fetchImpl);
    await client.matchBusinesses({ ...MATCH_QUERY, region: "", countryCode: "GB" });

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).not.toContain("state=");
    expect(url).toContain("country=GB");
  });

  it("path-encodes the business id so a crafted id cannot address another endpoint", async () => {
    const fetchImpl = respondWith(BUSINESS);
    const client = await clientWith(fetchImpl);
    await client.getBusiness("abc/../../reviews");

    const [url] = fetchImpl.mock.calls[0] as unknown as [string];
    expect(url).toBe("https://api.yelp.com/v3/businesses/abc%2F..%2F..%2Freviews");
  });

  it("clamps the limit to what Yelp accepts", async () => {
    const fetchImpl = respondWith({ businesses: [] });
    const client = await clientWith(fetchImpl);

    await client.matchBusinesses({ ...MATCH_QUERY, limit: 900 });
    await client.matchBusinesses({ ...MATCH_QUERY, limit: 0 });

    const [first] = fetchImpl.mock.calls[0] as unknown as [string];
    const [second] = fetchImpl.mock.calls[1] as unknown as [string];
    expect(first).toContain("limit=50");
    expect(second).toContain("limit=1");
  });

  it("calls the match endpoint for an address query and search for a term query", async () => {
    const fetchImpl = respondWith({ businesses: [] });
    const client = await clientWith(fetchImpl);

    await client.matchBusinesses(MATCH_QUERY);
    await client.searchBusinesses({ term: "Maison", location: "Brooklyn", limit: 5 });

    const [first] = fetchImpl.mock.calls[0] as unknown as [string];
    const [second] = fetchImpl.mock.calls[1] as unknown as [string];
    expect(first).toContain("/businesses/matches");
    expect(second).toContain("/businesses/search");
  });

  it("never requests the reviews endpoint, which this integration must not read", async () => {
    // The structural half of "Lia cannot read Yelp reviews": there is no method
    // to call. This asserts the client never reaches for one anyway.
    const fetchImpl = respondWith(BUSINESS);
    const client = await clientWith(fetchImpl);

    await client.getBusiness("yelp-business-1");
    await client.matchBusinesses(MATCH_QUERY);

    for (const call of fetchImpl.mock.calls) {
      expect(String((call as unknown as [string])[0])).not.toContain("/reviews");
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Listing metadata                                                            */
/* -------------------------------------------------------------------------- */

describe("getBusiness", () => {
  it("returns the two counters activity detection depends on", async () => {
    const client = await clientWith(respondWith(BUSINESS));
    const listing = await client.getBusiness("yelp-business-1");

    expect(listing.reviewCount).toBe(128);
    expect(listing.rating).toBe(4.5);
  });

  it("returns null counters when Yelp omits them, rather than inventing zero", async () => {
    // Load-bearing: a zero baseline would make the next observation look like
    // 128 new reviews arriving at once.
    const { review_count, rating, ...withoutCounters } = BUSINESS;
    void review_count;
    void rating;
    const client = await clientWith(respondWith(withoutCounters));
    const listing = await client.getBusiness("yelp-business-1");

    expect(listing.reviewCount).toBeNull();
    expect(listing.rating).toBeNull();
  });

  it("refuses counters outside the range Yelp publishes", async () => {
    const client = await clientWith(
      respondWith({ ...BUSINESS, review_count: -4, rating: 9 }),
    );
    const listing = await client.getBusiness("yelp-business-1");

    expect(listing.reviewCount).toBeNull();
    expect(listing.rating).toBeNull();
  });

  it("refuses a fractional review count", async () => {
    const client = await clientWith(respondWith({ ...BUSINESS, review_count: 12.5 }));
    const listing = await client.getBusiness("yelp-business-1");

    expect(listing.reviewCount).toBeNull();
  });

  it("throws rather than returning a nameless listing", async () => {
    const client = await clientWith(respondWith({ id: "yelp-business-1" }));

    await expect(client.getBusiness("yelp-business-1")).rejects.toHaveProperty(
      "code",
      "provider_error",
    );
  });

  it("surfaces a removed or merged listing as business_not_found", async () => {
    const client = await clientWith(respondWith({}, 404));

    await expect(client.getBusiness("gone")).rejects.toHaveProperty(
      "code",
      "business_not_found",
    );
  });

  it("treats an unreadable body as a retryable provider error", async () => {
    const client = await clientWith(
      vi.fn(async () => new Response("not json", { status: 200 })),
    );

    await expect(client.getBusiness("yelp-business-1")).rejects.toHaveProperty(
      "code",
      "provider_error",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Capabilities                                                                */
/* -------------------------------------------------------------------------- */

describe("capabilities", () => {
  it("claims location matching and assisted posting, and nothing else", async () => {
    const YelpFusionClient = await loadClientConstructor();
    const capabilities = new YelpFusionClient().capabilities();

    expect(capabilities.canMatchLocations).toBe(true);
    expect(capabilities.supportsAssistedPosting).toBe(true);
    // The four claims this integration must never make.
    expect(capabilities.canReadMentions).toBe(false);
    expect(capabilities.canReadFullText).toBe(false);
    expect(capabilities.supportsWebhooks).toBe(false);
    expect(capabilities.canPublishResponses).toBe(false);
    expect(capabilities.requiresApproval).toBe(true);
  });
});
