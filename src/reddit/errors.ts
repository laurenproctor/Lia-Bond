/**
 * Reddit failures, normalised.
 *
 * Its own vocabulary rather than a reuse of `IntegrationErrorCode`, which is
 * shaped around Google's OAuth-and-quota failures. Three of Reddit's states
 * have no Google equivalent and are the ones that decide what Lia does next:
 *
 *   * `policy_blocked` — the community's rules, or Lia's record of them,
 *     refused this. Not a Reddit error at all in the HTTP sense, and not
 *     something reauthorizing or waiting fixes.
 *   * `target_unavailable` — the thread is locked, archived, or gone. A
 *     terminal refusal for a publish, and an ordinary removal for a poll.
 *   * `not_configured` — this deployment holds no approval to call Reddit,
 *     which is a conversation with Reddit rather than a setting.
 *
 * The same discipline applies as everywhere else: the provider's own message
 * never travels with the error. Reddit's error bodies can quote the content of
 * the request, and the request contains a customer's monitor terms or an
 * approved reply.
 */

export type RedditErrorCode =
  /** No approved access, no credentials, or the rollout stage forbids it. */
  | "not_configured"
  /** The grant is gone: revoked on the Reddit account, or expired out. */
  | "not_authorized"
  /** Authenticated, but the granted scopes do not cover this call. */
  | "insufficient_scope"
  /** Reddit throttled us, or the global budget is spent. Retryable. */
  | "rate_limited"
  /** 5xx, timeout, or a transport failure. Retryable. */
  | "provider_unavailable"
  /** Lia sent something Reddit rejected. A Lia bug, not a user problem. */
  | "invalid_query"
  /** Locked, archived, deleted, or otherwise no longer repliable. */
  | "target_unavailable"
  /** A community rule, or Lia's record of one, refused this. */
  | "policy_blocked"
  /** Reddit's response did not match the schema Lia validates against. */
  | "unexpected_output";

/**
 * Codes where retrying the identical request could plausibly succeed.
 *
 * Deliberately narrow. `target_unavailable` and `policy_blocked` are excluded
 * because retrying them spends budget to arrive at the same refusal, and
 * `not_configured` is excluded because no amount of waiting produces a
 * contract.
 */
const RETRYABLE_CODES: readonly RedditErrorCode[] = [
  "rate_limited",
  "provider_unavailable",
];

export class RedditError extends Error {
  readonly code: RedditErrorCode;
  readonly retryable: boolean;
  /** Seconds Reddit asked us to wait, when it said. Never a guess. */
  readonly retryAfterSeconds: number | null;

  constructor(
    code: RedditErrorCode,
    message?: string,
    options: { retryAfterSeconds?: number | null } = {},
  ) {
    super(message ?? REDDIT_ERROR_MESSAGES[code]);
    this.name = "RedditError";
    this.code = code;
    this.retryable = RETRYABLE_CODES.includes(code);
    this.retryAfterSeconds = options.retryAfterSeconds ?? null;
  }
}

export function redditError(
  code: RedditErrorCode,
  options: { retryAfterSeconds?: number | null } = {},
): RedditError {
  return new RedditError(code, undefined, options);
}

/**
 * What a person is shown. Lia's own sentences, every one.
 *
 * Each says what to do rather than what happened, because "Reddit returned
 * 403" is true and useless — the reader's question is whether this is theirs
 * to fix.
 */
export const REDDIT_ERROR_MESSAGES: Record<RedditErrorCode, string> = {
  not_configured:
    "Reddit is not available on this deployment yet. Reddit grants commercial access by agreement, so this is not a setting somebody can switch on here.",
  not_authorized:
    "Lia's access to this Reddit account has been withdrawn. Reconnect the account to restore monitoring.",
  insufficient_scope:
    "The connected Reddit account did not grant a permission Lia needs. Reauthorize and accept every requested permission.",
  rate_limited:
    "Reddit is limiting how often Lia can call it right now. Monitoring will catch up on its own.",
  provider_unavailable:
    "Reddit did not respond. This is usually temporary — Lia will try again on the next run.",
  invalid_query:
    "Lia sent Reddit a request it refused. This is a problem on Lia's side rather than with your monitor.",
  target_unavailable:
    "This Reddit thread can no longer be replied to. It may have been locked, archived, or deleted.",
  policy_blocked:
    "This community's rules have not been approved for replies. Somebody with permission needs to read them and record a decision before Lia can post here.",
  unexpected_output:
    "Reddit returned something Lia did not recognize. Nothing was changed.",
};

/**
 * Map an HTTP status onto a code, given the call's context.
 *
 * `403` is the ambiguous one and the reason this takes `hasScope`: Reddit
 * returns it both for a missing scope and for a revoked grant, and the two
 * have different remedies — reauthorize with more permissions, or reconnect
 * entirely. When the connector knows which scopes the grant returned, it can
 * tell them apart; when it does not, it says the more conservative of the two.
 */
export function redditErrorForStatus(
  status: number,
  context: { hasRequiredScope?: boolean } = {},
): RedditErrorCode {
  if (status === 401) return "not_authorized";
  if (status === 403) {
    return context.hasRequiredScope === false ? "insufficient_scope" : "not_authorized";
  }
  if (status === 404 || status === 410) return "target_unavailable";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 422) return "invalid_query";
  if (status >= 500) return "provider_unavailable";
  return "unexpected_output";
}
