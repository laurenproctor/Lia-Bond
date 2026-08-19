import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The Yelp deployment gates.
 *
 * Mirrors `env-rules-execution.test.ts` and `news-mock-mode.test.ts`: the
 * environment is parsed once at module load, so every case re-imports.
 */
async function loadEnv(vars: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(vars)) {
    // `NODE_ENV` is typed read-only, so it goes through `vi.stubEnv` — the
    // convention `news-mock-mode.test.ts` already uses — while everything else
    // is assigned directly, matching `env-rules-execution.test.ts`.
    if (key === "NODE_ENV") {
      vi.stubEnv("NODE_ENV", (value ?? "development") as "development" | "production");
    } else if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return import("@/lib/env");
}

afterEach(() => {
  delete process.env.LIA_YELP_MODE;
  delete process.env.YELP_API_KEY;
  delete process.env.YELP_MAX_CHECKS_PER_SWEEP;
  vi.unstubAllEnvs();
});

describe("Yelp mode resolution", () => {
  it("is unconfigured when nothing is set", async () => {
    const env = await loadEnv({ LIA_YELP_MODE: undefined, YELP_API_KEY: undefined });
    expect(env.resolveYelpMode()).toBe("unconfigured");
  });

  it("does not infer live from a key alone", async () => {
    // The news rule, not the Google one. A Yelp key belongs to a plan, and the
    // plan decides which endpoints answer — so holding a key is not the same as
    // having decided to turn Yelp on.
    const env = await loadEnv({ YELP_API_KEY: "yelp-key", LIA_YELP_MODE: undefined });
    expect(env.resolveYelpMode()).toBe("unconfigured");
  });

  it("is unconfigured when live is asked for without a key", async () => {
    const env = await loadEnv({ LIA_YELP_MODE: "live", YELP_API_KEY: undefined });
    expect(env.resolveYelpMode()).toBe("unconfigured");
  });

  it("is live only when both the mode and the key are present", async () => {
    const env = await loadEnv({ LIA_YELP_MODE: "live", YELP_API_KEY: "yelp-key" });
    expect(env.resolveYelpMode()).toBe("live");
  });

  it("serves mock outside production", async () => {
    const env = await loadEnv({ LIA_YELP_MODE: "mock", NODE_ENV: "development" });
    expect(env.resolveYelpMode()).toBe("mock");
  });

  it("refuses mock in production at the startup parse", async () => {
    await expect(
      loadEnv({ LIA_YELP_MODE: "mock", NODE_ENV: "production" }),
    ).rejects.toThrow(/LIA_YELP_MODE/);
  });

  it("rejects an unrecognised mode at import, like every other mode enum", async () => {
    await expect(loadEnv({ LIA_YELP_MODE: "demo" })).rejects.toThrow();
  });
});

describe("requireYelpApiKey", () => {
  it("names the missing variable rather than describing the failure vaguely", async () => {
    const env = await loadEnv({ YELP_API_KEY: undefined });
    expect(() => env.requireYelpApiKey()).toThrow(/not configured/i);
    try {
      env.requireYelpApiKey();
      expect.unreachable("requireYelpApiKey should throw with no key set");
    } catch (error) {
      expect((error as { missing?: string[] }).missing).toEqual(["YELP_API_KEY"]);
    }
  });

  it("returns the key when it is set", async () => {
    const env = await loadEnv({ YELP_API_KEY: "yelp-key" });
    expect(env.requireYelpApiKey()).toBe("yelp-key");
  });

  it("never puts the key value into the error a misconfiguration produces", async () => {
    // The whole point of ConfigurationError.missing carrying names: an operator
    // sees which variable to set, and a log of that error cannot leak the
    // secret if one was partially configured elsewhere.
    const env = await loadEnv({ YELP_API_KEY: undefined, LIA_YELP_MODE: "live" });
    try {
      env.requireYelpApiKey();
      expect.unreachable("requireYelpApiKey should throw with no key set");
    } catch (error) {
      expect(String(error)).not.toContain("yelp-key");
    }
  });
});

describe("Yelp sweep budget", () => {
  it("defaults conservatively so a sweep cannot spend the interactive headroom", async () => {
    const env = await loadEnv({ YELP_MAX_CHECKS_PER_SWEEP: undefined });
    expect(env.yelpMaxChecksPerSweep()).toBe(env.DEFAULT_YELP_MAX_CHECKS_PER_SWEEP);
  });

  it("accepts an override", async () => {
    const env = await loadEnv({ YELP_MAX_CHECKS_PER_SWEEP: "12" });
    expect(env.yelpMaxChecksPerSweep()).toBe(12);
  });

  it("refuses a zero or negative budget at startup rather than disabling checks silently", async () => {
    await expect(loadEnv({ YELP_MAX_CHECKS_PER_SWEEP: "0" })).rejects.toThrow();
    await expect(loadEnv({ YELP_MAX_CHECKS_PER_SWEEP: "-5" })).rejects.toThrow();
  });
});
