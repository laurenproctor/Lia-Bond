import {
  canonicalizeSubreddit,
  type RedditSourceMetadata,
} from "@/domain";
import {
  isDeletedMarker,
  redditCommentSchema,
  redditPostSchema,
  type RedditCommentPayload,
  type RedditPostPayload,
} from "@/reddit/schemas";

/**
 * Reddit's objects, reduced to what Lia stores.
 *
 * This module is the data-minimisation boundary in code form. Everything above
 * it works with `NormalisedRedditPost` and `NormalisedRedditComment`; nothing
 * above it ever sees a raw Reddit object, which is what makes it impossible to
 * accidentally persist one.
 *
 * Pure and synchronous on purpose — no network, no clock, no configuration —
 * so every state below can be exercised as a table of inputs rather than
 * through a fake HTTP layer.
 */

export interface NormalisedRedditAuthor {
  /** Null when Reddit reports the account as deleted. */
  readonly name: string | null;
  readonly externalId: string | null;
  /** True when the author is `[deleted]`, as distinct from simply unreported. */
  readonly isDeleted: boolean;
}

interface NormalisedRedditThing {
  readonly externalId: string;
  readonly conversationRootExternalId: string;
  readonly author: NormalisedRedditAuthor;
  readonly community: string;
  readonly content: string;
  readonly sourceUrl: string | null;
  readonly publishedAt: string;
  /** When the author last edited it. Null when Reddit says it was never edited. */
  readonly sourceUpdatedAt: string | null;
  /**
   * The content itself is gone at the source.
   *
   * Distinct from the author being deleted: Reddit reports a removed body as
   * the literal `[deleted]` or `[removed]` while leaving the rest of the
   * object intact, and Lia must not store those markers as if they were what
   * somebody wrote.
   */
  readonly isRemoved: boolean;
  readonly metadata: RedditSourceMetadata;
}

export interface NormalisedRedditPost extends NormalisedRedditThing {
  readonly kind: "post";
  readonly title: string;
  readonly externalParentId: null;
}

export interface NormalisedRedditComment extends NormalisedRedditThing {
  readonly kind: "comment";
  /** The direct parent — a post or another comment. */
  readonly externalParentId: string;
}

export type NormalisedRedditThingUnion =
  | NormalisedRedditPost
  | NormalisedRedditComment;

/** Reddit sends epoch seconds as a float. */
function toIso(epochSeconds: number): string {
  return new Date(Math.round(epochSeconds * 1000)).toISOString();
}

/**
 * `edited` is `false`, or an epoch. Anything else — including `true`, which
 * Reddit sends for very old edits with no recorded timestamp — yields null,
 * because "edited at some unknown time" is not a timestamp and inventing one
 * would put a fabricated instant in front of a customer.
 */
function editedAt(edited: boolean | number | undefined): string | null {
  if (typeof edited === "number" && Number.isFinite(edited) && edited > 0) {
    return toIso(edited);
  }
  return null;
}

function normaliseAuthor(payload: {
  author?: string | null;
  author_fullname?: string | null;
}): NormalisedRedditAuthor {
  const raw = payload.author ?? null;
  if (raw === null || isDeletedMarker(raw)) {
    // Both halves cleared, not just the name. A deleted account is a
    // withdrawal of the person, and keeping the fullname would leave a stable
    // identifier for somebody who asked to stop being identifiable.
    return { name: null, externalId: null, isDeleted: isDeletedMarker(raw) };
  }
  return {
    name: raw,
    externalId: payload.author_fullname ?? null,
    isDeleted: false,
  };
}

function permalinkUrl(permalink: string | undefined): string | null {
  if (!permalink) return null;
  // Reddit returns a path, not a URL, and it always starts with a slash.
  if (!permalink.startsWith("/")) return null;
  return `https://www.reddit.com${permalink}`;
}

/**
 * A body Lia is willing to store.
 *
 * Reddit's deletion markers are sentinels, not content. Storing `[deleted]` as
 * the body would put a word nobody wrote into the inbox, into the analysis
 * prompt, and into a draft's context — and would read, to anyone glancing at
 * the screen, as if that were the post.
 */
function storableBody(value: string | undefined): { content: string; removed: boolean } {
  const raw = value ?? "";
  if (isDeletedMarker(raw)) return { content: "", removed: true };
  return { content: raw, removed: false };
}

export function normalisePost(input: unknown): NormalisedRedditPost | null {
  const parsed = redditPostSchema.safeParse(input);
  if (!parsed.success) return null;
  const payload: RedditPostPayload = parsed.data;

  const community = canonicalizeSubreddit(payload.subreddit);
  // A subreddit name Lia cannot canonicalize is a post it cannot check a
  // community posture for, so it is treated as malformed rather than stored
  // with a name no posture lookup will ever match.
  if (community === null) return null;

  const body = storableBody(payload.selftext);
  const titleRemoved = isDeletedMarker(payload.title);

  return {
    kind: "post",
    externalId: payload.name,
    // A root post is its own conversation root. The self-reference is what
    // makes "everything in this thread" one equality filter.
    conversationRootExternalId: payload.name,
    externalParentId: null,
    title: titleRemoved ? "" : payload.title,
    content: body.content,
    author: normaliseAuthor(payload),
    community,
    sourceUrl: permalinkUrl(payload.permalink),
    publishedAt: toIso(payload.created_utc),
    sourceUpdatedAt: editedAt(payload.edited),
    isRemoved:
      body.removed ||
      titleRemoved ||
      (payload.removed_by_category ?? null) !== null,
    metadata: {
      subreddit: community,
      score: payload.score ?? 0,
      commentCount: payload.num_comments ?? 0,
      isLocked: payload.locked ?? false,
      isArchived: payload.archived ?? false,
      isNsfw: payload.over_18 ?? false,
      isEdited: editedAt(payload.edited) !== null,
      depth: 0,
    },
  };
}

export function normaliseComment(input: unknown): NormalisedRedditComment | null {
  const parsed = redditCommentSchema.safeParse(input);
  if (!parsed.success) return null;
  const payload: RedditCommentPayload = parsed.data;

  const community = canonicalizeSubreddit(payload.subreddit);
  if (community === null) return null;

  const body = storableBody(payload.body);

  return {
    kind: "comment",
    externalId: payload.name,
    conversationRootExternalId: payload.link_id,
    externalParentId: payload.parent_id,
    content: body.content,
    author: normaliseAuthor(payload),
    community,
    sourceUrl: permalinkUrl(payload.permalink),
    publishedAt: toIso(payload.created_utc),
    sourceUpdatedAt: editedAt(payload.edited),
    isRemoved: body.removed || (payload.removed_by_category ?? null) !== null,
    metadata: {
      subreddit: community,
      score: payload.score ?? 0,
      // A comment has no comment count of its own. Zero rather than the
      // thread's, which would repeat the root's number on every reply.
      commentCount: 0,
      isLocked: payload.locked ?? false,
      isArchived: payload.archived ?? false,
      isNsfw: payload.over_18 ?? false,
      isEdited: editedAt(payload.edited) !== null,
      // Reddit omits `depth` on some endpoints. One is the honest floor for a
      // comment — it is at least one level below the post.
      depth: payload.depth ?? 1,
    },
  };
}

export interface NormalisedBatch<T> {
  readonly items: T[];
  /**
   * How many children failed to parse.
   *
   * Counted rather than thrown, so one unusual object does not cost a page of
   * a hundred. A monitor that silently returned nothing because of a single
   * malformed post would look broken in exactly the way that is hardest to
   * diagnose — so the count travels to the poll run, where an operator sees it.
   */
  readonly malformed: number;
}

/**
 * Parse a listing's children, keeping what is valid and counting what is not.
 *
 * Children whose `kind` does not match the expected thing type are skipped
 * without being counted as malformed: Reddit legitimately mixes `more` markers
 * into a comment listing, and treating those as parse failures would report a
 * broken feed on every healthy thread.
 */
export function normaliseListingChildren<T>(
  children: readonly { kind: string; data: unknown }[],
  expectedKind: "t3" | "t1",
  normalise: (input: unknown) => T | null,
): NormalisedBatch<T> {
  const items: T[] = [];
  let malformed = 0;

  for (const child of children) {
    if (child.kind !== expectedKind) continue;
    const normalised = normalise(child.data);
    if (normalised === null) {
      malformed += 1;
      continue;
    }
    items.push(normalised);
  }

  return { items, malformed };
}

/**
 * The comparison reconciliation uses to recognize a comment as Lia's own.
 *
 * Whitespace-collapsed and case-folded, because Reddit normalizes trailing
 * whitespace and Lia must not conclude "no match" over a newline it did not
 * send. Deliberately not fuzzier than that: a near-match is not a match, and
 * the cost of a false positive here is marking somebody else's comment as
 * Lia's published reply.
 */
export function normaliseForComparison(text: string): string {
  return text.trim().replace(/\s+/g, " ").toLowerCase();
}
