import type { ConnectorCapabilities, JsonObject } from "@/domain";

/**
 * The Yelp Places boundary.
 *
 * Deliberately *not* `PlatformConnector`, for the reason D78 gave `NewsMonitor`
 * and D-day gave `RedditConnector`: that interface is OAuth plus Google-shaped
 * account/profile/review discovery, and Yelp Assisted has none of it. There is
 * no authorization handshake (the key is Lia's), no account to enumerate, and
 * no review batch to fetch. A Yelp connector implementing `PlatformConnector`
 * would throw from six of its ten methods, which is how a boundary stops
 * meaning anything.
 *
 * Three methods, each mapping to one capability Lia genuinely has under the
 * Places API. Nothing is here because a symmetry suggested it.
 *
 * ## What is deliberately absent
 *
 * There is no `listReviews`. Yelp's Fusion `/businesses/{id}/reviews` endpoint
 * returns up to three **excerpts** — truncated text, no complete history, no
 * stable per-review identity across calls. Wiring it would put a method on this
 * interface whose name promises review retrieval and whose return value cannot
 * support it, and every screen above would then have to remember the caveat.
 * The honest position is that this integration cannot read reviews at all, and
 * the interface says so by having nowhere to ask.
 *
 * There is no `publishResponse`. Responding to reviews is a Yelp Partner API
 * capability Lia does not hold. See `docs/integrations/yelp-assisted.md` for
 * the upgrade path.
 */

/* -------------------------------------------------------------------------- */
/* Matching                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * A physical location, as Yelp's business-match endpoint wants it described.
 *
 * Built from a Lia location's own persisted address, never from a browser
 * field: the caller names a location id and the server reads the row. A search
 * whose address came from the request would let somebody enumerate Yelp
 * listings through Lia's key.
 */
export interface YelpBusinessMatchQuery {
  readonly name: string;
  readonly addressLine1: string;
  readonly addressLine2: string | null;
  readonly city: string;
  /** State or province code where the country has one. */
  readonly region: string;
  readonly postalCode: string;
  /** ISO 3166-1 alpha-2. */
  readonly countryCode: string;
  /** The strongest available signal, when the location has one recorded. */
  readonly phone: string | null;
  readonly limit: number;
}

/**
 * A free-text fallback, for the case the address match returns nothing.
 *
 * Yelp's match endpoint is strict by design — it answers "is this exact
 * business on Yelp" — and a restaurant listed under a slightly different street
 * form falls through it. Rather than leave the customer stuck, a term-and-city
 * search offers a wider candidate set, which the person then has to
 * disambiguate themselves. Both paths end at the same confirmation step.
 */
export interface YelpBusinessSearchQuery {
  readonly term: string;
  /** A human-readable locality string: Yelp resolves it itself. */
  readonly location: string;
  readonly limit: number;
}

/**
 * A Yelp business as the match and search endpoints return it.
 *
 * Nothing is optional-by-omission: a field Yelp may not supply is explicitly
 * nullable, so "Yelp did not tell us" is a value the caller has to handle
 * rather than a key it might forget to check.
 *
 * `reviewCount` and `rating` are **absent from this type on purpose**. Yelp's
 * match endpoint does not return them, and a nullable field here would invite a
 * connection flow to record a baseline it did not actually observe. Activity
 * detection reads them from `getBusiness`, which does return them, and which is
 * the only call that establishes a baseline.
 */
export interface YelpBusinessCandidate {
  /** Yelp's opaque business id. The mapping key, and the only stable one. */
  readonly businessId: string;
  /**
   * Yelp's human-readable slug.
   *
   * Recorded because it is what appears in a Yelp URL and therefore what a
   * customer recognises, but never used as the mapping key: an alias changes
   * when a business is renamed, and the id does not.
   */
  readonly alias: string | null;
  readonly name: string;
  /** Yelp's own canonical page. Validated against the host allowlist. */
  readonly profileUrl: string | null;
  readonly addressLines: readonly string[];
  readonly city: string | null;
  readonly region: string | null;
  readonly postalCode: string | null;
  readonly countryCode: string | null;
  readonly phone: string | null;
  /** Yelp reports the business as permanently closed. */
  readonly isClosed: boolean;
  /** Named, reviewed provider fields. Never a spread of the raw response. */
  readonly metadata: JsonObject;
}

export interface YelpMatchResult {
  readonly candidates: readonly YelpBusinessCandidate[];
  /** Requests consumed. Charged against the global daily budget. */
  readonly requestsSpent: number;
  /** Items Yelp sent that could not be normalised. Counted, never thrown. */
  readonly malformedCount: number;
}

/* -------------------------------------------------------------------------- */
/* Listing metadata                                                            */
/* -------------------------------------------------------------------------- */

/**
 * The whole of what Lia may observe about a connected listing.
 *
 * Two numbers and some display metadata. This type is the ceiling on what
 * "review activity detection" can ever know, and it is small enough to read in
 * one screen — which is the point. Anybody tempted to describe this feature as
 * review monitoring should be shown this type.
 */
export interface YelpListingMetadata {
  readonly businessId: string;
  readonly alias: string | null;
  readonly name: string;
  readonly profileUrl: string | null;
  /**
   * Yelp's count of reviews on the listing right now.
   *
   * Null when Yelp omits it. Null is honest and load-bearing: an observation
   * with no count cannot establish or move a baseline, and the check service
   * refuses to derive activity from one.
   */
  readonly reviewCount: number | null;
  /** Yelp's aggregate star rating, in halves. Null when Yelp omits it. */
  readonly rating: number | null;
  readonly isClosed: boolean;
  readonly metadata: JsonObject;
}

/* -------------------------------------------------------------------------- */
/* The provider                                                                */
/* -------------------------------------------------------------------------- */

export interface YelpPlacesProvider {
  readonly platform: "yelp";

  /** What this provider can honestly do today. Never a platform assumption. */
  capabilities(): ConnectorCapabilities;

  /** Find the Yelp listing for one physical location. Address-driven. */
  matchBusinesses(query: YelpBusinessMatchQuery): Promise<YelpMatchResult>;

  /** The wider free-text fallback, when an address match finds nothing. */
  searchBusinesses(query: YelpBusinessSearchQuery): Promise<YelpMatchResult>;

  /**
   * The current metadata for one listing.
   *
   * The only call that returns a review count, and therefore the only call that
   * can establish a baseline or detect a change. Throws `business_not_found`
   * when Yelp no longer returns the listing — a real state (removed, merged)
   * that the runbook has an answer for, not an error to swallow.
   */
  getBusiness(businessId: string): Promise<YelpListingMetadata>;
}
