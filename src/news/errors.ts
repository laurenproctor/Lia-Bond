/**
 * Normalised news-provider failures.
 *
 * Chosen around what the operator must do next, not around what the provider
 * said. No provider message, request URL, or key ever travels in one of these.
 */
export type NewsErrorCode =
  | "unauthorized"      // The key is missing, wrong, or revoked
  | "rate_limited"      // Daily request allowance exhausted at the provider
  | "quota_exhausted"   // Lia's own budget ceiling, before a request was made
  | "provider_error"    // 5xx, or a response that could not be parsed
  | "invalid_query"     // The provider rejected the search terms
  | "not_configured";   // No mode selected, or no key in the environment

export class NewsError extends Error {
  constructor(
    readonly code: NewsErrorCode,
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "NewsError";
  }
}
