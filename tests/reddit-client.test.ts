import { afterEach, describe, expect, it, vi } from "vitest";
import {
  REDDIT_ERROR_MESSAGES,
  RedditError,
  redditError,
  redditErrorForStatus,
  type RedditErrorCode,
} from "@/reddit/errors";
import {
  redditCommentSchema,
  redditListingSchema,
  redditPostSchema,
  redditTokenSchema,
} from "@/reddit/schemas";

/**
 * The provider boundary's contract, minus the live HTTP client — which is
 * deliberately not built. Writing it before the Reddit agreement is signed
 * would mean shipping code whose only purpose is to make unauthorized requests,
 * one environment variable away from running.
 *
 * What is testable now, and what these tests pin: the normalisation of a
 * provider failure into something a person can act on, the schemas' refusal to
 * carry fields Lia does not store, and the registry's refusal to hand out a
 * connector at all when the deployment holds no approval.
 */

const ALL_CODES: RedditErrorCode[] = [
  "not_configured",
  "not_authorized",
  "insufficient_scope",
  "rate_limited",
  "provider_unavailable",
  "invalid_query",
  "target_unavailable",
  "policy_blocked",
  "unexpected_output",
];

describe("reddit errors", () => {
  it("gives every code a Lia-authored sentence", () => {
    for (const code of ALL_CODES) {
      const message = REDDIT_ERROR_MESSAGES[code];
      expect(message.trim().length).toBeGreaterThan(20);
      // Never the provider's own words: Reddit's error bodies can quote the
      // request, and the request holds a customer's monitor terms or an
      // approved reply.
      expect(message).not.toMatch(/\b(HTTP|[45]\d\d|reddit\.com\/api)\b/);
    }
  });

  it("marks only the genuinely transient codes retryable", () => {
    // Retrying `target_unavailable` or `policy_blocked` spends budget to
    // arrive at the same refusal; retrying `not_configured` cannot produce a
    // contract.
    expect(redditError("rate_limited").retryable).toBe(true);
    expect(redditError("provider_unavailable").retryable).toBe(true);
    for (const code of ["not_configured", "target_unavailable", "policy_blocked", "insufficient_scope"] as const) {
      expect(redditError(code).retryable).toBe(false);
    }
  });

  it("carries the provider's own wait rather than guessing one", () => {
    expect(redditError("rate_limited", { retryAfterSeconds: 30 }).retryAfterSeconds).toBe(30);
    expect(redditError("rate_limited").retryAfterSeconds).toBeNull();
  });

  it("is an Error, so it survives an ordinary catch", () => {
    const error = redditError("policy_blocked");
    expect(error).toBeInstanceOf(Error);
    expect(error).toBeInstanceOf(RedditError);
    expect(error.name).toBe("RedditError");
  });
});

describe("redditErrorForStatus", () => {
  it("maps the unambiguous statuses", () => {
    expect(redditErrorForStatus(401)).toBe("not_authorized");
    expect(redditErrorForStatus(404)).toBe("target_unavailable");
    expect(redditErrorForStatus(410)).toBe("target_unavailable");
    expect(redditErrorForStatus(429)).toBe("rate_limited");
    expect(redditErrorForStatus(400)).toBe("invalid_query");
    expect(redditErrorForStatus(500)).toBe("provider_unavailable");
    expect(redditErrorForStatus(503)).toBe("provider_unavailable");
  });

  it("splits 403 on what the connector actually knows about the grant", () => {
    // Reddit returns 403 both for a missing scope and for a revoked grant, and
    // the two have different remedies: reauthorize with more permissions, or
    // reconnect entirely.
    expect(redditErrorForStatus(403, { hasRequiredScope: false })).toBe(
      "insufficient_scope",
    );
    expect(redditErrorForStatus(403, { hasRequiredScope: true })).toBe("not_authorized");
    // Unknown: the more conservative of the two, because telling somebody to
    // reauthorize when the grant is fine wastes their time, while telling them
    // nothing is wrong when it has been revoked leaves monitoring silently dead.
    expect(redditErrorForStatus(403)).toBe("not_authorized");
  });

  it("falls back to unexpected_output rather than inventing a cause", () => {
    expect(redditErrorForStatus(302)).toBe("unexpected_output");
    expect(redditErrorForStatus(418)).toBe("unexpected_output");
  });
});

describe("reddit schemas", () => {
  it("strips every field Lia does not store", () => {
    // `.passthrough()` is deliberately absent from these schemas. Zod's
    // default strip is what makes "Lia holds a named subset" true by
    // construction rather than by discipline at each call site.
    const parsed = redditPostSchema.parse({
      id: "abc",
      name: "t3_abc",
      subreddit: "askculinary",
      created_utc: 1786000000,
      title: "Title",
      author_flair_text: "Chef",
      gildings: { gid_1: 1 },
      subreddit_subscribers: 2_000_000,
    });
    expect(parsed).not.toHaveProperty("author_flair_text");
    expect(parsed).not.toHaveProperty("gildings");
    expect(parsed).not.toHaveProperty("subreddit_subscribers");
  });

  it("coerces Reddit's float epoch rather than failing on it", () => {
    expect(
      redditPostSchema.parse({
        id: "abc",
        name: "t3_abc",
        subreddit: "askculinary",
        created_utc: 1786000000.5,
        title: "Title",
      }).created_utc,
    ).toBe(1786000000.5);
  });

  it("refuses a comment with no parent or root, which has no place in a thread", () => {
    expect(
      redditCommentSchema.safeParse({
        id: "c",
        name: "t1_c",
        subreddit: "askculinary",
        created_utc: 1786000000,
        body: "text",
      }).success,
    ).toBe(false);
  });

  it("accepts a listing envelope with mixed children", () => {
    const parsed = redditListingSchema.safeParse({
      kind: "Listing",
      data: {
        after: null,
        children: [
          { kind: "t3", data: { id: "a" } },
          { kind: "more", data: { count: 5 } },
        ],
      },
    });
    expect(parsed.success).toBe(true);
  });

  it("treats a token response's scope as reported, not as requested", () => {
    // The grant may be narrower than the request, and assuming otherwise is
    // how a Publish button appears for an account that cannot post.
    const parsed = redditTokenSchema.parse({
      access_token: "token",
      token_type: "bearer",
      expires_in: "3600",
      scope: "identity read",
    });
    expect(parsed.scope).toBe("identity read");
    expect(parsed.expires_in).toBe(3600);
  });

  it("accepts a token response with no refresh token", () => {
    // Reddit withholds one on re-consent. Requiring it would break every
    // reauthorization.
    expect(
      redditTokenSchema.safeParse({ access_token: "t", token_type: "bearer" }).success,
    ).toBe(true);
  });
});

describe("reddit registry", () => {
  const VARS = [
    "LIA_REDDIT_MODE",
    "REDDIT_ROLLOUT_STAGE",
    "REDDIT_ACCESS_APPROVAL_REF",
    "REDDIT_CLIENT_ID",
    "REDDIT_CLIENT_SECRET",
    "REDDIT_OAUTH_REDIRECT_URI",
    "REDDIT_USER_AGENT",
    "TOKEN_ENCRYPTION_KEY",
  ] as const;

  async function load(vars: Record<string, string | undefined>) {
    vi.resetModules();
    for (const key of VARS) vi.stubEnv(key, undefined);
    for (const [key, value] of Object.entries(vars)) {
      if (value !== undefined) vi.stubEnv(key, value);
    }
    return import("@/reddit/registry");
  }

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("refuses to hand out a connector when Reddit is off", async () => {
    const registry = await load({});
    expect(registry.isRedditAvailable()).toBe(false);
    expect(() => registry.getRedditConnector()).toThrow(/turned off|not configured/i);
  });

  it("names the agreement, not a setting, when approval is what is missing", async () => {
    // An operator told to check their configuration when the real problem is
    // an unsigned contract goes down a path that ends where it started.
    const registry = await load({
      LIA_REDDIT_MODE: "live",
      REDDIT_ROLLOUT_STAGE: "read_only",
      REDDIT_CLIENT_ID: "reddit-client-id-value",
      REDDIT_CLIENT_SECRET: "reddit-client-secret-value",
      REDDIT_OAUTH_REDIRECT_URI: "https://lia.bond/api/integrations/reddit/callback",
      REDDIT_USER_AGENT: "web:bond.lia.monitor:0.1.0 (by /u/lia-ops)",
      TOKEN_ENCRYPTION_KEY: "a".repeat(44),
    });
    expect(() => registry.getRedditConnector()).toThrow(/agreement, not a setting/i);
  });

  it("serves the mock when mock mode is on", async () => {
    const registry = await load({
      LIA_REDDIT_MODE: "mock",
      REDDIT_ROLLOUT_STAGE: "read_write",
      TOKEN_ENCRYPTION_KEY: "a".repeat(44),
    });
    expect(registry.isRedditAvailable()).toBe(true);
    expect(registry.getRedditConnector().platform).toBe("reddit");
  });

  it("says plainly that the live client is not built rather than failing obscurely", async () => {
    // Building it before Gate 0 would mean shipping code whose only purpose is
    // to make unauthorized requests, one variable away from running.
    const registry = await load({
      LIA_REDDIT_MODE: "live",
      REDDIT_ROLLOUT_STAGE: "read_only",
      REDDIT_CLIENT_ID: "reddit-client-id-value",
      REDDIT_CLIENT_SECRET: "reddit-client-secret-value",
      REDDIT_OAUTH_REDIRECT_URI: "https://lia.bond/api/integrations/reddit/callback",
      REDDIT_USER_AGENT: "web:bond.lia.monitor:0.1.0 (by /u/lia-ops)",
      REDDIT_ACCESS_APPROVAL_REF: "2026-08-14:reddit-data-api-commercial",
      TOKEN_ENCRYPTION_KEY: "a".repeat(44),
    });
    expect(() => registry.getRedditConnector()).toThrow(/not implemented/i);
  });
});
