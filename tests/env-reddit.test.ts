import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * Reddit's deployment gates.
 *
 * Every other integration in this repository answers one question — is it
 * configured? Reddit answers two, and the second one is not a technical fact:
 * Reddit grants commercial API access by contract, so a deployment can hold a
 * perfectly valid OAuth client and still have no right to use it. These tests
 * pin the rule that a missing approval marker is as disqualifying as a missing
 * client secret, and that both fail to `off` rather than to something partial.
 */

const REDDIT_VARS = [
  "REDDIT_CLIENT_ID",
  "REDDIT_CLIENT_SECRET",
  "REDDIT_OAUTH_REDIRECT_URI",
  "REDDIT_USER_AGENT",
  "LIA_REDDIT_MODE",
  "REDDIT_ROLLOUT_STAGE",
  "REDDIT_ORG_ALLOWLIST",
  "REDDIT_ACCESS_APPROVAL_REF",
  "REDDIT_AI_INFERENCE",
  "TOKEN_ENCRYPTION_KEY",
  "TOKEN_ENCRYPTION_KEY_ID",
  "NODE_ENV",
] as const;

/** A fully approved, fully configured live deployment. */
const LIVE_AND_APPROVED = {
  LIA_REDDIT_MODE: "live",
  REDDIT_CLIENT_ID: "reddit-client-id-value",
  REDDIT_CLIENT_SECRET: "reddit-client-secret-value",
  REDDIT_OAUTH_REDIRECT_URI: "https://lia.bond/api/integrations/reddit/callback",
  REDDIT_USER_AGENT: "web:bond.lia.monitor:0.1.0 (by /u/lia-ops)",
  REDDIT_ACCESS_APPROVAL_REF: "2026-08-14:reddit-data-api-commercial",
  TOKEN_ENCRYPTION_KEY: "a".repeat(44),
} as const;

/** `LIVE_AND_APPROVED` minus one key, for the "what happens without it" cases. */
function approvedWithout(
  key: keyof typeof LIVE_AND_APPROVED,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(LIVE_AND_APPROVED).filter(([name]) => name !== key),
  );
}

async function loadEnv(vars: Record<string, string | undefined>) {
  vi.resetModules();
  // Every Reddit variable is cleared first, so a case only ever sees what it
  // names — and `vi.stubEnv` rather than direct assignment because NODE_ENV is
  // typed read-only, which is also how the rest of the suite does it.
  for (const key of REDDIT_VARS) vi.stubEnv(key, undefined);
  for (const [key, value] of Object.entries(vars)) {
    if (value !== undefined) vi.stubEnv(key, value);
  }
  return import("@/lib/env");
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("reddit mode", () => {
  it("is unconfigured when unset — the news rule, not the Google one", async () => {
    const env = await loadEnv({});
    expect(env.resolveRedditMode()).toBe("unconfigured");
  });

  it("needs `live` set explicitly *and* a complete OAuth client", async () => {
    // Credentials alone do not imply live: unlike Google, an operator holding
    // Reddit credentials may still be waiting on the contract.
    const credentialsOnly = await loadEnv({
      REDDIT_CLIENT_ID: LIVE_AND_APPROVED.REDDIT_CLIENT_ID,
      REDDIT_CLIENT_SECRET: LIVE_AND_APPROVED.REDDIT_CLIENT_SECRET,
      REDDIT_OAUTH_REDIRECT_URI: LIVE_AND_APPROVED.REDDIT_OAUTH_REDIRECT_URI,
    });
    expect(credentialsOnly.resolveRedditMode()).toBe("unconfigured");

    const declaredOnly = await loadEnv({ LIA_REDDIT_MODE: "live" });
    expect(declaredOnly.resolveRedditMode()).toBe("unconfigured");

    const both = await loadEnv({ ...LIVE_AND_APPROVED });
    expect(both.resolveRedditMode()).toBe("live");
  });

  it("rejects an unrecognized mode at import, like every other mode enum", async () => {
    await expect(loadEnv({ LIA_REDDIT_MODE: "sandbox" })).rejects.toThrow();
  });

  it("refuses mock in production at parse and again at resolve", async () => {
    await expect(
      loadEnv({ LIA_REDDIT_MODE: "mock", NODE_ENV: "production" }),
    ).rejects.toThrow(/LIA_REDDIT_MODE=mock is refused in production/);
  });

  it("serves mock without any Reddit credential", async () => {
    const env = await loadEnv({
      LIA_REDDIT_MODE: "mock",
      TOKEN_ENCRYPTION_KEY: LIVE_AND_APPROVED.TOKEN_ENCRYPTION_KEY,
    });
    expect(env.resolveRedditMode()).toBe("mock");
  });
});

describe("reddit user agent", () => {
  it("rejects a shape Reddit throttles, at import", async () => {
    // Reddit asks for `<platform>:<app id>:<version> (by /u/<username>)` and
    // throttles generic agents far harder. A malformed one is a configuration
    // error, not something to discover from a 429 in production.
    await expect(
      loadEnv({ ...LIVE_AND_APPROVED, REDDIT_USER_AGENT: "Lia/1.0" }),
    ).rejects.toThrow(/REDDIT_USER_AGENT/);
  });

  it("accepts the documented shape", async () => {
    const env = await loadEnv({ ...LIVE_AND_APPROVED });
    expect(env.resolveRedditDeployment().blockers).toEqual([]);
  });
});

describe("reddit rollout stage", () => {
  it("is off when unset, and asks for nothing else", async () => {
    const env = await loadEnv({});
    const deployment = env.resolveRedditDeployment();
    expect(deployment.requestedStage).toBe("off");
    expect(deployment.effectiveStage).toBe("off");
    // An operator who has not asked for Reddit is not shown a list of things
    // they failed to configure.
    expect(deployment.blockers).toEqual([]);
  });

  it("rejects an unrecognized stage at import", async () => {
    await expect(loadEnv({ REDDIT_ROLLOUT_STAGE: "readonly" })).rejects.toThrow();
  });

  it("runs read_only and read_write once everything is present", async () => {
    for (const stage of ["read_only", "read_write"] as const) {
      const env = await loadEnv({ ...LIVE_AND_APPROVED, REDDIT_ROLLOUT_STAGE: stage });
      const deployment = env.resolveRedditDeployment();
      expect(deployment.effectiveStage).toBe(stage);
      expect(deployment.blockers).toEqual([]);
    }
  });
});

describe("reddit gate 0 blockers", () => {
  it("falls to off — never to read_only — when the approval marker is missing", async () => {
    // The contract governs reading too. Downgrading an unapproved read_write
    // deployment to read_only would keep making the calls Reddit has not
    // agreed to; it would only stop the ones it has.
    const env = await loadEnv({
      ...approvedWithout("REDDIT_ACCESS_APPROVAL_REF"),
      REDDIT_ROLLOUT_STAGE: "read_write",
    });
    const deployment = env.resolveRedditDeployment();
    expect(deployment.requestedStage).toBe("read_write");
    expect(deployment.effectiveStage).toBe("off");
    expect(deployment.blockers).toContain("approval_not_recorded");
  });

  it("requires the approval marker to carry its date", async () => {
    // `YYYY-MM-DD:<reference>` rather than a free string, so the marker cannot
    // be satisfied by typing "approved" and so the retention schedule has a
    // date to count from.
    await expect(
      loadEnv({ ...LIVE_AND_APPROVED, REDDIT_ACCESS_APPROVAL_REF: "approved" }),
    ).rejects.toThrow(/REDDIT_ACCESS_APPROVAL_REF/);
  });

  it("blocks on a missing credential vault, in mock mode too", async () => {
    // The mock seals its fake tokens through the same vault; running the real
    // encryption path locally is what catches a broken one before production.
    const env = await loadEnv({
      LIA_REDDIT_MODE: "mock",
      REDDIT_ROLLOUT_STAGE: "read_write",
    });
    const deployment = env.resolveRedditDeployment();
    expect(deployment.effectiveStage).toBe("off");
    expect(deployment.blockers).toContain("credential_encryption_missing");
  });

  it("blocks on an unconfigured deployment", async () => {
    const env = await loadEnv({
      REDDIT_ROLLOUT_STAGE: "read_only",
      TOKEN_ENCRYPTION_KEY: LIVE_AND_APPROVED.TOKEN_ENCRYPTION_KEY,
    });
    const deployment = env.resolveRedditDeployment();
    expect(deployment.effectiveStage).toBe("off");
    expect(deployment.blockers).toContain("deployment_not_configured");
  });

  it("does not ask a mock deployment for a contract it cannot breach", async () => {
    // Fabricated threads are not Reddit's data. Requiring the approval marker
    // here would make the mock unusable for exactly the people who have not
    // got approval yet, which is its entire audience.
    const env = await loadEnv({
      LIA_REDDIT_MODE: "mock",
      REDDIT_ROLLOUT_STAGE: "read_write",
      TOKEN_ENCRYPTION_KEY: LIVE_AND_APPROVED.TOKEN_ENCRYPTION_KEY,
    });
    const deployment = env.resolveRedditDeployment();
    expect(deployment.effectiveStage).toBe("read_write");
    expect(deployment.blockers).toEqual([]);
    expect(deployment.approvalRef).toBeNull();
  });
});

describe("reddit ai inference permission", () => {
  it("is refused unless the contract is recorded as permitting it", async () => {
    const env = await loadEnv({ ...LIVE_AND_APPROVED });
    expect(env.resolveRedditDeployment().aiInferencePermitted).toBe(false);
  });

  it("is granted when recorded, and rejects anything else at import", async () => {
    const env = await loadEnv({
      ...LIVE_AND_APPROVED,
      REDDIT_AI_INFERENCE: "permitted",
    });
    expect(env.resolveRedditDeployment().aiInferencePermitted).toBe(true);

    await expect(
      loadEnv({ ...LIVE_AND_APPROVED, REDDIT_AI_INFERENCE: "true" }),
    ).rejects.toThrow();
  });

  it("is granted in mock mode, where no Reddit content exists to infer over", async () => {
    const env = await loadEnv({
      LIA_REDDIT_MODE: "mock",
      TOKEN_ENCRYPTION_KEY: LIVE_AND_APPROVED.TOKEN_ENCRYPTION_KEY,
    });
    expect(env.resolveRedditDeployment().aiInferencePermitted).toBe(true);
  });
});

describe("reddit organization allowlist", () => {
  it("parses, trims, and drops empties", async () => {
    const env = await loadEnv({ REDDIT_ORG_ALLOWLIST: "org-a, org-b,,org-c " });
    expect(env.redditOrganizationAllowlist()).toEqual(["org-a", "org-b", "org-c"]);
  });

  it("is empty when unset — no organization is admitted by default", async () => {
    const env = await loadEnv({});
    expect(env.redditOrganizationAllowlist()).toEqual([]);
  });
});

describe("reddit oauth config", () => {
  it("names exactly what is missing rather than failing vaguely", async () => {
    const env = await loadEnv({
      LIA_REDDIT_MODE: "live",
      REDDIT_CLIENT_ID: LIVE_AND_APPROVED.REDDIT_CLIENT_ID,
    });
    expect(() => env.requireRedditOAuthConfig()).toThrow(
      /not configured on this server/,
    );
    try {
      env.requireRedditOAuthConfig();
    } catch (error) {
      expect((error as { missing: string[] }).missing).toEqual([
        "REDDIT_CLIENT_SECRET",
        "REDDIT_OAUTH_REDIRECT_URI",
        "REDDIT_USER_AGENT",
      ]);
    }
  });

  it("returns the client, the redirect, and the user agent together", async () => {
    const env = await loadEnv({ ...LIVE_AND_APPROVED });
    expect(env.requireRedditOAuthConfig()).toEqual({
      clientId: LIVE_AND_APPROVED.REDDIT_CLIENT_ID,
      clientSecret: LIVE_AND_APPROVED.REDDIT_CLIENT_SECRET,
      redirectUri: LIVE_AND_APPROVED.REDDIT_OAUTH_REDIRECT_URI,
      userAgent: LIVE_AND_APPROVED.REDDIT_USER_AGENT,
    });
  });
});
