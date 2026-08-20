import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { resetDemoStore } from "@/lib/data/demo/store";

const SECRET = "test-cron-secret-value";

/**
 * The analyse-mentions route, against the real demo data source.
 *
 * Mirrors `tests/cron-routes.test.ts`'s shape for news-poll — the auth guard,
 * the never-leaks-the-secret property, and the `not_configured` response —
 * plus a happy-path assertion that the sweep genuinely walks the seed data
 * (not just past the auth check). Per-organization isolation, lock-conflict
 * skipping, and the 500 path need finer control than the real demo data
 * source gives, so those live in `tests/cron-sweep-mocked.test.ts` instead.
 */

beforeEach(() => {
  // Every case here POSTs to the route, and the sweep analyses the seeded
  // mentions it finds — so the fifth case would otherwise run against a
  // backlog the first four had already drained. This used to happen by
  // accident: `vi.resetModules()` gave each import a fresh module graph and
  // therefore a fresh copy of the demo store. The store is now a genuine
  // process singleton (see the comment on `STORE_KEY`), which is what makes a
  // server action's write visible to a route handler, so the reset this suite
  // always depended on is now stated rather than inherited.
  resetDemoStore();
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("LIA_AI_MODE", "mock");
  vi.stubEnv("LIA_NEWS_MODE", "mock");
  vi.stubEnv("NODE_ENV", "test");
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("POST /api/cron/analyze-mentions", () => {
  it("rejects a request with no authorization header", async () => {
    const { POST } = await import("@/app/api/cron/analyze-mentions/route");
    const response = await POST(
      new Request("https://lia.test/api/cron/analyze-mentions", { method: "POST" }),
    );
    expect(response.status).toBe(401);
  });

  it("rejects a wrong secret", async () => {
    const { POST } = await import("@/app/api/cron/analyze-mentions/route");
    const response = await POST(
      new Request("https://lia.test/api/cron/analyze-mentions", {
        method: "POST",
        headers: { authorization: "Bearer wrong-secret-entirely" },
      }),
    );
    expect(response.status).toBe(401);
  });

  it("accepts the configured secret", async () => {
    const { POST } = await import("@/app/api/cron/analyze-mentions/route");
    const response = await POST(
      new Request("https://lia.test/api/cron/analyze-mentions", {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    );
    expect(response.status).toBe(200);
  });

  it("never returns the secret in the body", async () => {
    const { POST } = await import("@/app/api/cron/analyze-mentions/route");
    const response = await POST(
      new Request("https://lia.test/api/cron/analyze-mentions", {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    );
    const body = await response.text();
    expect(body).not.toContain(SECRET);
  });

  it("reports not_configured at 200 with no analyser configured", async () => {
    // Overrides the module-level LIA_AI_MODE=mock stub for this test only.
    vi.stubEnv("LIA_AI_MODE", "");
    const { POST } = await import("@/app/api/cron/analyze-mentions/route");
    const response = await POST(
      new Request("https://lia.test/api/cron/analyze-mentions", {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    expect(body.status).toBe("not_configured");
  });

  it("sweeps the seeded organizations and reports counts, not just an empty ok", async () => {
    const { POST } = await import("@/app/api/cron/analyze-mentions/route");
    const response = await POST(
      new Request("https://lia.test/api/cron/analyze-mentions", {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}` },
      }),
    );
    const body = await response.json();
    expect(response.status).toBe(200);
    // `ok` or `degraded` — both are 200 and both mean the sweep ran. The seed
    // data decides which, and pinning one would make this test a hostage to
    // how many seeded mentions the mock analyser happens to fail.
    expect(["ok", "degraded"]).toContain(body.status);
    // The seed dataset ships unanalysed mentions across more than one
    // organization; a route that only checked auth and returned zeroes would
    // also pass every test above, so this is what actually pins the sweep.
    expect(body.analysis.organizations).toBeGreaterThan(0);
    expect(typeof body.analysis.mentionsFailed).toBe("number");
    expect(typeof body.analysis.erroredOrganizations).toBe("number");
    // Rules execution is off by default, so the sweep must not have claimed
    // anything — the fail-closed posture, asserted rather than assumed.
    expect(body.execution.mode).toBe("off");
    expect(body.execution.sweeps).toEqual([]);
  });
});
