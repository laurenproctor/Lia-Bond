import { describe, expect, it } from "vitest";
import {
  applySourceFields,
  canonicalizeSubreddit,
  DEFINITE_PUBLICATION_FAILURES,
  deriveLocationFromMatches,
  isDefiniteFailure,
  isPostureCurrent,
  isRedditCommentFullname,
  isRedditPostFullname,
  NEW_MENTION_DEFAULTS,
  permitsPublishing,
  PUBLICATION_FAILURE_CATEGORIES,
  publicationClaimResultSchema,
  redditMonitoringQuerySchema,
  redditSourceMetadataSchema,
  REDDIT_COMMUNITY_POSTURES,
  SOURCE_OWNED_MENTION_FIELDS,
  sourceFieldsChanged,
  subredditNameSchema,
  type IngestMentionInput,
  type Mention,
} from "@/domain";

describe("reddit fullnames", () => {
  it("keeps posts and comments in separate id spaces", () => {
    // The bare ids are drawn from the same space: post `abc123` and comment
    // `abc123` can both exist, so a store keyed on the bare id would collide
    // them silently.
    expect(isRedditPostFullname("t3_abc123")).toBe(true);
    expect(isRedditCommentFullname("t1_abc123")).toBe(true);
    expect(isRedditPostFullname("t1_abc123")).toBe(false);
    expect(isRedditCommentFullname("t3_abc123")).toBe(false);
  });

  it("refuses a bare id, an uppercase id, and a wrong prefix", () => {
    for (const value of ["abc123", "t3_ABC123", "t5_abc123", "t3_", ""]) {
      expect(isRedditPostFullname(value)).toBe(false);
    }
  });
});

describe("canonicalizeSubreddit", () => {
  it("reduces every form somebody actually pastes to one name", () => {
    for (const input of [
      "askculinary",
      "AskCulinary",
      "r/AskCulinary",
      "/r/askculinary",
      "  r/AskCulinary  ",
      "https://www.reddit.com/r/AskCulinary",
      "https://old.reddit.com/r/askculinary/",
    ]) {
      expect(canonicalizeSubreddit(input)).toBe("askculinary");
    }
  });

  it("refuses anything that is not exactly one community", () => {
    // A posture keyed on a multireddit or a wildcard would be a permission
    // granted against rules nobody read.
    for (const input of [
      "",
      "   ",
      "a+b",
      "food+cooking",
      "user/somebody",
      "r/",
      "ab",
      "*",
      "food*",
      "https://example.com/r/askculinary",
    ]) {
      expect(canonicalizeSubreddit(input)).toBeNull();
    }
  });

  it("produces a value its own schema accepts", () => {
    const canonical = canonicalizeSubreddit("r/AskCulinary");
    expect(subredditNameSchema.safeParse(canonical).success).toBe(true);
  });
});

describe("community posture", () => {
  it("permits publishing on exactly one value", () => {
    const permitted = REDDIT_COMMUNITY_POSTURES.filter(permitsPublishing);
    expect(permitted).toEqual(["allowed"]);
  });

  it("treats a stale allowed as not current", () => {
    // An `allowed` granted against rules that may since have changed is a
    // stale note, not a permission.
    const now = new Date("2026-08-14T12:00:00.000Z");
    const fresh = {
      posture: "allowed" as const,
      decidedAt: "2026-08-13T12:00:00.000Z",
    };
    const stale = {
      posture: "allowed" as const,
      decidedAt: "2026-01-01T12:00:00.000Z",
    };
    expect(isPostureCurrent(fresh, now)).toBe(true);
    expect(isPostureCurrent(stale, now)).toBe(false);
  });

  it("treats an allowed with no decision date as not current", () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    expect(isPostureCurrent({ posture: "allowed", decidedAt: null }, now)).toBe(
      false,
    );
  });

  it("never treats a non-allowed posture as current, however recent", () => {
    const now = new Date("2026-08-14T12:00:00.000Z");
    for (const posture of REDDIT_COMMUNITY_POSTURES) {
      if (posture === "allowed") continue;
      expect(
        isPostureCurrent({ posture, decidedAt: "2026-08-14T11:59:00.000Z" }, now),
      ).toBe(false);
    }
  });
});

describe("deriveLocationFromMatches", () => {
  it("attributes to the one location every located match agrees on", () => {
    expect(
      deriveLocationFromMatches([{ locationId: "loc-a" }, { locationId: "loc-a" }]),
    ).toBe("loc-a");
  });

  it("stays organization-wide when located matches disagree", () => {
    // The rule this replaces — last writer wins — would let a second monitor
    // silently move a thread out of the queue another team was working.
    expect(
      deriveLocationFromMatches([{ locationId: "loc-a" }, { locationId: "loc-b" }]),
    ).toBeNull();
  });

  it("stays organization-wide when nothing is located", () => {
    expect(deriveLocationFromMatches([{ locationId: null }])).toBeNull();
    expect(deriveLocationFromMatches([])).toBeNull();
  });

  it("lets an organization-wide match abstain rather than veto", () => {
    // The common case is one brand-wide monitor plus one location monitor. A
    // brand monitor matching a thread says nothing about which restaurant it
    // concerns, so treating it as a dissenting vote would resolve the common
    // case to nothing.
    expect(
      deriveLocationFromMatches([{ locationId: null }, { locationId: "loc-a" }]),
    ).toBe("loc-a");
  });
});

describe("reddit monitoring query", () => {
  const valid = {
    id: "11111111-1111-4111-8111-111111111111",
    organizationId: "22222222-2222-4222-8222-222222222222",
    locationId: null,
    name: "Brand watch",
    terms: ["maison laurent"],
    exclusions: [],
    allowedSubreddits: ["askculinary"],
    deniedSubreddits: [],
    includeNsfw: false,
    relevanceThreshold: 0.35,
    enabled: true,
    pollIntervalMinutes: 60,
    origin: "user",
    lastPolledAt: null,
    createdAt: "2026-08-14T12:00:00.000Z",
    updatedAt: "2026-08-14T12:00:00.000Z",
  };

  it("accepts a well-formed query", () => {
    expect(redditMonitoringQuerySchema.safeParse(valid).success).toBe(true);
  });

  it("refuses a monitor with no required term", () => {
    // A monitor with no terms matches everything, which is not a monitor.
    expect(
      redditMonitoringQuerySchema.safeParse({ ...valid, terms: [] }).success,
    ).toBe(false);
  });

  it("refuses a subreddit that is not canonical", () => {
    expect(
      redditMonitoringQuerySchema.safeParse({
        ...valid,
        allowedSubreddits: ["r/AskCulinary"],
      }).success,
    ).toBe(false);
  });

  it("refuses a poll interval below the budget floor", () => {
    expect(
      redditMonitoringQuerySchema.safeParse({ ...valid, pollIntervalMinutes: 5 })
        .success,
    ).toBe(false);
  });
});

describe("reddit source metadata", () => {
  it("accepts the named, reviewed subset and strips anything else", () => {
    // The data-minimisation contract: a Reddit object carries far more about a
    // person than Lia has reason to hold, so the connector stores this shape
    // and discards the rest.
    const parsed = redditSourceMetadataSchema.parse({
      subreddit: "askculinary",
      score: 42,
      commentCount: 7,
      isLocked: false,
      isArchived: false,
      isNsfw: false,
      isEdited: true,
      depth: 0,
      author_flair_text: "chef",
      author_fullname: "t2_abc",
      gildings: { gid_1: 2 },
    });

    expect(Object.keys(parsed).sort()).toEqual([
      "commentCount",
      "depth",
      "isArchived",
      "isEdited",
      "isLocked",
      "isNsfw",
      "score",
      "subreddit",
    ]);
  });

  it("allows a negative score, because Reddit does", () => {
    const parsed = redditSourceMetadataSchema.safeParse({
      subreddit: "askculinary",
      score: -12,
      commentCount: 0,
      isLocked: false,
      isArchived: false,
      isNsfw: false,
      isEdited: false,
      depth: 0,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("mention discussion fields", () => {
  it("defaults every one of them to not-a-thread", () => {
    expect(NEW_MENTION_DEFAULTS.conversationRootExternalId).toBeNull();
    expect(NEW_MENTION_DEFAULTS.sourceCommunity).toBeNull();
    expect(NEW_MENTION_DEFAULTS.sourceScore).toBeNull();
    expect(NEW_MENTION_DEFAULTS.sourceCommentCount).toBeNull();
    expect(NEW_MENTION_DEFAULTS.sourceIsLocked).toBe(false);
    expect(NEW_MENTION_DEFAULTS.sourceIsArchived).toBe(false);
    expect(NEW_MENTION_DEFAULTS.sourceIsNsfw).toBe(false);
    expect(NEW_MENTION_DEFAULTS.sourceRemovedAt).toBeNull();
    expect(NEW_MENTION_DEFAULTS.sourceLastVerifiedAt).toBeNull();
  });

  it("declares all nine as source-owned", () => {
    for (const field of [
      "conversationRootExternalId",
      "sourceCommunity",
      "sourceScore",
      "sourceCommentCount",
      "sourceIsLocked",
      "sourceIsArchived",
      "sourceIsNsfw",
      "sourceRemovedAt",
      "sourceLastVerifiedAt",
    ] as const) {
      expect(SOURCE_OWNED_MENTION_FIELDS).toContain(field);
    }
  });

  it("notices a lock, an archive, and a removal as source changes", () => {
    // A thread that locked between two refreshes must report `updated`, not
    // `unchanged` — publishing reads these fields to refuse.
    const existing = { ...MENTION, sourceIsLocked: false };
    expect(
      sourceFieldsChanged(existing, { ...INGEST, sourceIsLocked: true }),
    ).toBe(true);
    expect(
      sourceFieldsChanged(existing, { ...INGEST, sourceIsArchived: true }),
    ).toBe(true);
    expect(
      sourceFieldsChanged(existing, {
        ...INGEST,
        sourceRemovedAt: "2026-08-14T12:00:00.000Z",
      }),
    ).toBe(true);
    expect(sourceFieldsChanged(existing, INGEST)).toBe(false);
  });

  it("writes exactly the source-owned fields and nothing else", () => {
    // Pins `applySourceFields` against `SOURCE_OWNED_MENTION_FIELDS`, which is
    // the single declaration of the line. The function hand-writes its
    // assignments, so without this the two drift the moment a field is added
    // to one and not the other — invisibly, because a missing assignment just
    // means a field stops being refreshed.
    const escalated: Mention = {
      ...MENTION,
      status: "escalated",
      sentiment: "negative",
      riskLevel: "high",
      relevanceScore: 0.9,
    };
    const applied = applySourceFields(
      escalated,
      { ...INGEST, sourceIsLocked: true, sourceScore: 99 },
      "2026-08-15T12:00:00.000Z",
    );

    const changed = (Object.keys(applied) as (keyof Mention)[]).filter(
      (key) => JSON.stringify(applied[key]) !== JSON.stringify(escalated[key]),
    );

    // `lastSyncedAt` and `updatedAt` are written by the function itself rather
    // than being source-owned fields, so they are expected extras.
    expect(changed.sort()).toEqual(
      ["lastSyncedAt", "sourceIsLocked", "sourceScore", "updatedAt"].sort(),
    );
    // The human decisions survived, which is the guarantee that matters.
    expect(applied.status).toBe("escalated");
    expect(applied.riskLevel).toBe("high");
  });
});

describe("publication failures", () => {
  it("treats only definite provider refusals as terminal", () => {
    // Everything else, arriving after the request went out, is an unknown
    // outcome — and an unknown outcome that retries posts a duplicate reply
    // under a customer's name.
    expect(isDefiniteFailure("rejected_by_platform")).toBe(true);
    expect(isDefiniteFailure("policy_blocked")).toBe(true);
    expect(isDefiniteFailure("provider_unavailable")).toBe(false);
    expect(isDefiniteFailure("rate_limited")).toBe(false);
    expect(isDefiniteFailure("unexpected_output")).toBe(false);
  });

  it("classifies every category exactly once", () => {
    // A category nobody classified would default to "not definite" and route
    // to reconciliation, which is the safe direction — but silently, so the
    // omission would never be noticed.
    for (const category of PUBLICATION_FAILURE_CATEGORIES) {
      expect(typeof isDefiniteFailure(category)).toBe("boolean");
    }
    for (const category of DEFINITE_PUBLICATION_FAILURES) {
      expect(PUBLICATION_FAILURE_CATEGORIES).toContain(category);
    }
  });
});

describe("publication claim result", () => {
  it("carries a token only on the claimed branch", () => {
    const claimed = publicationClaimResultSchema.parse({
      outcome: "claimed",
      attemptId: "33333333-3333-4333-8333-333333333333",
      claimToken: "secret",
      targetExternalId: "t3_abc123",
    });
    expect(claimed).toHaveProperty("claimToken");

    const inProgress = publicationClaimResultSchema.parse({
      outcome: "in_progress",
      attemptId: "33333333-3333-4333-8333-333333333333",
      claimToken: "secret",
    });
    // The union strips it: a second click cannot walk away holding a token
    // that would let it complete somebody else's attempt.
    expect(inProgress).not.toHaveProperty("claimToken");
  });

  it("refuses with a named reason rather than a boolean", () => {
    const refused = publicationClaimResultSchema.parse({
      outcome: "refused",
      reason: "community_not_allowed",
    });
    expect(refused).toEqual({ outcome: "refused", reason: "community_not_allowed" });
  });
});

/* -------------------------------------------------------------------------- */
/* Fixtures                                                                    */
/* -------------------------------------------------------------------------- */

const MENTION: Mention = {
  id: "44444444-4444-4444-8444-444444444444",
  organizationId: "22222222-2222-4222-8222-222222222222",
  locationId: null,
  platformConnectionId: "55555555-5555-4555-8555-555555555555",
  platformProfileId: null,
  sourceType: "reddit_post",
  externalId: "t3_abc123",
  externalParentId: null,
  sourceUrl: "https://www.reddit.com/r/askculinary/comments/abc123",
  title: "Anyone been to Maison Laurent?",
  content: "Thinking of booking for an anniversary.",
  authorName: "someone",
  authorExternalId: "t2_xyz",
  rating: null,
  language: "en-US",
  publishedAt: "2026-08-14T10:00:00.000Z",
  receivedAt: "2026-08-14T10:05:00.000Z",
  status: "new",
  sentiment: "unknown",
  riskLevel: "low",
  relevanceScore: null,
  engagementScore: null,
  rawPayload: {},
  ...NEW_MENTION_DEFAULTS,
  conversationRootExternalId: "t3_abc123",
  sourceCommunity: "askculinary",
  sourceScore: 12,
  sourceCommentCount: 3,
  createdAt: "2026-08-14T10:05:00.000Z",
  updatedAt: "2026-08-14T10:05:00.000Z",
};

const INGEST: IngestMentionInput = {
  locationId: MENTION.locationId,
  platformConnectionId: MENTION.platformConnectionId,
  platformProfileId: MENTION.platformProfileId,
  sourceType: MENTION.sourceType,
  externalId: MENTION.externalId,
  externalParentId: MENTION.externalParentId,
  sourceUrl: MENTION.sourceUrl,
  title: MENTION.title,
  content: MENTION.content,
  authorName: MENTION.authorName,
  authorExternalId: MENTION.authorExternalId,
  rating: MENTION.rating,
  language: MENTION.language,
  publishedAt: MENTION.publishedAt,
  rawPayload: MENTION.rawPayload,
  externalResourceName: MENTION.externalResourceName,
  authorAvatarUrl: MENTION.authorAvatarUrl,
  authorIsAnonymous: MENTION.authorIsAnonymous,
  sourceUpdatedAt: MENTION.sourceUpdatedAt,
  sourceReplyText: MENTION.sourceReplyText,
  sourceReplyUpdatedAt: MENTION.sourceReplyUpdatedAt,
  sourceMetadata: MENTION.sourceMetadata,
  syncedAt: MENTION.updatedAt,
  publisherName: MENTION.publisherName,
  publisherDomain: MENTION.publisherDomain,
  monitoringQueryId: MENTION.monitoringQueryId,
  conversationRootExternalId: MENTION.conversationRootExternalId,
  sourceCommunity: MENTION.sourceCommunity,
  sourceScore: MENTION.sourceScore,
  sourceCommentCount: MENTION.sourceCommentCount,
  sourceIsLocked: MENTION.sourceIsLocked,
  sourceIsArchived: MENTION.sourceIsArchived,
  sourceIsNsfw: MENTION.sourceIsNsfw,
  sourceRemovedAt: MENTION.sourceRemovedAt,
  sourceLastVerifiedAt: MENTION.sourceLastVerifiedAt,
};
