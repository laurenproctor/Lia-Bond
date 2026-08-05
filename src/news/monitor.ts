import type { ConnectorCapabilities, JsonObject, Platform } from "@/domain";

/**
 * The news-monitoring boundary.
 *
 * Deliberately *not* `PlatformConnector`. Eight of that interface's ten methods
 * — authorization URL, code exchange, refresh, revoke, accounts, profiles —
 * have no meaning for a search API, and implementing them as throwers is the
 * `if (platform === "google")` that D9 exists to prevent, relocated inside the
 * interface. One method, following D35's precedent: there is one thing Lia asks
 * a news provider to do.
 */

/** A search in Lia's vocabulary. No provider parameter names appear here. */
export interface NewsSearchQuery {
  keywords: readonly string[];
  exclusions: readonly string[];
  /** ISO 3166-1 alpha-2, or null for everywhere the provider covers. */
  sourceCountry: string | null;
  /** BCP-47 tag, or null for every language. */
  language: string | null;
  /** The incremental cursor (D66). Null on a query's first ever poll. */
  publishedAfter: string | null;
  /** Hard ceiling on articles requested. The free tier caps this at 10. */
  maxResults: number;
}

/**
 * An article as the provider has it.
 *
 * Provider-neutral: Event Registry and NewsData normalise into this same shape,
 * which is the part that is expensive to retrofit. Nothing is
 * optional-by-omission — a field the provider may not supply is explicitly
 * nullable, so "not told" is a value the caller must handle.
 */
export interface ExternalArticle {
  /** The provider's identifier. The idempotency key. GNews uses the URL. */
  externalId: string;
  url: string;
  title: string;
  /**
   * Headline summary. Null when the provider gave none.
   *
   * The free tier supplies no article body, so this is the whole of the text
   * the analysis layer will see.
   */
  description: string | null;
  publisherName: string | null;
  publisherDomain: string | null;
  authorName: string | null;
  publishedAt: string;
  language: string | null;
  /** Named, reviewed provider fields. Never a spread of the raw response. */
  metadata: JsonObject;
}

export interface NewsSearchBatch {
  articles: ExternalArticle[];
  /** Requests consumed. Charged against the global daily budget (D67). */
  requestsSpent: number;
  /**
   * The provider capped the page and offers no paging on this tier.
   *
   * Recorded rather than ignored, so a truncated poll never reads as a quiet
   * news day.
   */
  truncated: boolean;
  /**
   * Items the provider sent that could not be normalised.
   *
   * Counted rather than thrown, so one unusable article does not cost a query
   * its other nine.
   */
  malformedCount: number;
}

export interface NewsMonitor {
  readonly platform: Platform;
  /** What this monitor can honestly do today. Drives the capability display. */
  capabilities(): ConnectorCapabilities;
  search(query: NewsSearchQuery): Promise<NewsSearchBatch>;
}
