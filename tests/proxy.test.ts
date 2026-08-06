import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

/**
 * The session gate, specifically for `/api/cron`.
 *
 * A route-handler unit test that imports `POST` and calls it directly proves
 * nothing about reachability — it bypasses Next's routing and the proxy
 * entirely. Vercel Cron hits these routes over HTTP, with no session cookie,
 * so the only way to catch "the proxy redirects the request before the
 * handler's own CRON_SECRET check ever runs" is to exercise `proxy()`
 * itself against a request shaped the way Vercel Cron actually sends one:
 * `POST`, no cookies, Supabase configured (the gate is a no-op in demo mode,
 * so a demo-mode test would pass regardless of whether this bug exists).
 */

const { getUser } = vi.hoisted(() => ({ getUser: vi.fn() }));

vi.mock("@supabase/ssr", () => ({
  createServerClient: () => ({
    auth: { getUser },
  }),
}));

beforeEach(() => {
  // A configured deployment, not demo mode — `proxy.ts` skips the gate
  // entirely when these are absent, which would make every case here pass
  // whether or not the redirect bug exists.
  vi.stubEnv("NEXT_PUBLIC_SUPABASE_URL", "https://example.supabase.co");
  vi.stubEnv(
    "NEXT_PUBLIC_SUPABASE_ANON_KEY",
    "anon-key-value-long-enough-to-pass-validation",
  );
  // No session, matching a scheduler's request exactly.
  getUser.mockResolvedValue({ data: { user: null } });
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
  getUser.mockReset();
});

describe("proxy: /api/cron", () => {
  it("does not redirect an unauthenticated POST to /api/cron/news-poll", async () => {
    const { proxy } = await import("@/proxy");
    const request = new NextRequest("https://lia.test/api/cron/news-poll", {
      method: "POST",
    });

    const response = await proxy(request);

    expect(response.status).not.toBe(307);
    expect(response.status).not.toBe(308);
    expect(response.headers.get("location")).toBeNull();
  });

  it("does not redirect an unauthenticated POST to /api/cron/analyze-mentions", async () => {
    const { proxy } = await import("@/proxy");
    const request = new NextRequest("https://lia.test/api/cron/analyze-mentions", {
      method: "POST",
    });

    const response = await proxy(request);

    expect(response.status).not.toBe(307);
    expect(response.status).not.toBe(308);
    expect(response.headers.get("location")).toBeNull();
  });
});

describe("proxy: everything else is still gated", () => {
  it("still redirects an unauthenticated request to a protected page", async () => {
    const { proxy } = await import("@/proxy");
    const request = new NextRequest("https://lia.test/overview");

    const response = await proxy(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/sign-in");
  });

  it("still redirects an unauthenticated request to a different API route", async () => {
    // The bug this file exists to catch was specific to `/api/cron` needing
    // to be public; every other API route must keep requiring a session.
    const { proxy } = await import("@/proxy");
    const request = new NextRequest(
      "https://lia.test/api/integrations/google-business-profile/reviews/sync",
      { method: "POST" },
    );

    const response = await proxy(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/sign-in");
  });

  it("still redirects a route that only shares the /api/cron prefix, not the path", async () => {
    // Pins `isPublic`'s exact-segment matching (`pathname === path ||
    // pathname.startsWith(\`${path}/\`)`), not just its current behaviour on
    // the two real cron routes. If someone later loosened the check to a bare
    // `pathname.startsWith(path)`, `/api/cronxyz` — a route that merely
    // starts with the same characters, sharing no path segment with
    // `/api/cron` — would silently become public too. This is the case that
    // would catch that regression; neither test above exercises it, since
    // both real cron paths are legitimately under `/api/cron/`.
    const { proxy } = await import("@/proxy");
    const request = new NextRequest("https://lia.test/api/cronxyz", { method: "POST" });

    const response = await proxy(request);

    expect(response.status).toBe(307);
    expect(response.headers.get("location")).toContain("/sign-in");
  });
});
