import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "test-cron-secret-value";

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("LIA_NEWS_MODE", "mock");
  vi.stubEnv("NODE_ENV", "test");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("POST /api/cron/news-poll", () => {
  it("rejects a request with no authorization header", async () => {
    const { POST } = await import("@/app/api/cron/news-poll/route");
    const response = await POST(new Request("https://lia.test/api/cron/news-poll", {
      method: "POST",
    }));
    expect(response.status).toBe(401);
  });

  it("rejects a wrong secret", async () => {
    const { POST } = await import("@/app/api/cron/news-poll/route");
    const response = await POST(
      new Request("https://lia.test/api/cron/news-poll", {
        method: "POST",
        headers: { authorization: "Bearer wrong-secret-entirely" },
      }),
    );
    expect(response.status).toBe(401);
  });

  it("accepts the configured secret", async () => {
    const { POST } = await import("@/app/api/cron/news-poll/route");
    const response = await POST(
      new Request("https://lia.test/api/cron/news-poll", {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    );
    expect(response.status).toBe(200);
  });

  it("never returns a provider message in the body", async () => {
    const { POST } = await import("@/app/api/cron/news-poll/route");
    const response = await POST(
      new Request("https://lia.test/api/cron/news-poll", {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    );
    const body = await response.text();
    expect(body).not.toContain(SECRET);
  });

  it("does not leak provider or infrastructure detail through the response body", async () => {
    // The previous version of this test only checked for the cron secret,
    // which never appears in a success body of five integers regardless of
    // what the route does — mutating the 200 response to include an API key
    // and a connection string left the suite green. `vi.doMock` (not the
    // hoisted `vi.mock`) scopes the mock to this one dynamic import, so
    // every other test in the file keeps exercising the real demo
    // `pollDueQueries`. This mocks the outcome itself with a marker that
    // stands in for a real leak — an API key and a driver connection
    // string — in fields a naive `NextResponse.json(outcome)` would spread
    // straight through. The route must only ever echo the four known-safe
    // counters.
    const LEAK_MARKER = "sk-live-abc123 postgres://cron_user:s3cr3t@db.internal/lia";
    vi.doMock("@/lib/monitoring/poll-service", () => ({
      pollDueQueries: vi.fn().mockResolvedValue({
        polled: 1,
        accepted: 1,
        rejected: 0,
        skippedForBudget: 0,
        providerApiKey: LEAK_MARKER,
        errorMessage: LEAK_MARKER,
      }),
    }));

    const { POST } = await import("@/app/api/cron/news-poll/route");
    const response = await POST(
      new Request("https://lia.test/api/cron/news-poll", {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    );
    const body = await response.text();
    expect(body).not.toContain(LEAK_MARKER);
  });
});

describe("cron route method exports", () => {
  // Vercel Cron invokes scheduled routes with GET — see "Secure Cron Jobs
  // with Next.js Route Handlers" in Vercel's own docs, where every example
  // is `export function GET(...)`. The App Router 405s any method a route
  // module does not export, so a POST-only route is unreachable by the
  // scheduler that is supposed to call it. This is the only assertion
  // available without an actual deployment, and it would have caught that.
  it("news-poll exports a callable GET", async () => {
    const routeModule = await import("@/app/api/cron/news-poll/route");
    expect(typeof routeModule.GET).toBe("function");
  });

  it("analyze-mentions exports a callable GET", async () => {
    const routeModule = await import("@/app/api/cron/analyze-mentions/route");
    expect(typeof routeModule.GET).toBe("function");
  });
});
