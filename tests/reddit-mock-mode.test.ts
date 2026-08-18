import { describe, expect, it } from "vitest";
import type { CredentialSession } from "@/integrations/connector";
import { MockRedditConnector, MOCK_REDDIT_NOW } from "@/reddit/mock-connector";
import { normaliseForComparison } from "@/reddit/normalise";
import { RedditError } from "@/reddit/errors";

/**
 * The mock is not a convenience. It is the only safe way to exercise a write
 * path against a live public forum, and it is what makes release gate R0 —
 * the whole feature reviewable with no Reddit agreement in place — possible.
 *
 * The states that matter most are the ones nobody can reproduce against the
 * real provider without leaving a comment in public: the uncertain publish,
 * and the ambiguous reconciliation.
 */

const SESSION: CredentialSession = {
  credentials: {
    accessToken: "mock",
    refreshToken: "mock-refresh",
    expiresAt: null,
    scopes: ["identity", "read", "submit", "edit", "history"],
    tokenType: "bearer",
  },
  async onRefreshed() {},
};

const SINCE = new Date(MOCK_REDDIT_NOW.getTime() - 7 * 24 * 3600_000).toISOString();

function search(connector: MockRedditConnector) {
  return connector.searchPosts(SESSION, {
    terms: ["maison laurent", "hype", "rude", "anniversary"],
    subreddits: [],
    since: SINCE,
    limit: 25,
    includeNsfw: false,
  });
}

describe("mock authorization", () => {
  it("asks for permanent duration, or every connection dies in an hour", async () => {
    const url = await new MockRedditConnector().getAuthorizationUrl({
      state: "state-token",
      forceConsent: false,
    });
    expect(url).toContain("duration=permanent");
    expect(url).toContain("state=state-token");
  });

  it("reports only the scopes the grant actually returned", async () => {
    const connector = new MockRedditConnector({ missingScope: ["submit"] });
    const identity = await connector.getIdentity();
    expect(identity.grantedScopes).not.toContain("submit");
    expect(identity.grantedScopes).toContain("read");
  });

  it("keeps an existing refresh token when the provider omits one", async () => {
    // Reddit, like Google, may withhold a replacement on re-consent. Dropping
    // the one already held would silently expire the connection.
    const refreshed = await new MockRedditConnector().refreshCredentials(
      SESSION.credentials,
    );
    expect(refreshed.refreshToken).toBe("mock-refresh");
    expect(refreshed.accessToken).not.toBe(SESSION.credentials.accessToken);
  });
});

describe("mock search and threads", () => {
  it("returns normalised posts, never raw Reddit objects", async () => {
    const batch = await search(new MockRedditConnector());
    expect(batch.posts.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(batch.posts);
    // The mock's fixtures deliberately carry flair, gildings, and awards, so
    // this is a real assertion about the normaliser rather than about a
    // fixture that never had them.
    for (const leak of ["flair", "gildings", "awardings", "upvote_ratio"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("restricts to the named communities when asked", async () => {
    const batch = await new MockRedditConnector().searchPosts(SESSION, {
      terms: ["anniversary"],
      subreddits: ["nyc"],
      since: SINCE,
      limit: 25,
      includeNsfw: false,
    });
    expect(batch.posts.every((post) => post.community === "nyc")).toBe(true);
  });

  it("reports truncation rather than implying complete coverage", async () => {
    const batch = await search(new MockRedditConnector({ truncatedSearch: true }));
    expect(batch.truncated).toBe(true);
  });

  it("counts a malformed comment instead of losing the thread", async () => {
    // The fixture thread carries one deliberately broken child.
    const thread = await new MockRedditConnector().getThread(SESSION, "t3_mock01");
    expect(thread.comments).toHaveLength(2);
    expect(thread.malformed).toBe(1);
  });

  it("reports a vanished thread as a removal, not a provider failure", async () => {
    // Throwing here would make an ordinary deletion look like Reddit is down,
    // and the caller has to record a removal rather than retry.
    const thread = await new MockRedditConnector().getThread(SESSION, "t3_nothere");
    expect(thread.root).toBeNull();
    expect(thread.comments).toHaveLength(0);
  });

  it("carries locked, removed, and deleted-author states through", async () => {
    const locked = await new MockRedditConnector().getThread(SESSION, "t3_mock02");
    expect(locked.root?.metadata.isLocked).toBe(true);

    const removed = await new MockRedditConnector().getThread(SESSION, "t3_mock04");
    expect(removed.root?.isRemoved).toBe(true);
    expect(removed.root?.content).toBe("");

    const deletedAuthor = await new MockRedditConnector().getThread(SESSION, "t3_mock03");
    expect(deletedAuthor.root?.author.isDeleted).toBe(true);
    expect(deletedAuthor.root?.author.name).toBeNull();
  });
});

describe("mock publishing", () => {
  it("publishes exactly the approved text, unaltered", async () => {
    // No trimming, no disclosure suffix, no Markdown normalisation. Anything
    // that changed the words between approval and publication would mean the
    // thing published is not the thing approved.
    const connector = new MockRedditConnector();
    const text = "  Thank you for the feedback.  We'd love to make it right.  ";
    await connector.publishComment(SESSION, {
      parentExternalId: "t3_mock01",
      text,
    });
    expect(connector.publishedComments()[0]?.body).toBe(text);
  });

  it("refuses a locked thread", async () => {
    await expect(
      new MockRedditConnector().publishComment(SESSION, {
        parentExternalId: "t3_mock02",
        text: "Reply",
      }),
    ).rejects.toMatchObject({ code: "target_unavailable" });
  });

  it("refuses a removed thread", async () => {
    await expect(
      new MockRedditConnector().publishComment(SESSION, {
        parentExternalId: "t3_mock04",
        text: "Reply",
      }),
    ).rejects.toMatchObject({ code: "target_unavailable" });
  });

  it("refuses when the grant withheld submit", async () => {
    await expect(
      new MockRedditConnector({ missingScope: ["submit"] }).publishComment(SESSION, {
        parentExternalId: "t3_mock01",
        text: "Reply",
      }),
    ).rejects.toMatchObject({ code: "insufficient_scope" });
  });

  it("reports a definite policy refusal as terminal", async () => {
    const error = await new MockRedditConnector({ publishRejected: true })
      .publishComment(SESSION, { parentExternalId: "t3_mock01", text: "Reply" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(RedditError);
    expect((error as RedditError).code).toBe("policy_blocked");
    expect((error as RedditError).retryable).toBe(false);
  });
});

describe("mock uncertain publish and reconciliation", () => {
  it("leaves the comment posted when the call fails after Reddit accepted it", async () => {
    // The whole reason the publication lifecycle has a `reconciliation_required`
    // state. Unreproducible against the real provider without leaving a
    // comment in public, which is exactly why the mock has to do it.
    const connector = new MockRedditConnector({ uncertainPublish: true });
    const text = "Thank you for the feedback.";

    await expect(
      connector.publishComment(SESSION, { parentExternalId: "t3_mock01", text }),
    ).rejects.toMatchObject({ code: "provider_unavailable" });

    // The caller believes it failed. Reddit disagrees.
    expect(connector.publishedComments()).toHaveLength(1);
  });

  it("finds exactly one match, so an uncertain publish can be recovered", async () => {
    const connector = new MockRedditConnector({ uncertainPublish: true });
    const text = "Thank you for the feedback.";
    await connector
      .publishComment(SESSION, { parentExternalId: "t3_mock01", text })
      .catch(() => undefined);

    const own = await connector.getRecentOwnComments(SESSION, {
      username: "maison-laurent-team",
      parentExternalId: "t3_mock01",
      since: MOCK_REDDIT_NOW.toISOString(),
      until: new Date(MOCK_REDDIT_NOW.getTime() + 600_000).toISOString(),
    });

    const matching = own.filter(
      (comment) => normaliseForComparison(comment.body) === normaliseForComparison(text),
    );
    expect(matching).toHaveLength(1);
    expect(matching[0]?.externalId).toMatch(/^t1_/);
  });

  it("can produce two plausible matches, which must stay unresolved", async () => {
    // Lia cannot tell which comment is its own. The two available guesses are
    // "claim one and maybe mark the wrong comment as ours" and "assume none
    // and maybe post a duplicate". Neither is a decision code should make.
    const connector = new MockRedditConnector({
      uncertainPublish: true,
      ambiguousReconciliation: true,
    });
    await connector
      .publishComment(SESSION, { parentExternalId: "t3_mock01", text: "Thanks." })
      .catch(() => undefined);

    const own = await connector.getRecentOwnComments(SESSION, {
      username: "maison-laurent-team",
      parentExternalId: "t3_mock01",
      since: MOCK_REDDIT_NOW.toISOString(),
      until: new Date(MOCK_REDDIT_NOW.getTime() + 600_000).toISOString(),
    });
    expect(own.length).toBeGreaterThan(1);
  });

  it("finds nothing when the publish never reached Reddit, so a retry is safe", async () => {
    const connector = new MockRedditConnector();
    const own = await connector.getRecentOwnComments(SESSION, {
      username: "maison-laurent-team",
      parentExternalId: "t3_mock01",
      since: MOCK_REDDIT_NOW.toISOString(),
      until: new Date(MOCK_REDDIT_NOW.getTime() + 600_000).toISOString(),
    });
    expect(own).toHaveLength(0);
  });

  it("bounds the reconciliation window, so an old comment cannot match", async () => {
    const connector = new MockRedditConnector();
    await connector.publishComment(SESSION, {
      parentExternalId: "t3_mock01",
      text: "Thanks.",
    });

    const own = await connector.getRecentOwnComments(SESSION, {
      username: "maison-laurent-team",
      parentExternalId: "t3_mock01",
      since: new Date(MOCK_REDDIT_NOW.getTime() - 7200_000).toISOString(),
      until: new Date(MOCK_REDDIT_NOW.getTime() - 3600_000).toISOString(),
    });
    expect(own).toHaveLength(0);
  });
});

describe("mock retraction", () => {
  it("deletes a comment Lia published", async () => {
    const connector = new MockRedditConnector();
    const published = await connector.publishComment(SESSION, {
      parentExternalId: "t3_mock01",
      text: "Thanks.",
    });
    await connector.deleteOwnComment(SESSION, published.externalId);
    expect(connector.publishedComments()).toHaveLength(0);
  });

  it("refuses an id Lia does not own rather than succeeding silently", async () => {
    // Retraction must prove Lia owns what it is about to delete.
    await expect(
      new MockRedditConnector().deleteOwnComment(SESSION, "t1_somebody_else"),
    ).rejects.toMatchObject({ code: "target_unavailable" });
  });
});

describe("mock community rules", () => {
  it("returns rules with a hash that moves only when the rules do", async () => {
    const connector = new MockRedditConnector();
    const first = await connector.getCommunityRules(SESSION, "FoodNYC");
    const second = await connector.getCommunityRules(SESSION, "foodnyc");

    expect(first.subreddit).toBe("foodnyc");
    expect(first.rules.length).toBeGreaterThan(0);
    // Stable across calls and across casing: an approved community must not
    // return to review because somebody typed its name differently.
    expect(first.rulesHash).toBe(second.rulesHash);

    const other = await connector.getCommunityRules(SESSION, "nyc");
    expect(other.rulesHash).not.toBe(first.rulesHash);
  });
});

describe("mock faults", () => {
  it("refuses everything when the deployment is unapproved", async () => {
    const connector = new MockRedditConnector({ notConfigured: true });
    await expect(search(connector)).rejects.toMatchObject({ code: "not_configured" });
    await expect(connector.getIdentity()).rejects.toMatchObject({
      code: "not_configured",
    });
  });

  it("reports rate limiting as retryable, with the provider's own wait", async () => {
    const error = await search(new MockRedditConnector({ rateLimited: true })).catch(
      (caught: unknown) => caught,
    );
    expect((error as RedditError).code).toBe("rate_limited");
    expect((error as RedditError).retryable).toBe(true);
    expect((error as RedditError).retryAfterSeconds).toBe(60);
  });

  it("is deterministic — the same call twice gives the same answer", async () => {
    const first = await search(new MockRedditConnector());
    const second = await search(new MockRedditConnector());
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });
});
