import "server-only";

import {
  IntegrationError,
  integrationError,
  type IntegrationErrorCode,
} from "@/integrations/errors";
import {
  googleAccountsResponseSchema,
  googleApiErrorSchema,
  googleLocationsResponseSchema,
  googleOAuthErrorSchema,
  googleReviewsResponseSchema,
  googleTokenResponseSchema,
  GOOGLE_LOCATION_READ_MASK,
  type GoogleAccount,
  type GoogleLocation,
  type GoogleReview,
  type GoogleTokenResponse,
} from "@/integrations/google-business-profile/schemas";

/** One location's complete review history, as Google returned it. */
export interface GoogleReviewPage {
  reviews: GoogleReview[];
  /** Google's own total, when it supplied one. Never inferred from the array. */
  totalReviewCount: number | null;
  pages: number;
}

/**
 * The Google HTTP boundary.
 *
 * Every request Lia makes to Google is issued from this file, and nothing here
 * knows about Lia's domain, its database, or its screens. That split is what
 * makes the connector testable by stubbing one function (`fetch`) instead of
 * intercepting calls scattered through route handlers.
 *
 * Two rules hold throughout:
 *
 * 1. **No token is ever logged.** Not in an error message, not in a debug line,
 *    not in a thrown `cause`. The bodies of token requests are constructed and
 *    discarded here.
 * 2. **No Google error text reaches a user.** Provider messages quote request
 *    URLs and occasionally echo parameters. They are classified into an
 *    `IntegrationError` code; the wording a person sees comes from Lia.
 */

const OAUTH_AUTHORIZE_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";
const OAUTH_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

const ACCOUNT_MANAGEMENT_BASE = "https://mybusinessaccountmanagement.googleapis.com/v1";
const BUSINESS_INFORMATION_BASE =
  "https://mybusinessbusinessinformation.googleapis.com/v1";
/**
 * Reviews still live on the legacy v4 API.
 *
 * Not an oversight: Google split accounts and locations out into the v1
 * families above and never moved reviews, so v4 is where the data is. Same
 * OAuth scope, different host.
 */
const MY_BUSINESS_V4_BASE = "https://mybusiness.googleapis.com/v4";

/** Google caps these. Asking for more is an error, not a larger page. */
const ACCOUNTS_PAGE_SIZE = 20;
const LOCATIONS_PAGE_SIZE = 100;
/** Google's documented maximum for the reviews endpoint. */
const REVIEWS_PAGE_SIZE = 50;

/** Refuses to loop forever if a provider keeps handing back a page token. */
const MAX_PAGES = 50;

/**
 * How far a review backfill will page.
 *
 * Higher than `MAX_PAGES` because this is the one call that legitimately runs
 * long: a flagship restaurant with 20,000 reviews is 400 pages at Google's
 * 50-per-page cap, and stopping at 50 would silently import an eighth of its
 * history while reporting success.
 */
const MAX_REVIEW_PAGES = 500;

const REQUEST_TIMEOUT_MS = 15_000;

/**
 * Retry policy for transient provider failures.
 *
 * Bounded on purpose. A rate limit and a 503 are worth waiting out; a 401 and a
 * 403 are not, and retrying them turns one clear "reauthorize" into four
 * identical failures and a slower error message. Only the codes Google marks
 * retryable are retried, and only a few times.
 */
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 500;
/** A provider Retry-After longer than this is honoured as a failure, not a wait. */
const MAX_RETRY_DELAY_MS = 20_000;

const RETRYABLE_ERROR_CODES: readonly IntegrationErrorCode[] = [
  "quota_exceeded",
  "provider_unavailable",
];

/** Injectable so retry tests do not spend their delay in real time. */
export type SleepFn = (milliseconds: number) => Promise<void>;

const defaultSleep: SleepFn = (milliseconds) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

export interface GoogleClientConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  /** Injectable so tests can drive the connector without a network. */
  fetchImpl?: typeof fetch;
  /** Injectable so retry tests do not wait out the real backoff. */
  sleepImpl?: SleepFn;
}

export interface AuthorizationUrlOptions {
  state: string;
  scopes: readonly string[];
  forceConsent: boolean;
  loginHint?: string;
}

/* -------------------------------------------------------------------------- */
/* Error classification                                                        */
/* -------------------------------------------------------------------------- */

/**
 * OAuth token-endpoint failures.
 *
 * `invalid_grant` is the one that matters: it is what Google returns when a
 * refresh token has been revoked in the user's Google account, when it has been
 * superseded, or when the authorization code was already redeemed. All three
 * mean the same thing to a user — this connection needs re-consenting — so they
 * collapse to one code rather than three indistinguishable failures.
 */
function classifyOAuthError(reason: string, status: number): IntegrationErrorCode {
  switch (reason) {
    case "invalid_grant":
      return "authorization_revoked";
    case "invalid_scope":
      return "insufficient_scope";
    case "access_denied":
      return "authorization_revoked";
    case "invalid_client":
    case "invalid_request":
    case "unauthorized_client":
    case "unsupported_grant_type":
      return "invalid_request";
    default:
      return status >= 500 ? "provider_unavailable" : "unknown";
  }
}

/**
 * REST API failures, classified by status.
 *
 * 403 is genuinely ambiguous at Google: it covers both "your token does not
 * carry this scope" and "you have exhausted your quota". The `status` string in
 * the body is what separates them, so it is inspected rather than guessed at.
 */
function classifyApiError(
  status: number,
  googleStatus: string | undefined,
): IntegrationErrorCode {
  if (status === 401) return "credentials_expired";
  if (status === 403) {
    if (googleStatus === "RESOURCE_EXHAUSTED") return "quota_exceeded";
    if (googleStatus === "PERMISSION_DENIED") return "insufficient_scope";
    return "insufficient_scope";
  }
  if (status === 404) return "resource_unavailable";
  if (status === 429) return "quota_exceeded";
  if (status >= 500) return "provider_unavailable";
  if (status >= 400) return "invalid_request";
  return "unknown";
}

/* -------------------------------------------------------------------------- */
/* Client                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * How long to wait before retrying.
 *
 * `Retry-After` wins when Google sends one, because Google knows when its quota
 * window resets and exponential guessing does not. Both forms of the header are
 * accepted — a delay in seconds and an HTTP date — because Google uses both.
 * Anything unparseable, negative, or absurdly long falls back to backoff rather
 * than being trusted: an hour-long sleep inside a request is a hung request.
 */
export function retryDelayMs(
  attempt: number,
  retryAfterHeader: string | null,
  now: number = Date.now(),
): number {
  const backoff = Math.min(
    RETRY_BASE_DELAY_MS * 2 ** attempt,
    MAX_RETRY_DELAY_MS,
  );

  if (!retryAfterHeader) return backoff;

  const seconds = Number(retryAfterHeader.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    const requested = seconds * 1000;
    return requested <= MAX_RETRY_DELAY_MS ? requested : backoff;
  }

  const date = Date.parse(retryAfterHeader);
  if (Number.isFinite(date)) {
    const requested = date - now;
    if (requested <= 0) return 0;
    return requested <= MAX_RETRY_DELAY_MS ? requested : backoff;
  }

  return backoff;
}

export function createGoogleClient(config: GoogleClientConfig) {
  const doFetch = config.fetchImpl ?? fetch;
  const sleep = config.sleepImpl ?? defaultSleep;

  /** One place for timeouts and network failures, so no call site forgets. */
  async function request(url: string, init: RequestInit): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      return await doFetch(url, { ...init, signal: controller.signal });
    } catch (cause) {
      // A DNS failure, a reset connection, and our own timeout are the same
      // thing to a user: Google did not answer, try again.
      throw integrationError("provider_unavailable", { cause });
    } finally {
      clearTimeout(timer);
    }
  }

  async function readJson(response: Response): Promise<unknown> {
    try {
      return await response.json();
    } catch {
      return null;
    }
  }

  /* ---------------------------------------------------------------------- */
  /* OAuth                                                                   */
  /* ---------------------------------------------------------------------- */

  function buildAuthorizationUrl(options: AuthorizationUrlOptions): string {
    const url = new URL(OAUTH_AUTHORIZE_URL);
    url.searchParams.set("client_id", config.clientId);
    // From configuration, never from a request parameter. Google also rejects
    // any value not registered on the OAuth client, so this is checked twice.
    url.searchParams.set("redirect_uri", config.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("scope", options.scopes.join(" "));
    url.searchParams.set("state", options.state);
    // Offline access is what yields a refresh token; without it Lia would need
    // the user present every hour to read their own locations.
    url.searchParams.set("access_type", "offline");
    // Google returns granted scopes in the token response, and this makes it
    // report them per-request rather than for the whole grant.
    url.searchParams.set("include_granted_scopes", "true");

    // Only forced when a new refresh token is actually needed. Google issues a
    // refresh token on first consent and withholds it on silent re-approval, so
    // forcing consent every time would train users to click through it.
    if (options.forceConsent) url.searchParams.set("prompt", "consent");
    if (options.loginHint) url.searchParams.set("login_hint", options.loginHint);

    return url.toString();
  }

  /** Shared by the code exchange and the refresh: same endpoint, same failures. */
  async function postToken(body: URLSearchParams): Promise<GoogleTokenResponse> {
    const response = await request(OAUTH_TOKEN_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    const payload = await readJson(response);

    if (!response.ok) {
      const parsed = googleOAuthErrorSchema.safeParse(payload);
      const reason = parsed.success ? parsed.data.error : "unknown";
      throw integrationError(classifyOAuthError(reason, response.status), {
        providerStatus: response.status,
        providerReason: reason,
      });
    }

    const parsed = googleTokenResponseSchema.safeParse(payload);
    if (!parsed.success) {
      throw integrationError("unexpected_response", {
        providerStatus: response.status,
      });
    }

    return parsed.data;
  }

  async function exchangeCode(code: string): Promise<GoogleTokenResponse> {
    return postToken(
      new URLSearchParams({
        code,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        redirect_uri: config.redirectUri,
        grant_type: "authorization_code",
      }),
    );
  }

  async function refreshAccessToken(
    refreshToken: string,
  ): Promise<GoogleTokenResponse> {
    return postToken(
      new URLSearchParams({
        refresh_token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
        grant_type: "refresh_token",
      }),
    );
  }

  /**
   * Ask Google to invalidate a token.
   *
   * Throws unless Google confirmed. The disconnect flow reports revocation as
   * uncertain when this fails, which is the honest outcome — claiming a remote
   * revocation that did not happen would leave a live credential behind a UI
   * that says otherwise.
   */
  async function revokeToken(token: string): Promise<void> {
    const response = await request(OAUTH_REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }).toString(),
    });

    if (response.ok) return;

    const payload = await readJson(response);
    const parsed = googleOAuthErrorSchema.safeParse(payload);
    const reason = parsed.success ? parsed.data.error : "unknown";

    // Already-invalid tokens report `invalid_token`. The credential is not
    // usable by anyone, which is what revocation was for, so this is success.
    if (reason === "invalid_token") return;

    throw integrationError(classifyOAuthError(reason, response.status), {
      providerStatus: response.status,
      providerReason: reason,
    });
  }

  /* ---------------------------------------------------------------------- */
  /* REST                                                                    */
  /* ---------------------------------------------------------------------- */

  async function authorizedGet(url: string, accessToken: string): Promise<unknown> {
    const response = await request(url, {
      method: "GET",
      headers: {
        authorization: `Bearer ${accessToken}`,
        accept: "application/json",
      },
    });

    const payload = await readJson(response);

    if (!response.ok) {
      const parsed = googleApiErrorSchema.safeParse(payload);
      const googleStatus = parsed.success ? parsed.data.error.status : undefined;
      throw integrationError(classifyApiError(response.status, googleStatus), {
        providerStatus: response.status,
        providerReason: googleStatus ?? null,
      });
    }

    return payload;
  }

  /**
   * `authorizedGet`, with bounded retries for transient failures.
   *
   * Kept separate from `authorizedGet` rather than replacing it. Discovery runs
   * inside a page render where a person is waiting, and three retries with
   * backoff would turn a rate limit into a page that hangs for seven seconds
   * before failing anyway. A review sync is a background-shaped operation where
   * waiting out a 429 is exactly the right behaviour, so only it opts in.
   *
   * Only `quota_exceeded` and `provider_unavailable` are retried. A 401 or a
   * 403 is not going to become a 200 in two seconds, and retrying it delays the
   * one message that would tell the user to reauthorize.
   */
  async function authorizedGetRetrying(
    url: string,
    accessToken: string,
  ): Promise<unknown> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt += 1) {
      let retryAfter: string | null = null;

      try {
        const response = await request(url, {
          method: "GET",
          headers: {
            authorization: `Bearer ${accessToken}`,
            accept: "application/json",
          },
        });

        const payload = await readJson(response);
        if (response.ok) return payload;

        retryAfter = response.headers.get("retry-after");

        const parsed = googleApiErrorSchema.safeParse(payload);
        const googleStatus = parsed.success ? parsed.data.error.status : undefined;
        throw integrationError(classifyApiError(response.status, googleStatus), {
          providerStatus: response.status,
          providerReason: googleStatus ?? null,
        });
      } catch (error) {
        lastError = error;

        const retryable =
          error instanceof IntegrationError &&
          RETRYABLE_ERROR_CODES.includes(error.code);

        if (!retryable || attempt === MAX_RETRIES) throw error;

        await sleep(retryDelayMs(attempt, retryAfter));
      }
    }

    // Unreachable: the loop either returns or throws. Present so the function
    // is total rather than relying on the compiler's read of the loop bounds.
    throw lastError ?? integrationError("unknown");
  }

  /**
   * Every review for one location, oldest page token followed to the end.
   *
   * `parent` is a fully qualified `accounts/{a}/locations/{l}` — Google nests
   * reviews under the account that owns the location, and the same location
   * reached through a different account is a different parent.
   *
   * Ordered by `updateTime desc` so an incremental sync sees edited reviews
   * first, and paged all the way through so an initial backfill imports the
   * whole history rather than the most recent fifty. Reaching the page cap
   * throws rather than returning a truncated history: a sync that quietly
   * imported the first 25,000 reviews and reported success would be worse than
   * one that said it could not finish.
   */
  async function listReviews(
    accessToken: string,
    parent: string,
  ): Promise<GoogleReviewPage> {
    const collected: GoogleReview[] = [];
    let pageToken: string | undefined;
    let totalReviewCount: number | null = null;
    let pages = 0;

    for (let page = 0; page < MAX_REVIEW_PAGES; page += 1) {
      const url = new URL(`${MY_BUSINESS_V4_BASE}/${parent}/reviews`);
      url.searchParams.set("pageSize", String(REVIEWS_PAGE_SIZE));
      url.searchParams.set("orderBy", "updateTime desc");
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const payload = await authorizedGetRetrying(url.toString(), accessToken);
      const parsed = googleReviewsResponseSchema.safeParse(payload);
      if (!parsed.success) throw integrationError("unexpected_response");

      pages += 1;
      // Absent for a location with no reviews. An empty result, not a failure.
      collected.push(...(parsed.data.reviews ?? []));

      // Taken from the first page that offers it: Google omits it on later
      // pages, and overwriting with undefined would discard what it did say.
      if (totalReviewCount === null && parsed.data.totalReviewCount !== undefined) {
        totalReviewCount = parsed.data.totalReviewCount;
      }

      pageToken = parsed.data.nextPageToken;
      if (!pageToken) return { reviews: collected, totalReviewCount, pages };
    }

    throw integrationError("unexpected_response", {
      message:
        "This location has more reviews than Lia can import in one run. Let your administrator know.",
    });
  }

  /**
   * Every Business Profile account the credential may administer.
   *
   * Paginated because a hospitality group with an agency relationship can hold
   * several: their own account, a location group, and one shared by a marketing
   * partner. Taking only the first page would silently hide locations.
   */
  async function listAccounts(accessToken: string): Promise<GoogleAccount[]> {
    const collected: GoogleAccount[] = [];
    let pageToken: string | undefined;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL(`${ACCOUNT_MANAGEMENT_BASE}/accounts`);
      url.searchParams.set("pageSize", String(ACCOUNTS_PAGE_SIZE));
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const payload = await authorizedGet(url.toString(), accessToken);
      const parsed = googleAccountsResponseSchema.safeParse(payload);
      if (!parsed.success) throw integrationError("unexpected_response");

      collected.push(...(parsed.data.accounts ?? []));

      pageToken = parsed.data.nextPageToken;
      if (!pageToken) return collected;
    }

    // Hitting the cap means Google is paginating further than any real account
    // structure justifies. Returning what we have beats looping indefinitely.
    return collected;
  }

  async function listLocations(
    accessToken: string,
    externalAccountId: string,
  ): Promise<GoogleLocation[]> {
    const collected: GoogleLocation[] = [];
    let pageToken: string | undefined;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const url = new URL(
        `${BUSINESS_INFORMATION_BASE}/${externalAccountId}/locations`,
      );
      // Required by Google. Defines exactly which fields Lia receives.
      url.searchParams.set("readMask", GOOGLE_LOCATION_READ_MASK);
      url.searchParams.set("pageSize", String(LOCATIONS_PAGE_SIZE));
      if (pageToken) url.searchParams.set("pageToken", pageToken);

      const payload = await authorizedGet(url.toString(), accessToken);
      const parsed = googleLocationsResponseSchema.safeParse(payload);
      if (!parsed.success) throw integrationError("unexpected_response");

      collected.push(...(parsed.data.locations ?? []));

      pageToken = parsed.data.nextPageToken;
      if (!pageToken) return collected;
    }

    return collected;
  }

  return {
    buildAuthorizationUrl,
    exchangeCode,
    refreshAccessToken,
    revokeToken,
    listAccounts,
    listLocations,
    listReviews,
  };
}

export type GoogleClient = ReturnType<typeof createGoogleClient>;
