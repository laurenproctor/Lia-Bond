/**
 * Normalised Yelp-provider failures.
 *
 * Chosen around what the operator must do next, not around what Yelp said. No
 * provider message, request URL, or API key ever travels in one of these — the
 * same discipline `NewsError` keeps, and for the same reason: a provider's own
 * error body quotes the request back, and the request carries the key.
 */
export type YelpErrorCode =
  /** The key is missing, wrong, or revoked. */
  | "unauthorized"
  /**
   * The plan does not cover this call.
   *
   * Distinct from `unauthorized`, and the distinction decides the operator's
   * next move: a rejected key is pasted again, a plan restriction is a
   * conversation with Yelp. Yelp answers both with a 403.
   */
  | "plan_restricted"
  /** Yelp's own request allowance is exhausted. Clears by itself. */
  | "rate_limited"
  /** Lia's own daily budget ceiling, reached before a request was made. */
  | "quota_exhausted"
  /**
   * The listing is gone: removed, merged into another, or never existed.
   *
   * Its own code because it is the one failure that is *about the listing*
   * rather than about the connection, and the runbook's remedy is different —
   * reconnect the location to the surviving listing, not fix a credential.
   */
  | "business_not_found"
  /** 5xx, or a response that could not be parsed. */
  | "provider_error"
  /** Yelp rejected the search parameters. */
  | "invalid_query"
  /** No mode selected, or no key in the environment. */
  | "not_configured";

export class YelpError extends Error {
  constructor(
    readonly code: YelpErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "YelpError";
  }
}

/**
 * Lia's own sentence for each failure.
 *
 * Declared once so a stored `platform_sync_runs.error_message`, an integration
 * screen, and a server action cannot word the same condition three ways.
 */
export const YELP_ERROR_MESSAGES: Record<YelpErrorCode, string> = {
  unauthorized:
    "Yelp rejected Lia's API key. An administrator needs to check the configuration.",
  plan_restricted:
    "Yelp's plan for this deployment does not cover that request. An administrator needs to check what the Yelp Places plan includes.",
  rate_limited:
    "Yelp's request limit was reached. Lia will try again on the next scheduled check.",
  quota_exhausted:
    "Lia's own daily Yelp request budget was reached before this check could run.",
  business_not_found:
    "Yelp no longer returns this listing. It may have been removed or merged into another listing.",
  provider_error:
    "Yelp is temporarily unavailable. Lia will try again on the next scheduled check.",
  invalid_query: "Yelp could not run that search. Check the location's name and address.",
  not_configured: "Yelp is not configured for this deployment.",
};
