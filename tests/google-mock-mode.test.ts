import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Mock mode.
 *
 * Two questions, and both matter for different reasons.
 *
 * "Does the mock actually work?" — because it is what anyone picking this
 * repository up runs first, and a mock connector that silently returns nothing
 * would look identical to a Google account with no locations.
 *
 * "Is it refused in production?" — because a deployment quietly serving
 * fabricated Google accounts to a paying customer is worse than one that fails
 * loudly. That guarantee is only worth having if it is tested.
 *
 * These use the real registry and the real shipped mock connector, so what is
 * exercised is the resolution path a developer gets, not a fake of it.
 */

const ORIGINAL_ENV = { ...process.env };

function setEnv(values: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
}

beforeEach(() => {
  // `src/lib/env.ts` parses process.env once at import, so each case needs a
  // fresh module graph rather than a mutated singleton.
  vi.resetModules();
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
  vi.resetModules();
});

describe("resolution", () => {
  it("selects the mock connector in development when asked", async () => {
    setEnv({
      NODE_ENV: "development",
      GOOGLE_INTEGRATION_MODE: "mock",
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
      GOOGLE_OAUTH_REDIRECT_URI: undefined,
    });

    const { resolveGoogleIntegrationMode } = await import("@/lib/env");
    const { getGoogleConnector } = await import("@/integrations/registry");

    expect(resolveGoogleIntegrationMode()).toBe("mock");
    expect(getGoogleConnector().platform).toBe("google_business_profile");
  });

  it("refuses mock mode in production", async () => {
    setEnv({ NODE_ENV: "production", GOOGLE_INTEGRATION_MODE: "mock" });

    // Refused at environment parse: the process does not get to serve a request
    // and then decide, it fails on import.
    await expect(import("@/lib/env")).rejects.toThrow(
      /GOOGLE_INTEGRATION_MODE=mock is refused in production/,
    );
  });

  it("never chooses the mock on its own", async () => {
    // A developer must not be able to mistake fixture data for a real
    // connection, so an absent configuration is "unconfigured", not "mock".
    setEnv({
      NODE_ENV: "development",
      GOOGLE_INTEGRATION_MODE: undefined,
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
      GOOGLE_OAUTH_REDIRECT_URI: undefined,
    });

    const { resolveGoogleIntegrationMode } = await import("@/lib/env");
    const { isGoogleConnectorAvailable } = await import("@/integrations/registry");

    expect(resolveGoogleIntegrationMode()).toBe("unconfigured");
    expect(isGoogleConnectorAvailable()).toBe(false);
  });

  it("prefers real credentials over nothing, without being told", async () => {
    setEnv({
      NODE_ENV: "development",
      GOOGLE_INTEGRATION_MODE: undefined,
      GOOGLE_CLIENT_ID: "client-id.apps.googleusercontent.com",
      GOOGLE_CLIENT_SECRET: "client-secret-value",
      GOOGLE_OAUTH_REDIRECT_URI: "https://lia.test/callback",
    });

    const { resolveGoogleIntegrationMode } = await import("@/lib/env");
    expect(resolveGoogleIntegrationMode()).toBe("live");
  });

  it("names what is missing when the integration is unconfigured", async () => {
    setEnv({
      NODE_ENV: "development",
      GOOGLE_INTEGRATION_MODE: "live",
      GOOGLE_CLIENT_ID: undefined,
      GOOGLE_CLIENT_SECRET: undefined,
      GOOGLE_OAUTH_REDIRECT_URI: undefined,
    });

    const { getGoogleConnector } = await import("@/integrations/registry");

    // Names, never values — an operator needs to know which variable to set.
    const error = (await Promise.resolve()
      .then(() => getGoogleConnector())
      .catch((thrown: unknown) => thrown)) as { missing: string[] };

    expect(error.missing).toContain("GOOGLE_CLIENT_ID");
    expect(error.missing).toContain("GOOGLE_CLIENT_SECRET");
  });
});

describe("the shipped mock connector", () => {
  async function mockConnector() {
    setEnv({ NODE_ENV: "development", GOOGLE_INTEGRATION_MODE: "mock" });
    const { getGoogleConnector } = await import("@/integrations/registry");
    return getGoogleConnector();
  }

  function session(credentials = {
    accessToken: "mock-access-token",
    refreshToken: "mock-refresh-token",
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    scopes: ["https://www.googleapis.com/auth/business.manage"],
    tokenType: "Bearer",
  }) {
    return { credentials, async onRefreshed() {} };
  }

  it("returns more than one account, so the account selector is reachable", async () => {
    // A single-account fixture would leave the multi-account path untested by
    // anyone developing against the mock.
    const connector = await mockConnector();
    const accounts = await connector.listExternalAccounts(session());

    expect(accounts.length).toBeGreaterThan(1);
    expect(accounts[0]?.externalAccountId).toMatch(/^accounts\//);
  });

  it("returns locations that exercise the awkward cases", async () => {
    const connector = await mockConnector();
    const profiles = await connector.listExternalProfiles(
      session(),
      "accounts/1122334455",
    );

    expect(profiles.length).toBeGreaterThan(0);
    // A near-match that must not auto-apply, and an unverified listing.
    expect(profiles.some((profile) => profile.verificationState === "UNVERIFIED")).toBe(
      true,
    );
    // And one with no address at all, on the other account.
    const other = await connector.listExternalProfiles(session(), "accounts/6677889900");
    expect(other.some((profile) => profile.address === undefined)).toBe(true);
  });

  it("is deterministic across calls", async () => {
    const connector = await mockConnector();

    const first = await connector.listExternalProfiles(session(), "accounts/1122334455");
    const second = await connector.listExternalProfiles(session(), "accounts/1122334455");

    expect(first).toEqual(second);
  });

  it("returns an empty list for an unknown account rather than throwing", async () => {
    const connector = await mockConnector();
    await expect(
      connector.listExternalProfiles(session(), "accounts/does-not-exist"),
    ).resolves.toEqual([]);
  });

  it("declares the same capabilities as the real connector", async () => {
    // UI code must not be able to tell which implementation it received.
    const connector = await mockConnector();
    const { GOOGLE_CONNECTOR_CAPABILITIES } = await import(
      "@/integrations/google-business-profile/connector"
    );

    expect(connector.capabilities()).toEqual(GOOGLE_CONNECTOR_CAPABILITIES);
  });

  it("sends the user back through Lia's own callback", async () => {
    // So clicking Connect in development walks the identical route handler,
    // state validation, and persistence path a real grant would.
    const connector = await mockConnector();
    const url = new URL(
      await connector.getAuthorizationUrl({ state: "state-value", forceConsent: false }),
    );

    expect(url.pathname).toBe("/api/integrations/google-business-profile/callback");
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.get("code")).toBeTruthy();
  });

  it("reproduces Google withholding a refresh token on re-consent", async () => {
    const connector = await mockConnector();

    const first = await connector.exchangeAuthorizationCode({ code: "mock-code" });
    const reconnect = await connector.exchangeAuthorizationCode({
      code: "mock-reauth-code",
    });

    expect(first.refreshToken).not.toBeNull();
    expect(reconnect.refreshToken).toBeNull();
  });
});
