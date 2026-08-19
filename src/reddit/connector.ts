import type { ConnectorCapabilities } from "@/domain";
import type {
  AuthorizationCallbackInput,
  AuthorizationRequest,
  CredentialSession,
  PlatformCredentials,
} from "@/integrations/connector";
import type {
  NormalisedRedditComment,
  NormalisedRedditPost,
} from "@/reddit/normalise";

/**
 * The Reddit provider boundary.
 *
 * A separate interface from `PlatformConnector`, and the separation is the
 * same judgement `NewsMonitor` already made rather than a new one. That
 * interface is OAuth plus Google-shaped account/profile/review discovery:
 * `listAccounts`, `listProfiles`, `fetchReviews`, `publishReviewReply`. Reddit
 * has the OAuth half and none of the rest — there are no accounts to
 * enumerate, no profiles to map onto locations, and no review batches. A
 * Reddit connector implementing `PlatformConnector` would throw from four of
 * its seven methods, which is how a boundary stops meaning anything.
 *
 * What it does have that Google does not is the thread shape: search returns
 * posts, comments are fetched per thread, and the connected account's own
 * history is readable — which is the only thing that makes an uncertain
 * publication recoverable.
 *
 * Every method here maps to one real Reddit capability. Nothing is present
 * because a symmetry suggested it.
 */

export interface RedditIdentity {
  /** Reddit's user fullname, `t2_…`. */
  readonly externalAccountId: string;
  readonly username: string;
  /** Scopes the grant actually returned, which may be fewer than requested. */
  readonly grantedScopes: readonly string[];
}

export interface RedditSearchQuery {
  /** Required terms. Combined into one provider query by the client. */
  readonly terms: readonly string[];
  /** Empty means every community, subject to the caller's own deny list. */
  readonly subreddits: readonly string[];
  /**
   * The overlap window's lower bound.
   *
   * A window rather than a cursor, and the difference is load-bearing: Reddit
   * listings are mutable, `new` re-orders underneath you, and a cursor
   * advanced past a page loses whatever moved. Re-reading an overlapping
   * window and relying on fullname uniqueness is what makes a poll complete
   * rather than merely incremental.
   */
  readonly since: string;
  readonly limit: number;
  readonly includeNsfw: boolean;
}

export interface RedditSearchBatch {
  readonly posts: readonly NormalisedRedditPost[];
  /** Items that failed to parse. Counted, never thrown — see `normalise.ts`. */
  readonly malformed: number;
  /**
   * Reddit capped the listing and there is more behind it.
   *
   * Reported rather than chased, because "we saw everything" and "we saw the
   * first hundred" are different facts and a monitoring product that conflates
   * them is lying by omission.
   */
  readonly truncated: boolean;
  readonly requestsSpent: number;
}

export interface RedditThreadBatch {
  /** Null when the root is gone at the source — a removal, not an error. */
  readonly root: NormalisedRedditPost | null;
  readonly comments: readonly NormalisedRedditComment[];
  readonly malformed: number;
  /** The comment budget ran out before the tree did. */
  readonly truncated: boolean;
  readonly requestsSpent: number;
}

export interface ReconciliationQuery {
  /** The account whose own comments are being read. */
  readonly username: string;
  /** The post or comment the reply was addressed to. */
  readonly parentExternalId: string;
  /** Bounded window around the attempt, so an old comment cannot match. */
  readonly since: string;
  readonly until: string;
}

export interface RedditOwnComment {
  readonly externalId: string;
  readonly parentExternalId: string;
  /** Compared against the approved text, then discarded. Never stored. */
  readonly body: string;
  readonly createdAt: string;
  readonly authorExternalId: string | null;
}

export interface PublishRedditComment {
  /** The fullname being replied to: a post (`t3_…`) or a comment (`t1_…`). */
  readonly parentExternalId: string;
  /**
   * Exactly the text a person approved.
   *
   * The connector performs no transformation on it — no trimming, no
   * disclosure suffix, no Markdown normalisation. Anything that changed the
   * words between approval and publication would mean the thing published is
   * not the thing approved, which is the one promise this whole lifecycle
   * exists to keep.
   */
  readonly text: string;
}

export interface PublishedRedditComment {
  readonly externalId: string;
  readonly createdAt: string;
}

export interface RedditCommunityRules {
  readonly subreddit: string;
  /** Rule names and text, for a person to read. Never fed to a model as an instruction. */
  readonly rules: readonly { readonly name: string; readonly description: string }[];
  /**
   * A stable hash of the rules.
   *
   * What makes an `allowed` posture revocable without anybody watching: when
   * this moves, the posture returns to review. A permission granted against
   * rules that no longer exist is a stale note.
   */
  readonly rulesHash: string;
  readonly rulesUrl: string;
}

export interface RedditConnector {
  readonly platform: "reddit";

  /** What this connector can honestly do today. Never a platform assumption. */
  capabilities(): ConnectorCapabilities;

  getAuthorizationUrl(input: AuthorizationRequest): Promise<string>;
  exchangeAuthorizationCode(
    input: AuthorizationCallbackInput,
  ): Promise<PlatformCredentials>;
  refreshCredentials(credentials: PlatformCredentials): Promise<PlatformCredentials>;
  revokeCredentials(credentials: PlatformCredentials): Promise<void>;

  getIdentity(session: CredentialSession): Promise<RedditIdentity>;

  /**
   * Search **posts**. Not comments.
   *
   * Reddit's search endpoint covers links; there is no global comment search
   * to call. This is the single most important limitation in the integration
   * and it lives in the type's name and this comment rather than only in
   * marketing copy, so nobody implements a caller that assumes otherwise.
   */
  searchPosts(
    session: CredentialSession,
    query: RedditSearchQuery,
  ): Promise<RedditSearchBatch>;

  /** Comments inside one already-matched thread, under a hard budget. */
  getThread(
    session: CredentialSession,
    rootFullname: string,
  ): Promise<RedditThreadBatch>;

  /** The connected account's own recent comments, for reconciliation only. */
  getRecentOwnComments(
    session: CredentialSession,
    input: ReconciliationQuery,
  ): Promise<readonly RedditOwnComment[]>;

  publishComment(
    session: CredentialSession,
    input: PublishRedditComment,
  ): Promise<PublishedRedditComment>;

  /** Retraction only. Lia never edits published text. */
  deleteOwnComment(
    session: CredentialSession,
    externalCommentId: string,
  ): Promise<void>;

  getCommunityRules(
    session: CredentialSession,
    subreddit: string,
  ): Promise<RedditCommunityRules>;
}
