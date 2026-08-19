import "server-only";

import { z } from "zod";
import type { ConnectorCapabilities, JsonObject } from "@/domain";
import { requireYelpApiKey } from "@/lib/env";
import { YelpError } from "@/yelp/errors";
import type {
  YelpBusinessCandidate,
  YelpBusinessMatchQuery,
  YelpBusinessSearchQuery,
  YelpListingMetadata,
  YelpMatchResult,
  YelpPlacesProvider,
} from "@/yelp/places";
import { YELP_ASSISTED_CAPABILITIES } from "@/yelp/capabilities";
import { canonicalYelpBusinessUrl, normalizeYelpUrl } from "@/yelp/urls";

/**
 * The Yelp Fusion HTTP boundary.
 *
 * Every request Lia makes to Yelp is issued from this file, and it is the only
 * file in the Yelp layer that touches the network or reads the API key. That
 * split is what makes the provider testable by stubbing one function (`fetch`)
 * rather than intercepting calls elsewhere.
 *
 * The key travels in an `Authorization` header built inside `headers()` and is
 * never placed in a URL, a log line, a thrown error, or a returned value. That
 * matters more here than it did for GNews, which takes its key as a query
 * parameter: a URL with a token in it ends up in error messages and request
 * logs by default, and a header does not.
 *
 * No provider error body is ever interpolated into a thrown error. Yelp's
 * 400 responses quote the request back, which for a match call means quoting a
 * customer's address.
 */

const YELP_API_ORIGIN = "https://api.yelp.com/v3";

/* -------------------------------------------------------------------------- */
/* Response shapes                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Only the fields this layer reads.
 *
 * Everything is optional except the id, because Yelp's responses vary by
 * endpoint — the match endpoint omits `rating` and `review_count` entirely, and
 * a schema demanding them would fail every match call. `normaliseBusiness`
 * turns absence into an explicit null rather than letting a key go missing.
 */
const yelpBusinessSchema = z.object({
  id: z.string().min(1),
  alias: z.string().optional(),
  name: z.string().optional(),
  url: z.string().optional(),
  phone: z.string().optional(),
  display_phone: z.string().optional(),
  is_closed: z.boolean().optional(),
  review_count: z.number().optional(),
  rating: z.number().optional(),
  price: z.string().optional(),
  location: z
    .object({
      address1: z.string().nullish(),
      address2: z.string().nullish(),
      address3: z.string().nullish(),
      city: z.string().nullish(),
      state: z.string().nullish(),
      zip_code: z.string().nullish(),
      country: z.string().nullish(),
      display_address: z.array(z.string()).optional(),
    })
    .optional(),
  categories: z
    .array(z.object({ alias: z.string().optional(), title: z.string().optional() }))
    .optional(),
});

const yelpListSchema = z.object({ businesses: z.array(z.unknown()).optional() });

type YelpBusinessPayload = z.infer<typeof yelpBusinessSchema>;

/* -------------------------------------------------------------------------- */
/* Errors                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Status → `YelpError`.
 *
 * 403 is split from 401 because the operator's next action differs: a rejected
 * key is re-pasted, a plan restriction is a conversation with Yelp. Yelp uses
 * 403 for both "this key is not valid for this endpoint" and "your plan does
 * not include this", and neither is fixed by trying again.
 */
function classifyError(status: number): YelpError {
  if (status === 401) {
    return new YelpError(
      "unauthorized",
      "Yelp rejected Lia's API key. An administrator needs to check the configuration.",
      false,
    );
  }
  if (status === 403) {
    return new YelpError(
      "plan_restricted",
      "Yelp refused this request for the configured plan. An administrator needs to check what the Yelp Places plan covers.",
      false,
    );
  }
  if (status === 404) {
    return new YelpError(
      "business_not_found",
      "Yelp no longer returns this listing. It may have been removed or merged into another listing.",
      false,
    );
  }
  if (status === 429) {
    return new YelpError(
      "rate_limited",
      "Yelp's request limit was reached. Lia will try again on the next scheduled check.",
      true,
    );
  }
  if (status === 400) {
    return new YelpError(
      "invalid_query",
      "Yelp could not run that search. Check the location's name and address.",
      false,
    );
  }
  if (status >= 500) {
    return new YelpError(
      "provider_error",
      "Yelp is temporarily unavailable. Lia will try again on the next scheduled check.",
      true,
    );
  }
  // An unmapped 4xx: a changed endpoint, a withdrawn parameter, a plan tier
  // newly enforced. Far more likely permanent than transient, and the check
  // service retries on `retryable` — defaulting this to `true` would retry
  // forever while reporting "temporarily unavailable", hiding a fixable
  // configuration problem. `gnews/client.ts` and `google-business-profile/
  // client.ts` both make the same call for their own unmapped cases.
  return new YelpError(
    "provider_error",
    "Yelp returned an unexpected error. An administrator needs to check the Yelp configuration.",
    false,
  );
}

/* -------------------------------------------------------------------------- */
/* Normalisation                                                               */
/* -------------------------------------------------------------------------- */

/** Named, reviewed fields only. Never a spread of Yelp's response (D28's rule). */
function businessMetadata(payload: YelpBusinessPayload): JsonObject {
  const categories = (payload.categories ?? [])
    .map((category) => category.title)
    .filter((title): title is string => typeof title === "string" && title.length > 0);

  return {
    ...(payload.display_phone ? { displayPhone: payload.display_phone } : {}),
    ...(payload.price ? { price: payload.price } : {}),
    ...(categories.length > 0 ? { categories } : {}),
  };
}

/**
 * Yelp's URL, or one built from the alias, or nothing.
 *
 * Yelp's own `url` is preferred because it points at the locale the listing
 * lives on, but it is validated rather than trusted — this is provider data
 * about to become a destination somebody clicks. A URL on a locale domain the
 * allowlist does not carry falls back to the `.com` page built from the alias,
 * which is a working link rather than a missing one.
 */
function resolveProfileUrl(payload: YelpBusinessPayload): string | null {
  if (payload.url) {
    const normalized = normalizeYelpUrl(payload.url);
    if (normalized) return normalized;
  }
  return payload.alias ? canonicalYelpBusinessUrl(payload.alias) : null;
}

function addressLines(payload: YelpBusinessPayload): string[] {
  const display = payload.location?.display_address;
  if (display && display.length > 0) {
    return display.filter((line) => line.trim().length > 0);
  }
  return [payload.location?.address1, payload.location?.address2, payload.location?.address3]
    .filter((line): line is string => typeof line === "string" && line.trim().length > 0);
}

function normaliseCandidate(raw: unknown): YelpBusinessCandidate | null {
  const parsed = yelpBusinessSchema.safeParse(raw);
  if (!parsed.success) return null;

  const payload = parsed.data;
  // A business with no name is unusable in a candidate list: the whole point of
  // the confirmation step is that a person can tell two listings apart.
  if (!payload.name) return null;

  return {
    businessId: payload.id,
    alias: payload.alias ?? null,
    name: payload.name,
    profileUrl: resolveProfileUrl(payload),
    addressLines: addressLines(payload),
    city: payload.location?.city ?? null,
    region: payload.location?.state ?? null,
    postalCode: payload.location?.zip_code ?? null,
    countryCode: payload.location?.country ?? null,
    phone: payload.phone ?? null,
    isClosed: payload.is_closed ?? false,
    metadata: businessMetadata(payload),
  };
}

/**
 * Yelp's rating, or null.
 *
 * Bounds-checked rather than trusted. Yelp publishes ratings in halves from 1
 * to 5, and a value outside that is a response Lia does not understand — which
 * must not become a stored baseline that a later comparison reads as a change.
 */
function normaliseRating(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  if (value < 0 || value > 5) return null;
  return value;
}

/** Yelp's review count, or null. Negative or fractional is not a count. */
function normaliseReviewCount(value: number | undefined): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) return null;
  return value;
}

/* -------------------------------------------------------------------------- */
/* The client                                                                  */
/* -------------------------------------------------------------------------- */

export class YelpFusionClient implements YelpPlacesProvider {
  readonly platform = "yelp" as const;

  /**
   * `fetch` is injected with a real default rather than required, unlike
   * `searchGNews`. There is one implementation here rather than a client and a
   * separate monitor, so there is no second place for the default to live.
   */
  constructor(private readonly fetchImpl: typeof fetch = fetch) {}

  capabilities(): ConnectorCapabilities {
    return YELP_ASSISTED_CAPABILITIES;
  }

  async matchBusinesses(query: YelpBusinessMatchQuery): Promise<YelpMatchResult> {
    const url = new URL(`${YELP_API_ORIGIN}/businesses/matches`);
    url.searchParams.set("name", query.name.slice(0, 64));
    url.searchParams.set("address1", query.addressLine1.slice(0, 64));
    if (query.addressLine2) {
      url.searchParams.set("address2", query.addressLine2.slice(0, 64));
    }
    url.searchParams.set("city", query.city.slice(0, 64));
    // Yelp requires `state` for the countries that have one and rejects an
    // empty value elsewhere, so it is set only when there is something to send.
    if (query.region.trim().length > 0) {
      url.searchParams.set("state", query.region.slice(0, 3));
    }
    url.searchParams.set("country", query.countryCode.slice(0, 2).toUpperCase());
    if (query.postalCode.trim().length > 0) {
      url.searchParams.set("postal_code", query.postalCode.slice(0, 12));
    }
    if (query.phone) url.searchParams.set("phone", query.phone.slice(0, 32));
    url.searchParams.set("limit", String(clampLimit(query.limit)));
    // Yelp's default threshold admits near-misses. `default` keeps them: this
    // flow ends at a human confirming one listing, so a wider candidate set is
    // better than a strict one that silently returns nothing and reads as "your
    // restaurant is not on Yelp".
    url.searchParams.set("match_threshold", "default");

    return this.fetchCandidates(url);
  }

  async searchBusinesses(query: YelpBusinessSearchQuery): Promise<YelpMatchResult> {
    const url = new URL(`${YELP_API_ORIGIN}/businesses/search`);
    url.searchParams.set("term", query.term.slice(0, 128));
    url.searchParams.set("location", query.location.slice(0, 128));
    url.searchParams.set("limit", String(clampLimit(query.limit)));

    return this.fetchCandidates(url);
  }

  async getBusiness(businessId: string): Promise<YelpListingMetadata> {
    // Path-segment encoded rather than interpolated. A business id arrives from
    // a stored mapping, but this is the one place a stored value becomes part
    // of a URL, and an id carrying a `/` would address a different endpoint.
    const url = new URL(
      `${YELP_API_ORIGIN}/businesses/${encodeURIComponent(businessId)}`,
    );

    const payload = await this.request(url);
    const parsed = yelpBusinessSchema.safeParse(payload);
    // `name` is bound here rather than read off `business` below, because
    // narrowing `parsed.data.name` does not survive assigning `parsed.data` to
    // another const — and a listing with no name would otherwise reach the
    // connection card as an empty string somebody has to identify.
    const name = parsed.success ? parsed.data.name : undefined;
    if (!parsed.success || !name) {
      throw new YelpError(
        "provider_error",
        "Yelp returned a listing Lia could not read.",
        true,
      );
    }

    const business = parsed.data;
    return {
      businessId: business.id,
      alias: business.alias ?? null,
      name,
      profileUrl: resolveProfileUrl(business),
      reviewCount: normaliseReviewCount(business.review_count),
      rating: normaliseRating(business.rating),
      isClosed: business.is_closed ?? false,
      metadata: businessMetadata(business),
    };
  }

  /* ------------------------------------------------------------------------ */

  private async fetchCandidates(url: URL): Promise<YelpMatchResult> {
    const payload = await this.request(url);
    const parsed = yelpListSchema.safeParse(payload);
    if (!parsed.success) {
      throw new YelpError(
        "provider_error",
        "Yelp returned a response Lia could not read.",
        true,
      );
    }

    const candidates: YelpBusinessCandidate[] = [];
    let malformedCount = 0;
    for (const raw of parsed.data.businesses ?? []) {
      const candidate = normaliseCandidate(raw);
      if (candidate) candidates.push(candidate);
      else malformedCount += 1;
    }

    return { candidates, requestsSpent: 1, malformedCount };
  }

  private async request(url: URL): Promise<unknown> {
    // Built *before* the try, deliberately. `headers()` calls
    // `requireYelpApiKey`, which throws a `ConfigurationError` when the key is
    // missing — and a configuration error caught by the transport handler below
    // would be reported to an operator as "Lia could not reach Yelp", sending
    // them to look at a network problem that does not exist. An unconfigured
    // deployment has to say so in its own words.
    const headers = this.headers();

    let response: Response;
    try {
      response = await this.fetchImpl(url.toString(), { headers });
    } catch {
      // A DNS failure or a reset connection is indistinguishable from Yelp
      // being down, from the caller's point of view.
      throw new YelpError(
        "provider_error",
        "Lia could not reach Yelp. It will try again on the next scheduled check.",
        true,
      );
    }

    if (!response.ok) throw classifyError(response.status);

    return response.json().catch(() => null);
  }

  /**
   * Built per request, never held on the instance.
   *
   * A header object on `this` would be one property away from being serialised
   * into a log line, a test snapshot, or an error's `cause` — and it holds the
   * key. `requireYelpApiKey` is called at request time rather than in the
   * constructor for the same reason `searchGNews` reads its key at call time:
   * `next build` prerenders with no secrets, and constructing the client must
   * not be what fails.
   */
  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${requireYelpApiKey()}`,
      Accept: "application/json",
    };
  }
}

/** Yelp caps `limit` at 50 and rejects 0. Clamped here rather than at callers. */
function clampLimit(limit: number): number {
  if (!Number.isFinite(limit)) return 10;
  return Math.min(50, Math.max(1, Math.trunc(limit)));
}
