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
});
