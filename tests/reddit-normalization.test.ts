import { describe, expect, it } from "vitest";
import {
  normaliseComment,
  normaliseForComparison,
  normaliseListingChildren,
  normalisePost,
} from "@/reddit/normalise";

/**
 * The normaliser is the data-minimisation boundary in code form: nothing above
 * it ever sees a raw Reddit object. These tests pin the two things that makes
 * it responsible for — that the fields Lia does not keep are genuinely dropped,
 * and that Reddit's deletion sentinels never become content.
 */

const RAW_POST = {
  id: "abc123",
  name: "t3_abc123",
  author: "u/foodie",
  author_fullname: "t2_foodie",
  subreddit: "AskCulinary",
  created_utc: 1786000000,
  title: "Worth the hype?",
  selftext: "Thinking of booking.",
  num_comments: 7,
  score: 42,
  locked: false,
  archived: false,
  over_18: false,
  permalink: "/r/AskCulinary/comments/abc123/worth_the_hype/",
  // Everything below is what Lia must not keep.
  author_flair_text: "Chef",
  author_premium: true,
  gildings: { gid_1: 2 },
  all_awardings: [{ name: "Gold", coin_price: 500 }],
  upvote_ratio: 0.94,
  subreddit_subscribers: 2_100_000,
  thumbnail: "https://b.thumbs.redditmedia.com/abc.jpg",
};

const RAW_COMMENT = {
  id: "c1",
  name: "t1_c1",
  author: "u/west4th",
  author_fullname: "t2_west4th",
  subreddit: "AskCulinary",
  created_utc: 1786001000,
  body: "Pacing was fine.",
  parent_id: "t3_abc123",
  link_id: "t3_abc123",
  depth: 1,
  score: 12,
  permalink: "/r/AskCulinary/comments/abc123/_/c1/",
  controversiality: 0,
  author_flair_richtext: [{ e: "text", t: "Line cook" }],
};

/**
 * A fixture minus one key.
 *
 * `const { x: _omitted, ...rest }` is the usual idiom and lints as an unused
 * variable; this says the same thing without leaving one behind.
 */
function without<T extends object>(source: T, key: keyof T): Partial<T> {
  return Object.fromEntries(
    Object.entries(source).filter(([name]) => name !== key),
  ) as Partial<T>;
}

describe("normalisePost", () => {
  it("keeps the named subset and drops everything else", () => {
    const post = normalisePost(RAW_POST);
    expect(post).not.toBeNull();
    // The metadata is the whole of what reaches `source_metadata`. If flair,
    // awards, or a thumbnail URL appeared here they would reach the database.
    expect(Object.keys(post!.metadata).sort()).toEqual([
      "commentCount",
      "depth",
      "isArchived",
      "isEdited",
      "isLocked",
      "isNsfw",
      "score",
      "subreddit",
    ]);
    const serialized = JSON.stringify(post);
    for (const leak of ["flair", "gildings", "awardings", "upvote_ratio", "thumbnail", "premium"]) {
      expect(serialized).not.toContain(leak);
    }
  });

  it("canonicalizes the community, so a posture lookup can match it", () => {
    expect(normalisePost(RAW_POST)?.community).toBe("askculinary");
    expect(normalisePost(RAW_POST)?.metadata.subreddit).toBe("askculinary");
  });

  it("makes a root post its own conversation root", () => {
    const post = normalisePost(RAW_POST);
    expect(post?.conversationRootExternalId).toBe("t3_abc123");
    expect(post?.externalParentId).toBeNull();
  });

  it("converts Reddit's float epoch to an ISO instant", () => {
    expect(normalisePost({ ...RAW_POST, created_utc: 1786000000.5 })?.publishedAt).toBe(
      new Date(1786000000500).toISOString(),
    );
  });

  it("rejects an object it cannot canonicalize a community for", () => {
    // A community Lia cannot canonicalize is one it can never check a posture
    // for, so it is malformed rather than stored under an unmatched name.
    expect(normalisePost({ ...RAW_POST, subreddit: "a+b" })).toBeNull();
  });

  it("rejects an object missing a field Lia depends on", () => {
    expect(normalisePost(without(RAW_POST, "created_utc"))).toBeNull();
    expect(normalisePost(null)).toBeNull();
    expect(normalisePost({})).toBeNull();
  });
});

describe("deletion sentinels", () => {
  it("never stores [removed] as if it were the body", () => {
    // Storing the sentinel would put a word nobody wrote into the inbox, the
    // analysis prompt, and a draft's context — and would read, to anyone
    // glancing at the screen, as if that were the post.
    const post = normalisePost({ ...RAW_POST, selftext: "[removed]" });
    expect(post?.content).toBe("");
    expect(post?.isRemoved).toBe(true);
  });

  it("never stores [deleted] as if it were the body", () => {
    const comment = normaliseComment({ ...RAW_COMMENT, body: "[deleted]" });
    expect(comment?.content).toBe("");
    expect(comment?.isRemoved).toBe(true);
  });

  it("clears both halves of a deleted author's identity", () => {
    // Keeping the fullname would leave a stable identifier for somebody who
    // asked to stop being identifiable.
    const post = normalisePost({ ...RAW_POST, author: "[deleted]" });
    expect(post?.author.name).toBeNull();
    expect(post?.author.externalId).toBeNull();
    expect(post?.author.isDeleted).toBe(true);
  });

  it("distinguishes an unreported author from a deleted one", () => {
    const post = normalisePost({ ...RAW_POST, author: null, author_fullname: null });
    expect(post?.author.name).toBeNull();
    expect(post?.author.isDeleted).toBe(false);
  });

  it("treats a moderator removal as removed even with a body intact", () => {
    const post = normalisePost({ ...RAW_POST, removed_by_category: "moderator" });
    expect(post?.isRemoved).toBe(true);
  });
});

describe("edited state", () => {
  it("reads an edit timestamp when Reddit gives one", () => {
    const post = normalisePost({ ...RAW_POST, edited: 1786009999 });
    expect(post?.sourceUpdatedAt).toBe(new Date(1786009999000).toISOString());
    expect(post?.metadata.isEdited).toBe(true);
  });

  it("reports no edit when Reddit says false", () => {
    const post = normalisePost({ ...RAW_POST, edited: false });
    expect(post?.sourceUpdatedAt).toBeNull();
    expect(post?.metadata.isEdited).toBe(false);
  });

  it("refuses to invent an instant when Reddit says only `true`", () => {
    // Reddit sends `true` for very old edits with no recorded timestamp.
    // "Edited at some unknown time" is not a timestamp, and fabricating one
    // would put a made-up instant in front of a customer.
    const post = normalisePost({ ...RAW_POST, edited: true });
    expect(post?.sourceUpdatedAt).toBeNull();
    expect(post?.metadata.isEdited).toBe(false);
  });
});

describe("normaliseComment", () => {
  it("carries the root and the direct parent separately", () => {
    // The two differ on a nested reply, and conflating them would flatten
    // every thread into a list.
    const comment = normaliseComment({ ...RAW_COMMENT, parent_id: "t1_other" });
    expect(comment?.conversationRootExternalId).toBe("t3_abc123");
    expect(comment?.externalParentId).toBe("t1_other");
  });

  it("does not repeat the thread's comment count on every reply", () => {
    expect(normaliseComment(RAW_COMMENT)?.metadata.commentCount).toBe(0);
  });

  it("defaults depth to one when Reddit omits it", () => {
    expect(normaliseComment(without(RAW_COMMENT, "depth"))?.metadata.depth).toBe(1);
  });
});

describe("permalinks", () => {
  it("builds an absolute URL from Reddit's path", () => {
    expect(normalisePost(RAW_POST)?.sourceUrl).toBe(
      "https://www.reddit.com/r/AskCulinary/comments/abc123/worth_the_hype/",
    );
  });

  it("refuses anything that is not a Reddit path", () => {
    // Reddit returns a path. A value that is not one is not something to
    // prefix a hostname onto and hand a customer as a link.
    expect(normalisePost({ ...RAW_POST, permalink: "https://evil.test/x" })?.sourceUrl)
      .toBeNull();
    expect(normalisePost(without(RAW_POST, "permalink"))?.sourceUrl).toBeNull();
  });
});

describe("normaliseListingChildren", () => {
  it("counts a malformed child rather than losing the page", () => {
    // One unusual object must not cost a page of a hundred. A monitor that
    // silently returned nothing over a single bad post would look broken in
    // exactly the way that is hardest to diagnose.
    const batch = normaliseListingChildren(
      [
        { kind: "t3", data: RAW_POST },
        { kind: "t3", data: { id: "broken" } },
        { kind: "t3", data: { ...RAW_POST, name: "t3_second" } },
      ],
      "t3",
      normalisePost,
    );
    expect(batch.items).toHaveLength(2);
    expect(batch.malformed).toBe(1);
  });

  it("skips a `more` marker without calling it malformed", () => {
    // Reddit legitimately mixes `more` markers into a comment listing.
    // Counting those as parse failures would report a broken feed on every
    // healthy thread.
    const batch = normaliseListingChildren(
      [
        { kind: "t1", data: RAW_COMMENT },
        { kind: "more", data: { count: 42, children: ["x", "y"] } },
      ],
      "t1",
      normaliseComment,
    );
    expect(batch.items).toHaveLength(1);
    expect(batch.malformed).toBe(0);
  });
});

describe("normaliseForComparison", () => {
  it("collapses whitespace and folds case, and nothing more", () => {
    expect(normaliseForComparison("  Thanks   for\nthe feedback. ")).toBe(
      "thanks for the feedback.",
    );
  });

  it("does not treat a near-match as a match", () => {
    // The cost of a false positive here is marking somebody else's comment as
    // Lia's published reply.
    expect(normaliseForComparison("Thanks for the feedback")).not.toBe(
      normaliseForComparison("Thanks for your feedback"),
    );
  });
});
