import { describe, expect, it, vi } from "vitest";
import type { CredentialSession, PlatformCredentials } from "@/integrations/connector";
import { IntegrationError } from "@/integrations/errors";
import {
  createGoogleBusinessProfileConnector,
  dedupeProfiles,
  normalizeAccount,
  normalizeLocation,
} from "@/integrations/google-business-profile/connector";
import {
  GOOGLE_BUSINESS_MANAGE_SCOPE,
  GOOGLE_SCOPES_DELIBERATELY_OMITTED,
  hasRequiredScopes,
  missingScopes,
} from "@/integrations/google-business-profile/scopes";

/**
 * The Google connector.
 *
 * Every network call is stubbed. What is being tested is the connector's own
 * policy: when it refreshes, how it classifies a failure, and how a Google
 * resource becomes a Lia-shaped record — none of which need a real Google
 * project, and all of which would be untestable without a seam for `fetch`.
 */

const CONFIG = {
  clientId: "test-client-id.apps.googleusercontent.com",
  clientSecret: "test-client-secret",
  redirectUri: "https://lia.test/api/integrations/google-business-profile/callback",
};

interface StubResponse {
  status?: number;
  body: unknown;
}

/** A `fetch` that answers from a URL→response table and records what it saw. */
function stubFetch(routes: Array<[RegExp, StubResponse | StubResponse[]]>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const queues = new Map<RegExp, StubResponse[]>(
    routes.map(([pattern, response]) => [
      pattern,
      Array.isArray(response) ? [...response] : [response],
    ]),
  );

  const impl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init: init ?? {} });

    for (const [pattern, queue] of queues) {
      if (!pattern.test(url)) continue;
      // Repeat the last entry once a queue runs dry, so pagination stubs do not
      // need padding to the exact call count.
      const next = queue.length > 1 ? queue.shift()! : queue[0]!;
      return new Response(JSON.stringify(next.body), {
        status: next.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    }

    throw new Error(`Unstubbed request: ${url}`);
  });

  return { impl: impl as unknown as typeof fetch, calls };
}

function connectorWith(routes: Array<[RegExp, StubResponse | StubResponse[]]>) {
  const { impl, calls } = stubFetch(routes);
  return {
    connector: createGoogleBusinessProfileConnector({ ...CONFIG, fetchImpl: impl }),
    calls,
  };
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

const TOKEN_URL = /oauth2\.googleapis\.com\/token/;
const REVOKE_URL = /oauth2\.googleapis\.com\/revoke/;
const ACCOUNTS_URL = /mybusinessaccountmanagement\.googleapis\.com/;
const LOCATIONS_URL = /mybusinessbusinessinformation\.googleapis\.com/;

const TOKEN_BODY = {
  access_token: "new-access-token",
  refresh_token: "new-refresh-token",
  expires_in: 3599,
  scope: GOOGLE_BUSINESS_MANAGE_SCOPE,
  token_type: "Bearer",
};

/* -------------------------------------------------------------------------- */
/* Scopes                                                                      */
/* -------------------------------------------------------------------------- */

describe("scopes", () => {
  it("requests exactly one scope", () => {
    expect(hasRequiredScopes([GOOGLE_BUSINESS_MANAGE_SCOPE])).toBe(true);
    expect(missingScopes([])).toEqual([GOOGLE_BUSINESS_MANAGE_SCOPE]);
  });

  it("does not request the deprecated or identity scopes", async () => {
    const { connector } = connectorWith([]);
    const url = new URL(
      await connector.getAuthorizationUrl({ state: "s", forceConsent: false }),
    );
    const requested = url.searchParams.get("scope") ?? "";

    for (const omitted of GOOGLE_SCOPES_DELIBERATELY_OMITTED) {
      expect(requested).not.toContain(omitted);
    }
  });
});

/* -------------------------------------------------------------------------- */
/* Authorization URL                                                           */
/* -------------------------------------------------------------------------- */

describe("authorization url", () => {
  it("asks for offline access so a refresh token is issued", async () => {
    const { connector } = connectorWith([]);
    const url = new URL(
      await connector.getAuthorizationUrl({ state: "state-value", forceConsent: false }),
    );

    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("state")).toBe("state-value");
    expect(url.searchParams.get("scope")).toBe(GOOGLE_BUSINESS_MANAGE_SCOPE);
  });

  it("takes the redirect URI from configuration only", async () => {
    const { connector } = connectorWith([]);
    const url = new URL(
      await connector.getAuthorizationUrl({ state: "s", forceConsent: false }),
    );

    expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);
  });

  it("does not force consent on an ordinary connection", async () => {
    // Forcing it every time trains people to click through the screen that
    // tells them what they are granting.
    const { connector } = connectorWith([]);
    const url = new URL(
      await connector.getAuthorizationUrl({ state: "s", forceConsent: false }),
    );

    expect(url.searchParams.has("prompt")).toBe(false);
  });

  it("forces consent when a new refresh token is genuinely needed", async () => {
    const { connector } = connectorWith([]);
    const url = new URL(
      await connector.getAuthorizationUrl({ state: "s", forceConsent: true }),
    );

    expect(url.searchParams.get("prompt")).toBe("consent");
  });
});

/* -------------------------------------------------------------------------- */
/* Code exchange                                                               */
/* -------------------------------------------------------------------------- */

describe("code exchange", () => {
  it("returns normalised credentials", async () => {
    const { connector } = connectorWith([[TOKEN_URL, { body: TOKEN_BODY }]]);
    const credentials = await connector.exchangeAuthorizationCode({ code: "abc" });

    expect(credentials.accessToken).toBe("new-access-token");
    expect(credentials.refreshToken).toBe("new-refresh-token");
    expect(credentials.scopes).toEqual([GOOGLE_BUSINESS_MANAGE_SCOPE]);
    expect(Date.parse(credentials.expiresAt ?? "")).toBeGreaterThan(Date.now());
  });

  it("reports a null refresh token rather than inventing one", async () => {
    // Google withholds it on silent re-consent. The caller preserves the stored
    // one; the connector must not paper over the absence.
    const { connector } = connectorWith([
      [TOKEN_URL, { body: { ...TOKEN_BODY, refresh_token: undefined } }],
    ]);

    const credentials = await connector.exchangeAuthorizationCode({ code: "abc" });
    expect(credentials.refreshToken).toBeNull();
  });

  it("rejects a grant that is missing the required scope", async () => {
    // Storing it would produce a connection that looks healthy and fails on
    // every request.
    const { connector } = connectorWith([
      [TOKEN_URL, { body: { ...TOKEN_BODY, scope: "https://example.com/other" } }],
    ]);

    await expect(connector.exchangeAuthorizationCode({ code: "abc" })).rejects.toThrow(
      expect.objectContaining({ code: "insufficient_scope" }),
    );
  });

  it("never puts the client secret in a thrown error", async () => {
    const { connector } = connectorWith([
      [TOKEN_URL, { status: 400, body: { error: "invalid_client" } }],
    ]);

    const error = await connector
      .exchangeAuthorizationCode({ code: "abc" })
      .catch((thrown: unknown) => thrown);

    expect(String(error)).not.toContain(CONFIG.clientSecret);
  });
});

/* -------------------------------------------------------------------------- */
/* Refresh                                                                     */
/* -------------------------------------------------------------------------- */

describe("refresh", () => {
  it("carries the existing refresh token forward when Google omits it", async () => {
    // Google does not reissue it on an ordinary refresh. Overwriting it with
    // undefined would break the connection on the next renewal.
    const { connector } = connectorWith([
      [TOKEN_URL, { body: { ...TOKEN_BODY, refresh_token: undefined, scope: undefined } }],
    ]);

    const refreshed = await connector.refreshCredentials({
      accessToken: "old",
      refreshToken: "long-lived-refresh-token",
      expiresAt: null,
      scopes: [GOOGLE_BUSINESS_MANAGE_SCOPE],
      tokenType: "Bearer",
    });

    expect(refreshed.refreshToken).toBe("long-lived-refresh-token");
    // Likewise for scopes: an omitted list must not read as "withdrawn".
    expect(refreshed.scopes).toEqual([GOOGLE_BUSINESS_MANAGE_SCOPE]);
  });

  it("adopts a rotated refresh token when Google sends one", async () => {
    const { connector } = connectorWith([[TOKEN_URL, { body: TOKEN_BODY }]]);

    const refreshed = await connector.refreshCredentials({
      accessToken: "old",
      refreshToken: "old-refresh-token",
      expiresAt: null,
      scopes: [],
      tokenType: "Bearer",
    });

    expect(refreshed.refreshToken).toBe("new-refresh-token");
  });

  it("refuses to refresh without a refresh token", async () => {
    const { connector } = connectorWith([]);

    await expect(
      connector.refreshCredentials({
        accessToken: "old",
        refreshToken: null,
        expiresAt: null,
        scopes: [],
        tokenType: "Bearer",
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "authorization_revoked" }));
  });

  it("refreshes automatically before a request when the token has expired", async () => {
    const { connector } = connectorWith([
      [TOKEN_URL, { body: TOKEN_BODY }],
      [ACCOUNTS_URL, { body: { accounts: [] } }],
    ]);

    const active = session({ expiresAt: new Date(Date.now() - 1000).toISOString() });
    await connector.listExternalAccounts(active);

    // Persisted immediately, not after the request: a failed request must not
    // discard a perfectly good new token.
    expect(active.saved).toHaveLength(1);
    expect(active.saved[0]?.accessToken).toBe("new-access-token");
  });

  it("does not refresh a token that is still valid", async () => {
    const { connector } = connectorWith([[ACCOUNTS_URL, { body: { accounts: [] } }]]);

    const active = session();
    await connector.listExternalAccounts(active);

    expect(active.saved).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Error normalisation                                                         */
/* -------------------------------------------------------------------------- */

describe("provider error normalisation", () => {
  it.each([
    ["invalid_grant means the grant is gone", "invalid_grant", "authorization_revoked"],
    ["access_denied means the grant is gone", "access_denied", "authorization_revoked"],
    ["invalid_scope means missing permissions", "invalid_scope", "insufficient_scope"],
    ["invalid_client is our bug", "invalid_client", "invalid_request"],
  ])("%s", async (_name, providerError, expected) => {
    const { connector } = connectorWith([
      [TOKEN_URL, { status: 400, body: { error: providerError } }],
    ]);

    await expect(connector.exchangeAuthorizationCode({ code: "abc" })).rejects.toThrow(
      expect.objectContaining({ code: expected }),
    );
  });

  it("treats 401 as expired credentials", async () => {
    const { connector } = connectorWith([
      [ACCOUNTS_URL, { status: 401, body: { error: { status: "UNAUTHENTICATED" } } }],
    ]);

    await expect(connector.listExternalAccounts(session())).rejects.toThrow(
      expect.objectContaining({ code: "credentials_expired" }),
    );
  });

  it("separates a quota 403 from a permissions 403", async () => {
    // Google overloads 403. Only the body distinguishes them, and only one is
    // fixed by re-consenting.
    const quota = connectorWith([
      [ACCOUNTS_URL, { status: 403, body: { error: { status: "RESOURCE_EXHAUSTED" } } }],
    ]);
    await expect(quota.connector.listExternalAccounts(session())).rejects.toThrow(
      expect.objectContaining({ code: "quota_exceeded" }),
    );

    const denied = connectorWith([
      [ACCOUNTS_URL, { status: 403, body: { error: { status: "PERMISSION_DENIED" } } }],
    ]);
    await expect(denied.connector.listExternalAccounts(session())).rejects.toThrow(
      expect.objectContaining({ code: "insufficient_scope" }),
    );
  });

  it("treats 429 as a quota error and marks it retryable", async () => {
    const { connector } = connectorWith([[ACCOUNTS_URL, { status: 429, body: {} }]]);

    const error = (await connector
      .listExternalAccounts(session())
      .catch((thrown: unknown) => thrown)) as IntegrationError;

    expect(error.code).toBe("quota_exceeded");
    expect(error.retryable).toBe(true);
  });

  it("treats 5xx as a provider outage", async () => {
    const { connector } = connectorWith([[ACCOUNTS_URL, { status: 503, body: {} }]]);

    await expect(connector.listExternalAccounts(session())).rejects.toThrow(
      expect.objectContaining({ code: "provider_unavailable", retryable: true }),
    );
  });

  it("treats a network failure as a provider outage", async () => {
    const connector = createGoogleBusinessProfileConnector({
      ...CONFIG,
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });

    await expect(connector.listExternalAccounts(session())).rejects.toThrow(
      expect.objectContaining({ code: "provider_unavailable" }),
    );
  });

  it("rejects a response that does not match the schema", async () => {
    const { connector } = connectorWith([
      [ACCOUNTS_URL, { body: { accounts: [{ notAName: true }] } }],
    ]);

    await expect(connector.listExternalAccounts(session())).rejects.toThrow(
      expect.objectContaining({ code: "unexpected_response" }),
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Revocation                                                                  */
/* -------------------------------------------------------------------------- */

describe("revocation", () => {
  it("revokes the refresh token, which invalidates the whole grant", async () => {
    const { connector, calls } = connectorWith([[REVOKE_URL, { body: {} }]]);

    await connector.revokeCredentials({
      accessToken: "access",
      refreshToken: "refresh",
      expiresAt: null,
      scopes: [],
      tokenType: "Bearer",
    });

    const revoke = calls.find((call) => REVOKE_URL.test(call.url));
    expect(String(revoke?.init.body)).toContain("refresh");
  });

  it("treats an already-invalid token as revoked", async () => {
    // The credential is unusable by anyone, which is what revocation was for.
    const { connector } = connectorWith([
      [REVOKE_URL, { status: 400, body: { error: "invalid_token" } }],
    ]);

    await expect(
      connector.revokeCredentials({
        accessToken: "access",
        refreshToken: null,
        expiresAt: null,
        scopes: [],
        tokenType: "Bearer",
      }),
    ).resolves.toBeUndefined();
  });

  it("throws when Google does not confirm the revocation", async () => {
    // The disconnect flow reports "unconfirmed" from this. Resolving here would
    // let it claim a revocation that never happened.
    const { connector } = connectorWith([[REVOKE_URL, { status: 500, body: {} }]]);

    await expect(
      connector.revokeCredentials({
        accessToken: "access",
        refreshToken: "refresh",
        expiresAt: null,
        scopes: [],
        tokenType: "Bearer",
      }),
    ).rejects.toThrow(IntegrationError);
  });
});

/* -------------------------------------------------------------------------- */
/* Discovery and normalisation                                                 */
/* -------------------------------------------------------------------------- */

describe("account normalisation", () => {
  it("maps a Google account onto Lia's shape", () => {
    const account = normalizeAccount({
      name: "accounts/1122334455",
      accountName: "Union Square Hospitality Group",
      type: "LOCATION_GROUP",
      role: "PRIMARY_OWNER",
      verificationState: "VERIFIED",
      accountNumber: "44-1122",
      organizationInfo: { registeredDomain: "example.com" },
    });

    expect(account).toMatchObject({
      externalAccountId: "accounts/1122334455",
      name: "Union Square Hospitality Group",
      accountType: "LOCATION_GROUP",
      role: "PRIMARY_OWNER",
      verificationState: "VERIFIED",
    });
    expect(account.organizationInfo).toMatchObject({
      accountNumber: "44-1122",
      registeredDomain: "example.com",
    });
  });

  it("falls back to the resource name when Google omits the account name", () => {
    // Rendering a blank row would make the account unselectable.
    expect(normalizeAccount({ name: "accounts/9" }).name).toBe("accounts/9");
  });

  it("carries only reviewed fields into provider metadata", () => {
    const account = normalizeAccount({
      name: "accounts/1",
      accountName: "Group",
      // A field Google might add tomorrow must not become stored Lia data.
      ...({ someFutureField: "surprise" } as Record<string, unknown>),
    });

    expect(JSON.stringify(account)).not.toContain("surprise");
  });
});

describe("location normalisation", () => {
  const ACCOUNT = "accounts/1122334455";

  it("maps a full Google location", () => {
    const profile = normalizeLocation(
      {
        name: "locations/1001",
        title: "Maison Laurent SoHo",
        storeCode: "ML-SOHO",
        websiteUri: "https://example.com/soho",
        phoneNumbers: { primaryPhone: "+1 212-555-0118" },
        storefrontAddress: {
          addressLines: ["118 Prince Street", "Suite 2"],
          locality: "New York",
          administrativeArea: "NY",
          postalCode: "10012",
          regionCode: "US",
        },
        metadata: {
          placeId: "ChIJ123",
          mapsUri: "https://maps.google.com/?cid=1001",
          hasVoiceOfMerchant: true,
        },
      },
      ACCOUNT,
    );

    expect(profile).toMatchObject({
      externalProfileId: "locations/1001",
      externalAccountId: ACCOUNT,
      displayName: "Maison Laurent SoHo",
      storeCode: "ML-SOHO",
      phoneNumber: "+1 212-555-0118",
      verificationState: "VERIFIED",
      profileUrl: "https://maps.google.com/?cid=1001",
    });
    expect(profile.address).toMatchObject({
      addressLine1: "118 Prince Street",
      // A suite number matters for matching, so extra address lines are joined
      // rather than dropped.
      addressLine2: "Suite 2",
      city: "New York",
      region: "NY",
      postalCode: "10012",
      countryCode: "US",
    });
  });

  it("always produces a display name", () => {
    // A location with no title is still one the user has to decide about.
    expect(
      normalizeLocation({ name: "locations/9", storeCode: "SC-9" }, ACCOUNT).displayName,
    ).toBe("SC-9");
    expect(normalizeLocation({ name: "locations/9" }, ACCOUNT).displayName).toBe(
      "locations/9",
    );
  });

  it("omits fields Google did not send rather than inventing them", () => {
    const profile = normalizeLocation({ name: "locations/9" }, ACCOUNT);

    expect(profile.address).toBeUndefined();
    expect(profile.phoneNumber).toBeUndefined();
    expect(profile.verificationState).toBeUndefined();
  });

  it("reports an unverified listing as unverified", () => {
    const profile = normalizeLocation(
      { name: "locations/9", metadata: { hasVoiceOfMerchant: false } },
      ACCOUNT,
    );

    expect(profile.verificationState).toBe("UNVERIFIED");
  });
});

describe("pagination and deduplication", () => {
  it("follows page tokens until they run out", async () => {
    const { connector, calls } = connectorWith([
      [
        ACCOUNTS_URL,
        [
          { body: { accounts: [{ name: "accounts/1" }], nextPageToken: "p2" } },
          { body: { accounts: [{ name: "accounts/2" }], nextPageToken: "p3" } },
          { body: { accounts: [{ name: "accounts/3" }] } },
        ],
      ],
    ]);

    const accounts = await connector.listExternalAccounts(session());

    expect(accounts.map((account) => account.externalAccountId)).toEqual([
      "accounts/1",
      "accounts/2",
      "accounts/3",
    ]);
    expect(calls.filter((call) => ACCOUNTS_URL.test(call.url))).toHaveLength(3);
    expect(calls[1]?.url).toContain("pageToken=p2");
  });

  it("sends the required read mask on location requests", async () => {
    const { connector, calls } = connectorWith([
      [LOCATIONS_URL, { body: { locations: [] } }],
    ]);

    await connector.listExternalProfiles(session(), "accounts/1");

    const request = calls.find((call) => LOCATIONS_URL.test(call.url));
    // Google errors without it, so this is a contract not a nicety.
    expect(request?.url).toContain("readMask=");
    expect(request?.url).toContain("storefrontAddress");
  });

  it("drops locations Google returned twice", async () => {
    // Happens when an account belongs to a group that also grants access
    // directly. Two identical checkboxes is a bug the user cannot resolve.
    const { connector } = connectorWith([
      [
        LOCATIONS_URL,
        [
          {
            body: {
              locations: [{ name: "locations/1", title: "A" }],
              nextPageToken: "p2",
            },
          },
          { body: { locations: [{ name: "locations/1", title: "A" }] } },
        ],
      ],
    ]);

    const profiles = await connector.listExternalProfiles(session(), "accounts/1");
    expect(profiles).toHaveLength(1);
  });

  it("dedupes by external profile id, keeping the first", () => {
    const make = (id: string, name: string) => ({
      externalProfileId: id,
      externalAccountId: "accounts/1",
      displayName: name,
    });

    const unique = dedupeProfiles([
      make("locations/1", "first"),
      make("locations/1", "second"),
      make("locations/2", "other"),
    ]);

    expect(unique).toHaveLength(2);
    expect(unique[0]?.displayName).toBe("first");
  });
});

/* -------------------------------------------------------------------------- */
/* Health                                                                      */
/* -------------------------------------------------------------------------- */

describe("connection health", () => {
  const CONNECTION = {} as never;

  it("reports healthy when Google accepts an authenticated request", async () => {
    const { connector } = connectorWith([[ACCOUNTS_URL, { body: { accounts: [] } }]]);

    const health = await connector.testConnection(session(), CONNECTION);
    expect(health.status).toBe("healthy");
    expect(health.errorCode).toBeNull();
  });

  it("classifies a revoked grant as needing reauthorization", async () => {
    const { connector } = connectorWith([
      [TOKEN_URL, { status: 400, body: { error: "invalid_grant" } }],
    ]);

    const health = await connector.testConnection(
      session({ expiresAt: new Date(Date.now() - 1000).toISOString() }),
      CONNECTION,
    );

    expect(health.status).toBe("authorization_required");
  });

  it("classifies a rate limit as quota-limited, not as broken", async () => {
    const { connector } = connectorWith([[ACCOUNTS_URL, { status: 429, body: {} }]]);

    const health = await connector.testConnection(session(), CONNECTION);
    expect(health.status).toBe("quota_limited");
  });

  it("flags an expiring token only when it cannot renew itself", async () => {
    const { connector } = connectorWith([[ACCOUNTS_URL, { body: { accounts: [] } }]]);

    const soon = new Date(Date.now() + 60 * 60 * 1000).toISOString();

    // With a refresh token, an expiring access token is routine.
    const renewable = await connector.testConnection(
      session({ expiresAt: soon }),
      CONNECTION,
    );
    expect(renewable.status).toBe("healthy");

    const stranded = await connector.testConnection(
      session({ expiresAt: soon, refreshToken: null }),
      CONNECTION,
    );
    expect(stranded.status).toBe("token_expiring");
  });

  it("never surfaces Google's own error text", async () => {
    const { connector } = connectorWith([
      [
        ACCOUNTS_URL,
        {
          status: 403,
          body: {
            error: {
              status: "PERMISSION_DENIED",
              message:
                "Request had insufficient authentication scopes. https://internal.google/trace?id=secret",
            },
          },
        },
      ],
    ]);

    const health = await connector.testConnection(session(), CONNECTION);
    expect(health.message).not.toContain("internal.google");
    expect(health.message).not.toContain("trace");
  });
});
