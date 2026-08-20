import { z } from "zod";

/**
 * What Lia reads out of a Reddit response.
 *
 * Deliberately narrow, and `.passthrough()` is deliberately absent. Reddit's
 * objects carry dozens of fields about the person who wrote them — flair,
 * awards, subreddit karma, moderator status — and Zod's default strip is what
 * makes "Lia holds a named subset" true by construction rather than by
 * discipline at the call site. The connector could not accidentally persist a
 * whole `t3` object even if somebody handed it one.
 *
 * Every field below is either something a screen shows, something the gate
 * reads, or something the retention contract needs. Anything that is none of
 * those is not here.
 */

/** Reddit reports deleted content as these exact literals in the body field. */
export const REDDIT_DELETED_MARKERS = ["[deleted]", "[removed]"] as const;

export function isDeletedMarker(value: string | null | undefined): boolean {
  return (REDDIT_DELETED_MARKERS as readonly string[]).includes(value ?? "");
}

/**
 * `created_utc` is seconds, and Reddit sends it as a float.
 *
 * Coerced rather than trusted: a string here would silently become
 * `Invalid Date` downstream and land in the database as a null published_at,
 * which reads as "Lia does not know when this was posted" rather than as a
 * parse failure anybody would notice.
 */
const epochSecondsSchema = z.coerce.number().finite();

/**
 * Reddit's `edited` field is a union by design: `false` when never edited, or
 * an epoch when it was. Modelled as the union rather than coerced to boolean,
 * because the timestamp is what `source_updated_at` needs.
 */
const editedSchema = z.union([z.boolean(), epochSecondsSchema]);

const baseThingSchema = z.object({
  id: z.string().min(1).max(20),
  name: z.string().min(1).max(30),
  author: z.string().max(200).nullable().optional(),
  /** Reddit's user fullname (`t2_…`). Absent on deleted accounts. */
  author_fullname: z.string().max(60).nullable().optional(),
  subreddit: z.string().min(1).max(50),
  created_utc: epochSecondsSchema,
  edited: editedSchema.optional(),
  score: z.coerce.number().int().optional(),
  locked: z.boolean().optional(),
  archived: z.boolean().optional(),
  over_18: z.boolean().optional(),
  permalink: z.string().max(500).optional(),
  /** Set by moderators or Reddit itself. Distinct from author deletion. */
  removed_by_category: z.string().max(80).nullable().optional(),
});

export const redditPostSchema = baseThingSchema.extend({
  title: z.string().max(400),
  selftext: z.string().optional(),
  num_comments: z.coerce.number().int().min(0).optional(),
});

export type RedditPostPayload = z.infer<typeof redditPostSchema>;

export const redditCommentSchema = baseThingSchema.extend({
  body: z.string().optional(),
  /** The direct parent: a post (`t3_…`) or another comment (`t1_…`). */
  parent_id: z.string().max(30),
  /** The root post this comment lives under. */
  link_id: z.string().max(30),
  depth: z.coerce.number().int().min(0).optional(),
});

export type RedditCommentPayload = z.infer<typeof redditCommentSchema>;

/**
 * Reddit's listing envelope: `{ kind: "Listing", data: { children: [...] } }`.
 *
 * The child schema is passed in rather than fixed, because posts and comments
 * arrive in identically-shaped envelopes and only the payload differs.
 *
 * Children are parsed **individually** by the caller, not by this schema. A
 * single malformed item in a page of a hundred must cost that item, not the
 * page — the connector counts malformed entries and keeps the rest, which is
 * what stops one unusual post from making a monitor look broken.
 */
export const redditListingSchema = z.object({
  kind: z.literal("Listing"),
  data: z.object({
    after: z.string().nullable().optional(),
    dist: z.number().nullable().optional(),
    children: z.array(
      z.object({
        kind: z.string(),
        data: z.unknown(),
      }),
    ),
  }),
});

export const redditIdentitySchema = z.object({
  id: z.string().min(1).max(30),
  name: z.string().min(1).max(200),
});

export type RedditIdentityPayload = z.infer<typeof redditIdentitySchema>;

export const redditTokenSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().min(1),
  expires_in: z.coerce.number().int().positive().optional(),
  refresh_token: z.string().min(1).optional(),
  /** Space-separated, per the OAuth spec. Never assumed to equal the request. */
  scope: z.string().optional(),
});

/** One rule as Reddit's `/r/<sub>/about/rules` returns it. */
export const redditCommunityRuleSchema = z.object({
  short_name: z.string().max(200),
  description: z.string().max(4000).optional(),
  kind: z.string().max(40).optional(),
});

export const redditCommunityRulesSchema = z.object({
  rules: z.array(redditCommunityRuleSchema),
});

/**
 * A comment as it appears in the connected account's own history.
 *
 * Reconciliation reads these to answer "did the reply Lia may have posted
 * actually land?", which is why `body` is present here and nowhere else in the
 * write path: matching on normalized exact text is what distinguishes Lia's
 * comment from any other the account made in the same window. The body is
 * compared and discarded — only the fullname is ever stored.
 */
export const redditOwnCommentSchema = z.object({
  name: z.string().min(1).max(30),
  parent_id: z.string().max(30),
  body: z.string(),
  created_utc: epochSecondsSchema,
  author_fullname: z.string().max(60).nullable().optional(),
});

export type RedditOwnCommentPayload = z.infer<typeof redditOwnCommentSchema>;
