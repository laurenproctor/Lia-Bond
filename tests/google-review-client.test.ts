import { describe, expect, it, vi } from "vitest";
import type { CredentialSession, PlatformCredentials } from "@/integrations/connector";
import { IntegrationError } from "@/integrations/errors";
import { retryDelayMs } from "@/integrations/google-business-profile/client";
import { createGoogleBusinessProfileConnector } from "@/integrations/google-business-profile/connector";
import { GOOGLE_BUSINESS_MANAGE_SCOPE } from "@/integrations/google-business-profile/scopes";

/**
 * The review-listing half of the Google client.
 *
 * `fetch` is stubbed and so is the sleep between retries, so a test that
 * exercises three backoffs finishes in a millisecond rather than in seven
 * seconds. What is under test is the client's own policy — how it pages, what
 * it retries, and what it refuses to retry — none of which needs a real Google
 * project and all of which would be untestable without those two seams.
 *
 * No real token appears anywhere in this file.
 */

const CONFIG = {
  clientId: "test-client-id.apps.googleusercontent.com",
  clientSecret: "test-client-secret",
  redirectUri: "https://lia.test/api/integrations/google-business-profile/callback",
};

const ACCOUNT_ID = "accounts/1122334455";
const PROFILE_ID = "locations/1001";
const REVIEWS_URL = /mybusiness\.googleapis\.com\/v4/;
const TOKEN_URL = /oauth2\.googleapis\.com\/token/;

interface StubResponse {
  status?: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** A `fetch` that answers from a queue and records the URLs it was given. */
function stubFetch(routes: Array<[RegExp, StubResponse | StubResponse[]]>) {
  const calls: string[] = [];
  const queues = new Map<RegExp, StubResponse[]>(
    routes.map(([pattern, response]) => [
      pattern,
      Array.isArray(response) ? [...response] : [response],
    ]),
  );

  const impl = vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    calls.push(url);

    for (const [pattern, queue] of queues) {
      if (!pattern.test(url)) continue;
      // The last entry repeats once the queue runs dry, so a stub does not have
      // to be padded to the exact call count.
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      return new Response(JSON.stringify(next.body), {
        status: next.status ?? 200,
        headers: { "content-type": "application/json", ...(next.headers ?? {}) },
      });
    }

    throw new Error(`Unstubbed request: ${url}`);
  });

  return { impl: impl as unknown as typeof fetch, calls };
}

function connectorWith(routes: Array<[RegExp, StubResponse | StubResponse[]]>) {
  const { impl, calls } = stubFetch(routes);
  const slept: number[] = [];

  const connector = createGoogleBusinessProfileConnector({
    ...CONFIG,
    fetchImpl: impl,
    async sleepImpl(milliseconds) {
      slept.push(milliseconds);
    },
  });

  return { connector, calls, slept };
}

function session(
  overrides: Partial<PlatformCredentials> = {},
): CredentialSession & { saved: PlatformCredentials[] } {
  const saved: PlatformCredentials[] = [];

  return {
    saved,
    credentials: {
      accessToken: "access-token",
      refreshToken: "refresh-token",
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
      scopes: [GOOGLE_BUSINESS_MANAGE_SCOPE],
      tokenType: "Bearer",
      ...overrides,
    },
    async onRefreshed(next) {
      saved.push(next);
    },
  };
}

function googleReview(id: string, overrides: Record<string, unknown> = {}) {
  return {
    name: `${ACCOUNT_ID}/${PROFILE_ID}/reviews/${id}`,
    reviewId: id,
    reviewer: { displayName: "Test Reviewer" },
    starRating: "FOUR",
    comment: `Review ${id}`,
    createTime: "2026-07-01T12:00:00Z",
    updateTime: "2026-07-01T12:00:00Z",
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Requests                                                                    */
/* -------------------------------------------------------------------------- */

describe("the review request", () => {
  it("asks the right location for 50 reviews, newest edits first", async () => {
    const { connector, calls } = connectorWith([
      [REVIEWS_URL, { body: { reviews: [] } }],
    ]);

    await connector.listExternalReviews(session(), ACCOUNT_ID, PROFILE_ID);

    const url = new URL(calls[0]!);
    expect(url.pathname).toBe("/v4/accounts/1122334455/locations/1001/reviews");
    expect(url.searchParams.get("pageSize")).toBe("50");
    // Ordering is what makes an edited older review visible to a later sync.
    expect(url.searchParams.get("orderBy")).toBe("updateTime desc");
  });

  it("never puts a token in the URL", async () => {
    const { connector, calls } = connectorWith([
      [REVIEWS_URL, { body: { reviews: [] } }],
    ]);

    await connector.listExternalReviews(session(), ACCOUNT_ID, PROFILE_ID);

    expect(calls.join(" ")).not.toContain("access-token");
  });
});

/* -------------------------------------------------------------------------- */
/* Pagination                                                                  */
/* -------------------------------------------------------------------------- */

describe("pagination", () => {
  it("follows every page token to the end", async () => {
    const { connector, calls } = connectorWith([
      [
        REVIEWS_URL,
        [
          { body: { reviews: [googleReview("r1")], nextPageToken: "p2", totalReviewCount: 3 } },
          { body: { reviews: [googleReview("r2")], nextPageToken: "p3" } },
          { body: { reviews: [googleReview("r3")] } },
        ],
      ],
    ]);

    const batch = await connector.listExternalReviews(session(), ACCOUNT_ID, PROFILE_ID);

    expect(batch.reviews.map((review) => review.externalId)).toEqual(["r1", "r2", "r3"]);
    expect(batch.pagesFetched).toBe(3);
    expect(calls).toHaveLength(3);
  });

  it("sends the token it was given on the following request", async () => {
    const { connector, calls } = connectorWith([
      [
        REVIEWS_URL,
        [
          { body: { reviews: [googleReview("r1")], nextPageToken: "page-two" } },
          { body: { reviews: [googleReview("r2")] } },
        ],
      ],
    ]);

    await connector.listExternalReviews(session(), ACCOUNT_ID, PROFILE_ID);

    expect(new URL(calls[0]!).searchParams.get("pageToken")).toBeNull();
    expect(new URL(calls[1]!).searchParams.get("pageToken")).toBe("page-two");
  });

  it("does not stop the backfill at the first page", async () => {
    // A sync that quietly imported the first fifty reviews and reported success
    // is the failure mode this whole loop exists to prevent.
    const pages = Array.from({ length: 8 }, (_, index) => ({
      body:
        index === 7
          ? { reviews: [googleReview(`r${index}`)] }
          : { reviews: [googleReview(`r${index}`)], nextPageToken: `p${index + 1}` },
    }));

    const { connector } = connectorWith([[REVIEWS_URL, pages]]);
    const batch = await connector.listExternalReviews(session(), ACCOUNT_ID, PROFILE_ID);

    expect(batch.reviews).toHaveLength(8);
    expect(batch.pagesFetched).toBe(8);
  });

  it("keeps the total from the first page that reported one", async () => {
    const { connector } = connectorWith([
      [
        REVIEWS_URL,
        [
          { body: { reviews: [googleReview("r1")], nextPageToken: "p2", totalReviewCount: 2 } },
          { body: { reviews: [googleReview("r2")] } },
        ],
      ],
    ]);

    const batch = await connector.listExternalReviews(session(), ACCOUNT_ID, PROFILE_ID);
    expect(batch.totalReviewCount).toBe(2);
  });

  it("reports no total rather than guessing when Google omits one", async () => {
    const { connector } = connectorWith([
      [REVIEWS_URL, { body: { reviews: [googleReview("r1")] } }],
    ]);

    const batch = await connector.listExternalReviews(session(), ACCOUNT_ID, PROFILE_ID);
    expect(batch.totalReviewCount).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Empty and malformed responses                                               */
/* -------------------------------------------------------------------------- */

describe("empty and malformed responses", () => {
  it("treats a missing reviews key as no reviews, not as a failure", async () => {
    // Google omits the key entirely for a location with none. Treating that as
    // an error would make every new listing look broken.
    const { connector } = connectorWith([[REVIEWS_URL, { body: {} }]]);

    const batch = await connector.listExternalReviews(session(), ACCOUNT_ID, PROFILE_ID);

    expect(batch.reviews).toEqual([]);
    expect(batch.malformedCount).toBe(0);
  });

  it("keeps the readable reviews on a page that also holds an unreadable one", async () => {
    const { connector } = connectorWith([
      [
        REVIEWS_URL,
        {
          body: {
            reviews: [
              googleReview("r1"),
              // No id and no resource name: nothing to be idempotent about.
              { starRating: "FIVE", createTime: "2026-07-01T12:00:00Z" },
              googleReview("r3"),
            ],
          },
        },
      ],
    ]);

    const batch = await connector.listExternalReviews(session(), ACCOUNT_ID, PROFILE_ID);

    expect(batch.reviews.map((review) => review.externalId)).toEqual(["r1", "r3"]);
    expect(batch.malformedCount).toBe(1);
  });

  it("rejects a response whose shape it cannot validate", async () => {
    const { connector } = connectorWith([
      [REVIEWS_URL, { body: { reviews: "not an array" } }],
    ]);

    await expect(
      connector.listExternalReviews(session(), ACCOUNT_ID, PROFILE_ID),
    ).rejects.toMatchObject({ code: "unexpected_response" });
  });
});

/* -------------------------------------------------------------------------- */
/* Retries                                                                     */
/* -------------------------------------------------------------------------- */

describe("retries", () => {
  it("retries a 429 and succeeds when Google recovers", async () => {
    const { connector, calls, slept } = connectorWith([
      [
        REVIEWS_URL,
        [
          { status: 429, body: { error: { status: "RESOURCE_EXHAUSTED" } } },
          { body: { reviews: [googleReview("r1")] } },
        ],
      ],
    ]);

    const batch = await connector.listExternalReviews(session(), ACCOUNT_ID, PROFILE_ID);

    expect(batch.reviews).toHaveLength(1);
    expect(calls).toHaveLength(2);
    expect(slept).toHaveLength(1);
  });

  it("retries a transient 5xx", async () => {
    const { connector, calls } = connectorWith([
      [
        REVIEWS_URL,
        [
          { status: 503, body: { error: { status: "UNAVAILABLE" } } },
          { status: 500, body: { error: { status: "INTERNAL" } } },
          { body: { reviews: [googleReview("r1")] } },
        ],
      ],
    ]);

    const batch = await connector.listExternalReviews(session(), ACCOUNT_ID, PROFILE_ID);

    expect(batch.reviews).toHaveLength(1);
    expect(calls).toHaveLength(3);
  });

  it("honours Retry-After when Google sends one", async () => {
    const { connector, slept } = connectorWith([
      [
        REVIEWS_URL,
        [
          {
            status: 429,
            body: { error: { status: "RESOURCE_EXHAUSTED" } },
            headers: { "retry-after": "2" },
          },
          { body: { reviews: [] } },
        ],
      ],
    ]);

    await connector.listExternalReviews(session(), ACCOUNT_ID, PROFILE_ID);

    // Google knows when its quota window resets; exponential guessing does not.
    expect(slept).toEqual([2000]);
  });

  it("gives up after a bounded number of attempts", async () => {
    const { connector, calls } = connectorWith([
      [REVIEWS_URL, { status: 503, body: { error: { status: "UNAVAILABLE" } } }],
    ]);

    await expect(
      connector.listExternalReviews(session(), ACCOUNT_ID, PROFILE_ID),
    ).rejects.toMatchObject({ code: "provider_unavailable" });

    // One attempt plus three retries. Not unbounded.
    expect(calls).toHaveLength(4);
  });

  it("does not retry a revoked authorization", async () => {
    // A 401 is not going to become a 200 in two seconds, and retrying it only
    // delays the one message that tells the user to reauthorize.
    const { connector, calls } = connectorWith([
      [REVIEWS_URL, { status: 401, body: { error: { status: "UNAUTHENTICATED" } } }],
    ]);

    await expect(
      connector.listExternalReviews(session(), ACCOUNT_ID, PROFILE_ID),
    ).rejects.toMatchObject({ code: "credentials_expired" });

    expect(calls).toHaveLength(1);
  });

  it("does not retry a permission failure", async () => {
    const { connector, calls } = connectorWith([
      [REVIEWS_URL, { status: 403, body: { error: { status: "PERMISSION_DENIED" } } }],
    ]);

    await expect(
      connector.listExternalReviews(session(), ACCOUNT_ID, PROFILE_ID),
    ).rejects.toMatchObject({ code: "insufficient_scope" });

    expect(calls).toHaveLength(1);
  });

  it("does not retry an unverified or missing location", async () => {
    const { connector, calls } = connectorWith([
      [REVIEWS_URL, { status: 404, body: { error: { status: "NOT_FOUND" } } }],
    ]);

    await expect(
      connector.listExternalReviews(session(), ACCOUNT_ID, PROFILE_ID),
    ).rejects.toMatchObject({ code: "resource_unavailable" });

    expect(calls).toHaveLength(1);
  });

  it("surfaces a network failure as a provider outage", async () => {
    const failing = vi.fn(async () => {
      throw new Error("ECONNRESET");
    });

    const connector = createGoogleBusinessProfileConnector({
      ...CONFIG,
      fetchImpl: failing as unknown as typeof fetch,
      async sleepImpl() {},
    });

    const error = await connector
      .listExternalReviews(session(), ACCOUNT_ID, PROFILE_ID)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(IntegrationError);
    expect((error as IntegrationError).code).toBe("provider_unavailable");
  });
});

/* -------------------------------------------------------------------------- */
/* Backoff arithmetic                                                          */
/* -------------------------------------------------------------------------- */

describe("retry delay", () => {
  const NOW = Date.parse("2026-08-01T12:00:00Z");

  it("backs off exponentially with no header", () => {
    expect(retryDelayMs(0, null, NOW)).toBe(500);
    expect(retryDelayMs(1, null, NOW)).toBe(1000);
    expect(retryDelayMs(2, null, NOW)).toBe(2000);
  });

  it("accepts a Retry-After in seconds", () => {
    expect(retryDelayMs(0, "5", NOW)).toBe(5000);
  });

  it("accepts a Retry-After as an HTTP date", () => {
    expect(retryDelayMs(0, new Date(NOW + 3000).toUTCString(), NOW)).toBe(3000);
  });

  it("ignores an absurdly long Retry-After rather than hanging the request", () => {
    // An hour-long sleep inside a request is a hung request.
    expect(retryDelayMs(0, "3600", NOW)).toBe(500);
  });

  it("falls back to backoff for an unparseable header", () => {
    expect(retryDelayMs(1, "soon", NOW)).toBe(1000);
  });

  it("treats a Retry-After in the past as no wait", () => {
    expect(retryDelayMs(0, new Date(NOW - 5000).toUTCString(), NOW)).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Token refresh                                                               */
/* -------------------------------------------------------------------------- */

describe("access-token refresh", () => {
  it("refreshes an expired token before the first page and persists it", async () => {
    // Doing this once up front rather than per page is what stops a 400-page
    // backfill dying on page three with a credential that expired mid-run.
    const { connector, calls } = connectorWith([
      [
        TOKEN_URL,
        {
          body: {
            access_token: "refreshed-access-token",
            expires_in: 3599,
            scope: GOOGLE_BUSINESS_MANAGE_SCOPE,
            token_type: "Bearer",
          },
        },
      ],
      [REVIEWS_URL, { body: { reviews: [googleReview("r1")] } }],
    ]);

    const active = session({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    await connector.listExternalReviews(active, ACCOUNT_ID, PROFILE_ID);

    expect(active.saved).toHaveLength(1);
    expect(active.saved[0]?.accessToken).toBe("refreshed-access-token");
    // The refresh token is not reissued on an ordinary refresh, so the stored
    // one has to be carried forward or the connection dies at the next expiry.
    expect(active.saved[0]?.refreshToken).toBe("refresh-token");
    expect(calls.filter((url) => TOKEN_URL.test(url))).toHaveLength(1);
  });

  it("does not refresh a token that is still good", async () => {
    const { connector, calls } = connectorWith([
      [REVIEWS_URL, { body: { reviews: [] } }],
    ]);

    const active = session();
    await connector.listExternalReviews(active, ACCOUNT_ID, PROFILE_ID);

    expect(active.saved).toHaveLength(0);
    expect(calls.filter((url) => TOKEN_URL.test(url))).toHaveLength(0);
  });

  it("reports a revoked grant as needing reauthorization", async () => {
    const { connector } = connectorWith([
      [TOKEN_URL, { status: 400, body: { error: "invalid_grant" } }],
      [REVIEWS_URL, { body: { reviews: [] } }],
    ]);

    const active = session({ expiresAt: new Date(Date.now() - 1000).toISOString() });

    await expect(
      connector.listExternalReviews(active, ACCOUNT_ID, PROFILE_ID),
    ).rejects.toMatchObject({ code: "authorization_revoked" });
  });

  it("refuses when the access token is dead and there is nothing to refresh with", async () => {
    const { connector } = connectorWith([[REVIEWS_URL, { body: { reviews: [] } }]]);

    const active = session({
      refreshToken: null,
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    await expect(
      connector.listExternalReviews(active, ACCOUNT_ID, PROFILE_ID),
    ).rejects.toMatchObject({ code: "authorization_revoked" });
  });
});
