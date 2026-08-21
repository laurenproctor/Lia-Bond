import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Billing configuration, and specifically the pairings that must fail at
 * startup rather than at the till.
 *
 * The environment is the one place a billing bug is silent by default: a
 * sandbox key in production charges nobody and looks perfectly healthy, and an
 * allowlist mode with an empty list reads as switched on while enforcing for
 * no one. Both are refused at import, so this file is mostly a record of what
 * "refused" means.
 */

/**
 * `vi.stubEnv` rather than assigning `process.env` directly: NODE_ENV is typed
 * readonly, and these tests have to move it to reach the production-only
 * refusals. The same helper the cron tests use.
 */
async function loadEnv(vars: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(vars)) {
    vi.stubEnv(key, value as string);
  }
  return import("@/lib/env");
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

/**
 * Assembled at runtime rather than written as string literals.
 *
 * These are fabricated and always were, but a fabricated key that still
 * *looks* like one trips GitHub's push protection — which it did, on the first
 * push of this branch. The fix is to stop them looking like keys rather than
 * to allowlist them: an allowlisted fake secret is how the scanner gets
 * trained to be ignored, and the next one it flags might be real.
 *
 * They still have to satisfy the shape `STRIPE_SECRET_KEY` validates, because
 * the whole point of the tests below is that the shape is enforced.
 */
const fakeKey = (mode: "test" | "live") => ["sk", mode, "0".repeat(24)].join("_");

const TEST_KEY = fakeKey("test");
const LIVE_KEY = fakeKey("live");
const WEBHOOK_SECRET = ["whsec", "0".repeat(32)].join("_");

describe("whether Stripe is configured", () => {
  it("needs both halves, because either alone is worse than neither", async () => {
    const keyOnly = await loadEnv({
      STRIPE_SECRET_KEY: TEST_KEY,
      STRIPE_WEBHOOK_SECRET: undefined,
    });
    expect(keyOnly.isStripeConfigured()).toBe(false);

    const secretOnly = await loadEnv({
      STRIPE_SECRET_KEY: undefined,
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    });
    expect(secretOnly.isStripeConfigured()).toBe(false);

    const both = await loadEnv({
      STRIPE_SECRET_KEY: TEST_KEY,
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    });
    expect(both.isStripeConfigured()).toBe(true);
  });

  it("reports unconfigured rather than failing on a fresh clone", async () => {
    const env = await loadEnv({
      STRIPE_SECRET_KEY: undefined,
      STRIPE_WEBHOOK_SECRET: undefined,
    });
    expect(env.resolveBillingMode()).toBe("unconfigured");
    expect(env.isStripeConfigured()).toBe(false);
  });

  it("names the missing variable rather than its value", async () => {
    const env = await loadEnv({ STRIPE_SECRET_KEY: undefined });
    try {
      env.requireStripeSecretKey();
      expect.unreachable("should have thrown");
    } catch (error) {
      expect(error).toBeInstanceOf(env.ConfigurationError);
      expect((error as InstanceType<typeof env.ConfigurationError>).missing).toEqual([
        "STRIPE_SECRET_KEY",
      ]);
    }
  });
});

describe("key shape", () => {
  it("refuses a publishable key where a secret key belongs", async () => {
    await expect(
      loadEnv({ STRIPE_SECRET_KEY: ["pk", "test", "0".repeat(24)].join("_") }),
    ).rejects.toThrow();
  });

  it("refuses a restricted key", async () => {
    await expect(
      loadEnv({ STRIPE_SECRET_KEY: ["rk", "test", "0".repeat(24)].join("_") }),
    ).rejects.toThrow();
  });

  it("refuses a webhook secret that is not one", async () => {
    await expect(
      loadEnv({ STRIPE_WEBHOOK_SECRET: "not-a-signing-secret" }),
    ).rejects.toThrow();
  });
});

describe("the two mode mistakes that look like they are working", () => {
  /**
   * A sandbox key in production: Checkout succeeds, the portal opens, webhooks
   * arrive, the projection updates, and no money moves — for as long as it
   * takes somebody to notice.
   */
  it("refuses a sandbox key in production", async () => {
    await expect(
      loadEnv({ NODE_ENV: "production", STRIPE_SECRET_KEY: TEST_KEY }),
    ).rejects.toThrow();
  });

  /** The reverse is worse: a branch preview charging real cards. */
  it("refuses a live key in development", async () => {
    await expect(
      loadEnv({ NODE_ENV: "development", STRIPE_SECRET_KEY: LIVE_KEY }),
    ).rejects.toThrow();
  });

  it("allows the correct pairings", async () => {
    const production = await loadEnv({
      NODE_ENV: "production",
      STRIPE_SECRET_KEY: LIVE_KEY,
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    });
    expect(production.isStripeLiveMode()).toBe(true);

    const development = await loadEnv({
      NODE_ENV: "development",
      STRIPE_SECRET_KEY: TEST_KEY,
      STRIPE_WEBHOOK_SECRET: WEBHOOK_SECRET,
    });
    expect(development.isStripeLiveMode()).toBe(false);
  });

  it("refuses the mock in production, like every other mock in this file", async () => {
    await expect(
      loadEnv({ NODE_ENV: "production", LIA_BILLING_MODE: "mock" }),
    ).rejects.toThrow();
  });

  it("never reports live mode while mocked, whatever key is lying around", async () => {
    const env = await loadEnv({
      LIA_BILLING_MODE: "mock",
      STRIPE_SECRET_KEY: LIVE_KEY,
      NODE_ENV: "test",
    });
    expect(env.isBillingMocked()).toBe(true);
    expect(env.isStripeLiveMode()).toBe(false);
  });
});

describe("enforcement rollout", () => {
  it("defaults to off when unset", async () => {
    const env = await loadEnv({ BILLING_ENFORCEMENT_MODE: undefined });
    expect(env.resolveBillingEnforcementMode()).toBe("off");
  });

  it("round-trips the three modes", async () => {
    for (const mode of ["off", "on"] as const) {
      const env = await loadEnv({ BILLING_ENFORCEMENT_MODE: mode });
      expect(env.resolveBillingEnforcementMode()).toBe(mode);
    }
    const allowlisted = await loadEnv({
      BILLING_ENFORCEMENT_MODE: "allowlist",
      BILLING_ORG_ALLOWLIST: "org-a",
    });
    expect(allowlisted.resolveBillingEnforcementMode()).toBe("allowlist");
  });

  it("rejects an unrecognised mode at import", async () => {
    await expect(
      loadEnv({ BILLING_ENFORCEMENT_MODE: "enabled" }),
    ).rejects.toThrow();
  });

  /**
   * The gap this closes: `allowlist` with nobody on it enforces for nobody,
   * which behaves exactly like `off` while reading as switched on. That is
   * where somebody concludes the rollout is finished when it has not started.
   */
  it("refuses allowlist mode with an empty allowlist", async () => {
    await expect(
      loadEnv({
        BILLING_ENFORCEMENT_MODE: "allowlist",
        BILLING_ORG_ALLOWLIST: undefined,
      }),
    ).rejects.toThrow();

    await expect(
      loadEnv({
        BILLING_ENFORCEMENT_MODE: "allowlist",
        BILLING_ORG_ALLOWLIST: "   ",
      }),
    ).rejects.toThrow();
  });

  it("parses the allowlist, dropping empties and whitespace", async () => {
    const env = await loadEnv({ BILLING_ORG_ALLOWLIST: "org-a, org-b,,org-c" });
    expect(env.billingOrganizationAllowlist()).toEqual(["org-a", "org-b", "org-c"]);

    const empty = await loadEnv({ BILLING_ORG_ALLOWLIST: undefined });
    expect(empty.billingOrganizationAllowlist()).toEqual([]);
  });
});
