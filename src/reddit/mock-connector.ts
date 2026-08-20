import { NO_CAPABILITIES, type ConnectorCapabilities } from "@/domain";
import type {
  AuthorizationCallbackInput,
  AuthorizationRequest,
  CredentialSession,
  PlatformCredentials,
} from "@/integrations/connector";
import type {
  PublishRedditComment,
  PublishedRedditComment,
  ReconciliationQuery,
  RedditCommunityRules,
  RedditConnector,
  RedditIdentity,
  RedditOwnComment,
  RedditSearchBatch,
  RedditSearchQuery,
  RedditThreadBatch,
} from "@/reddit/connector";
import { redditError } from "@/reddit/errors";
import { normaliseComment, normalisePost, normaliseForComparison } from "@/reddit/normalise";
import { REDDIT_REQUESTED_SCOPES } from "@/lib/reddit/capabilities";

/**
 * A deterministic Reddit connector that makes no network request.
 *
 * Its job is not to be a convenience. It is the only safe way to exercise a
 * write path against a live public forum, and it is what makes release gate R0
 * — the whole feature reviewable, end to end, with no Reddit agreement in
 * place — possible at all.
 *
 * Two things it does that a naive fixture would not:
 *
 *   * It goes through the real `normalisePost`/`normaliseComment`, from
 *     Reddit-shaped raw objects. A mock that returned already-normalised
 *     values would leave the normaliser — the data-minimisation boundary —
 *     untested by every test that uses it.
 *
 *   * It can fail on purpose, including the *uncertain* publish. A publish
 *     that appears to fail while actually having posted is the hardest state
 *     in this system to get right and the one nobody can reproduce against the
 *     real provider without leaving a comment in public. Here it is a flag.
 *
 * Deterministic throughout: no clock, no randomness. Every timestamp is
 * derived from `REFERENCE_NOW`, matching the demo data source's own fixed
 * instant so server and client renders agree.
 */

/** The fixed instant every mock timestamp is measured from. */
export const MOCK_REDDIT_NOW = new Date("2026-08-14T12:00:00.000Z");

function at(offsetMinutes: number): number {
  return (MOCK_REDDIT_NOW.getTime() - offsetMinutes * 60_000) / 1000;
}

/**
 * Raw, Reddit-shaped fixtures — including the fields Lia does *not* keep.
 *
 * The extra keys are load-bearing rather than decorative: they are what proves
 * the schema strips rather than passes through. A fixture containing only the
 * fields Lia stores could not fail that test.
 */
const RAW_POSTS: Record<string, unknown> = {
  t3_mock01: {
    id: "mock01",
    name: "t3_mock01",
    author: "u/foodie_nyc",
    author_fullname: "t2_foodie",
    subreddit: "FoodNYC",
    created_utc: at(240),
    title: "Maison Laurent — worth the hype?",
    selftext: "Trying to decide if it's worth the price. Heard mixed things about the pacing.",
    num_comments: 2,
    score: 284,
    permalink: "/r/FoodNYC/comments/mock01/worth_the_hype/",
    over_18: false,
    locked: false,
    archived: false,
    // None of these are stored. They are here so the strip is provable.
    author_flair_text: "Brooklyn",
    gildings: { gid_1: 3 },
    upvote_ratio: 0.91,
    all_awardings: [{ name: "Silver" }],
  },
  t3_mock02: {
    id: "mock02",
    name: "t3_mock02",
    author: "u/hudson_eats",
    author_fullname: "t2_hudson",
    subreddit: "FoodNYC",
    created_utc: at(660),
    title: "Server at the Tribeca location was rude",
    selftext: "The way front of house spoke to my friend was uncomfortable.",
    num_comments: 0,
    score: 96,
    permalink: "/r/FoodNYC/comments/mock02/server_rude/",
    locked: true,
  },
  // A post whose author deleted their account while the post remained.
  t3_mock03: {
    id: "mock03",
    name: "t3_mock03",
    author: "[deleted]",
    subreddit: "nyc",
    created_utc: at(1440),
    title: "Best anniversary dinner in years",
    selftext: "The team remembered a note I left in the booking.",
    num_comments: 0,
    score: 412,
    permalink: "/r/nyc/comments/mock03/anniversary/",
  },
  // A post removed at the source. Body is Reddit's sentinel, not content.
  t3_mock04: {
    id: "mock04",
    name: "t3_mock04",
    author: "u/gone",
    author_fullname: "t2_gone",
    subreddit: "FoodNYC",
    created_utc: at(2880),
    title: "Maison Laurent thread",
    selftext: "[removed]",
    removed_by_category: "moderator",
    score: 3,
    permalink: "/r/FoodNYC/comments/mock04/removed/",
  },
};

const RAW_COMMENTS: Record<string, unknown[]> = {
  t3_mock01: [
    {
      id: "mockc1",
      name: "t1_mockc1",
      author: "u/west4th",
      author_fullname: "t2_west4th",
      subreddit: "FoodNYC",
      created_utc: at(180),
      body: "Went two weeks ago. Pacing was fine, about two hours.",
      parent_id: "t3_mock01",
      link_id: "t3_mock01",
      depth: 0,
      score: 47,
      permalink: "/r/FoodNYC/comments/mock01/_/mockc1/",
      controversiality: 0,
    },
    {
      id: "mockc2",
      name: "t1_mockc2",
      author: "u/skeptic",
      author_fullname: "t2_skeptic",
      subreddit: "FoodNYC",
      created_utc: at(120),
      body: "Disagree, we waited 40 minutes between courses.",
      parent_id: "t1_mockc1",
      link_id: "t3_mock01",
      depth: 1,
      score: 12,
      permalink: "/r/FoodNYC/comments/mock01/_/mockc2/",
    },
    // A malformed child, so the malformed counter is exercised rather than
    // assumed to work. `created_utc` is missing entirely.
    { id: "broken", name: "t1_broken", subreddit: "FoodNYC", parent_id: "t3_mock01", link_id: "t3_mock01" },
  ],
  t3_mock02: [],
  t3_mock03: [],
  t3_mock04: [],
};

const MOCK_RULES: Record<string, readonly { name: string; description: string }[]> = {
  foodnyc: [
    { name: "No self-promotion", description: "Businesses may not promote themselves." },
    { name: "Be civil", description: "No personal attacks." },
  ],
  nyc: [{ name: "Stay on topic", description: "Posts must relate to New York City." }],
};

/**
 * Faults the mock can be told to inject.
 *
 * Named states rather than a generic "throw": each corresponds to a branch the
 * publication lifecycle has to handle differently, and being able to name them
 * in a test is what makes those branches reachable.
 */
export interface RedditMockFaults {
  /** Every call refuses, as an unapproved deployment would. */
  readonly notConfigured?: boolean;
  /** The grant is missing a scope. */
  readonly missingScope?: readonly string[];
  /** Publishing fails *after* Reddit may already have accepted it. */
  readonly uncertainPublish?: boolean;
  /** Publishing is definitively refused by the provider. */
  readonly publishRejected?: boolean;
  /** The reconciliation lookup finds two plausible matches. */
  readonly ambiguousReconciliation?: boolean;
  /** Search returns a capped listing. */
  readonly truncatedSearch?: boolean;
  readonly rateLimited?: boolean;
}

export class MockRedditConnector implements RedditConnector {
  readonly platform = "reddit" as const;

  /** Comments the mock has "published", so reconciliation has something to find. */
  private readonly published: {
    externalId: string;
    parentExternalId: string;
    body: string;
    createdAt: string;
  }[] = [];

  private counter = 0;

  constructor(private readonly faults: RedditMockFaults = {}) {}

  private guard(requiredScope?: string): void {
    if (this.faults.notConfigured) throw redditError("not_configured");
    if (this.faults.rateLimited) throw redditError("rate_limited", { retryAfterSeconds: 60 });
    if (requiredScope && this.faults.missingScope?.includes(requiredScope)) {
      throw redditError("insufficient_scope");
    }
  }

  capabilities(): ConnectorCapabilities {
    // The mock reports what a fully-granted live connector would, and nothing
    // more. It does not get to claim editing or webhooks that do not exist.
    return {
      ...NO_CAPABILITIES,
      canReadMentions: true,
      canReadFullText: true,
      canPublishResponses: true,
      requiresApproval: true,
      requiresPartnerAccess: true,
    };
  }

  async getAuthorizationUrl(input: AuthorizationRequest): Promise<string> {
    this.guard();
    const params = new URLSearchParams({
      client_id: "mock-client",
      response_type: "code",
      state: input.state,
      redirect_uri: "http://localhost:3000/api/integrations/reddit/callback",
      // Permanent, or Reddit issues no refresh token and every connection
      // dies after an hour. The mock carries it so the URL a test asserts on
      // is the shape the live client produces.
      duration: "permanent",
      scope: REDDIT_REQUESTED_SCOPES.join(" "),
    });
    return `https://www.reddit.com/api/v1/authorize?${params.toString()}`;
  }

  async exchangeAuthorizationCode(
    input: AuthorizationCallbackInput,
  ): Promise<PlatformCredentials> {
    this.guard();
    if (!input.code) throw redditError("invalid_query");
    return {
      accessToken: "mock-reddit-access-token",
      refreshToken: "mock-reddit-refresh-token",
      expiresAt: new Date(MOCK_REDDIT_NOW.getTime() + 3600_000).toISOString(),
      scopes: REDDIT_REQUESTED_SCOPES.filter(
        (scope) => !this.faults.missingScope?.includes(scope),
      ),
      tokenType: "bearer",
    };
  }

  async refreshCredentials(credentials: PlatformCredentials): Promise<PlatformCredentials> {
    this.guard();
    return {
      ...credentials,
      accessToken: "mock-reddit-access-token-refreshed",
      // Reddit, like Google, may omit a replacement. Keeping the existing one
      // is the behaviour the live client must also have.
      refreshToken: credentials.refreshToken,
      expiresAt: new Date(MOCK_REDDIT_NOW.getTime() + 3600_000).toISOString(),
    };
  }

  async revokeCredentials(): Promise<void> {
    this.guard();
  }

  async getIdentity(): Promise<RedditIdentity> {
    this.guard("identity");
    return {
      externalAccountId: "t2_mockaccount",
      username: "maison-laurent-team",
      grantedScopes: REDDIT_REQUESTED_SCOPES.filter(
        (scope) => !this.faults.missingScope?.includes(scope),
      ),
    };
  }

  async searchPosts(
    _session: CredentialSession,
    query: RedditSearchQuery,
  ): Promise<RedditSearchBatch> {
    this.guard("read");

    const wanted = new Set(query.subreddits.map((s) => s.toLowerCase()));
    const since = Date.parse(query.since);
    let malformed = 0;
    const posts = [];

    for (const raw of Object.values(RAW_POSTS)) {
      const normalised = normalisePost(raw);
      if (normalised === null) {
        malformed += 1;
        continue;
      }
      if (wanted.size > 0 && !wanted.has(normalised.community)) continue;
      if (Date.parse(normalised.publishedAt) < since) continue;
      if (!query.includeNsfw && normalised.metadata.isNsfw) continue;
      // Terms are matched here only so the mock behaves like a search; the
      // real admission decision belongs to the deterministic gate, which runs
      // over whatever a provider returns.
      const haystack = `${normalised.title} ${normalised.content}`.toLowerCase();
      if (!query.terms.some((term) => haystack.includes(term.toLowerCase()))) continue;
      posts.push(normalised);
    }

    return {
      posts: posts.slice(0, query.limit),
      malformed,
      truncated: this.faults.truncatedSearch === true || posts.length > query.limit,
      requestsSpent: 1,
    };
  }

  async getThread(
    _session: CredentialSession,
    rootFullname: string,
  ): Promise<RedditThreadBatch> {
    this.guard("read");

    const rawRoot = RAW_POSTS[rootFullname];
    if (rawRoot === undefined) {
      // Not an error: a thread that is gone is a removal for the caller to
      // record, and throwing would make an ordinary deletion look like a
      // provider failure.
      return { root: null, comments: [], malformed: 0, truncated: false, requestsSpent: 1 };
    }

    const root = normalisePost(rawRoot);
    let malformed = root === null ? 1 : 0;
    const comments = [];

    for (const raw of RAW_COMMENTS[rootFullname] ?? []) {
      const normalised = normaliseComment(raw);
      if (normalised === null) {
        malformed += 1;
        continue;
      }
      comments.push(normalised);
    }

    return { root, comments, malformed, truncated: false, requestsSpent: 2 };
  }

  async getRecentOwnComments(
    _session: CredentialSession,
    input: ReconciliationQuery,
  ): Promise<readonly RedditOwnComment[]> {
    this.guard("history");

    const since = Date.parse(input.since);
    const until = Date.parse(input.until);

    const matches = this.published
      .filter((comment) => comment.parentExternalId === input.parentExternalId)
      .filter((comment) => {
        const at = Date.parse(comment.createdAt);
        return at >= since && at <= until;
      })
      .map((comment) => ({
        externalId: comment.externalId,
        parentExternalId: comment.parentExternalId,
        body: comment.body,
        createdAt: comment.createdAt,
        authorExternalId: "t2_mockaccount",
      }));

    if (this.faults.ambiguousReconciliation && matches.length === 1) {
      // A second comment with the same text under the same parent. Lia cannot
      // tell which is its own, and must refuse to guess.
      const first = matches[0];
      if (first) {
        return [first, { ...first, externalId: `${first.externalId}_dup` }];
      }
    }

    return matches;
  }

  async publishComment(
    _session: CredentialSession,
    input: PublishRedditComment,
  ): Promise<PublishedRedditComment> {
    this.guard("submit");

    const parentRoot = RAW_POSTS[input.parentExternalId];
    if (parentRoot !== undefined) {
      const normalised = normalisePost(parentRoot);
      if (normalised?.metadata.isLocked || normalised?.metadata.isArchived) {
        throw redditError("target_unavailable");
      }
      if (normalised === null || normalised.isRemoved) {
        throw redditError("target_unavailable");
      }
    }

    if (this.faults.publishRejected) throw redditError("policy_blocked");

    this.counter += 1;
    const record = {
      externalId: `t1_mockpub${this.counter}`,
      parentExternalId: input.parentExternalId,
      body: input.text,
      createdAt: new Date(MOCK_REDDIT_NOW.getTime() + this.counter * 1000).toISOString(),
    };

    // The uncertain branch: Reddit accepted it, and then the call failed. The
    // comment exists, and the caller does not know. This is the state the
    // whole reconciliation lifecycle exists for, and it is unreproducible
    // against the real provider without leaving a comment in public.
    this.published.push(record);
    if (this.faults.uncertainPublish) throw redditError("provider_unavailable");

    return { externalId: record.externalId, createdAt: record.createdAt };
  }

  async deleteOwnComment(
    _session: CredentialSession,
    externalCommentId: string,
  ): Promise<void> {
    this.guard("edit");
    const index = this.published.findIndex(
      (comment) => comment.externalId === externalCommentId,
    );
    // Refusing an unknown id rather than succeeding silently: retraction must
    // prove Lia owns what it is about to delete.
    if (index === -1) throw redditError("target_unavailable");
    this.published.splice(index, 1);
  }

  async getCommunityRules(
    _session: CredentialSession,
    subreddit: string,
  ): Promise<RedditCommunityRules> {
    this.guard("read");
    const key = subreddit.toLowerCase();
    const rules = MOCK_RULES[key] ?? [];
    return {
      subreddit: key,
      rules,
      rulesHash: mockRulesHash(rules),
      rulesUrl: `https://www.reddit.com/r/${key}/about/rules`,
    };
  }

  /** Test affordance: what the mock believes it has posted. */
  publishedComments(): readonly { externalId: string; body: string }[] {
    return this.published.map(({ externalId, body }) => ({ externalId, body }));
  }
}

/**
 * A stable, content-derived hash.
 *
 * Deliberately not a cryptographic one — this identifies *change*, not
 * authenticity, and the real client uses the same shape so a posture recorded
 * in mock mode and one recorded live are comparable. Normalised through the
 * same comparison function the reconciler uses, so a whitespace-only edit to a
 * subreddit's rules does not send an approved community back to review.
 */
export function mockRulesHash(
  rules: readonly { name: string; description: string }[],
): string {
  const canonical = rules
    .map((rule) => `${normaliseForComparison(rule.name)}|${normaliseForComparison(rule.description)}`)
    .sort()
    .join("\n");

  let hash = 0;
  for (let index = 0; index < canonical.length; index += 1) {
    hash = (hash * 31 + canonical.charCodeAt(index)) | 0;
  }
  return `mock-${(hash >>> 0).toString(16)}`;
}
