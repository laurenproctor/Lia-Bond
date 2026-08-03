import type {
  Location,
  Mention,
  MentionAnalysis,
  MentionSourceType,
  Platform,
  RiskLevel,
  Sentiment,
} from "@/domain";
import { isReviewSourceType, SOURCE_TYPE_PLATFORM } from "@/domain";

/**
 * Domain to presentation.
 *
 * The components built in workflow 01 expect a flatter shape than the domain
 * model: an excerpt, author initials, a workspace route. Deriving those here
 * keeps two things true at once — the domain stays normalised and honest, and
 * the components stay unchanged, so the visual design does not drift while the
 * data underneath it becomes real.
 */

export interface MentionView {
  id: string;
  platform: Platform;
  sourceType: MentionSourceType;
  title: string;
  excerpt: string;
  content: string;
  authorName: string;
  authorInitials: string;
  publishedAt: string;
  sentiment: Sentiment;
  riskLevel: RiskLevel;
  status: Mention["status"];
  rating: number | null;
  locationLabel: string;
  /** Subreddit, publication, or location — whatever names the context best. */
  contextLabel: string;
  workspacePath: string;
  recommendedAction: MentionAnalysis["recommendedAction"] | null;
  topics: string[];
  summary: string | null;
}

/** "John L." -> "JL", "u/foodie_nyc" -> "FN". */
export function initialsFor(name: string | null): string {
  if (!name) return "??";

  const cleaned = name.replace(/^u\//, "").replace(/^@/, "").trim();
  const parts = cleaned.split(/[\s._-]+/).filter(Boolean);

  if (parts.length === 0) return "??";
  if (parts.length === 1) return (parts[0] ?? "").slice(0, 2).toUpperCase();

  return `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? ""}`.toUpperCase();
}

/** First sentence or so, for dense queue rows. */
export function excerptFrom(content: string, limit = 140): string {
  const normalized = content.replace(/\s+/g, " ").trim();
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit).replace(/\s+\S*$/, "")}…`;
}

/**
 * Which workspace can act on this mention.
 *
 * Reviews, Reddit threads, and articles each have a purpose-built screen; other
 * sources are handled from the unified inbox.
 */
export function workspacePathFor(mention: Mention): string {
  switch (mention.sourceType) {
    case "google_review":
      return `/reviews/google/${mention.id}`;
    case "reddit_post":
    case "reddit_comment":
      return `/reddit/${mention.id}`;
    case "news_article":
      return `/media/${mention.id}`;
    default:
      return `/mentions?mention=${mention.id}`;
  }
}

function readRawString(
  payload: Mention["rawPayload"],
  key: string,
): string | null {
  const value = payload[key];
  return typeof value === "string" ? value : null;
}

export interface MentionViewInput {
  mention: Mention;
  analysis?: MentionAnalysis | null;
  locationsById?: Map<string, Location>;
}

export function toMentionView({
  mention,
  analysis = null,
  locationsById,
}: MentionViewInput): MentionView {
  const locationLabel = mention.locationId
    ? (locationsById?.get(mention.locationId)?.name ?? "Unknown location")
    : "All locations";

  // Reddit is best identified by its subreddit and media by its publication;
  // both live in the preserved raw payload rather than a normalised column.
  const contextLabel =
    readRawString(mention.rawPayload, "subreddit") ??
    readRawString(mention.rawPayload, "publication") ??
    locationLabel;

  return {
    id: mention.id,
    platform: SOURCE_TYPE_PLATFORM[mention.sourceType],
    sourceType: mention.sourceType,
    title: mention.title ?? excerptFrom(mention.content, 70),
    excerpt: excerptFrom(mention.content),
    content: mention.content,
    authorName: mention.authorName ?? "Unknown author",
    authorInitials: initialsFor(mention.authorName),
    publishedAt: mention.publishedAt,
    sentiment: mention.sentiment,
    riskLevel: mention.riskLevel,
    status: mention.status,
    rating: isReviewSourceType(mention.sourceType) ? mention.rating : null,
    locationLabel,
    contextLabel,
    workspacePath: workspacePathFor(mention),
    recommendedAction: analysis?.recommendedAction ?? null,
    topics: analysis?.topics ?? [],
    summary: analysis?.relevanceExplanation ?? null,
  };
}

/** Batch helper that resolves locations and analyses once for a whole list. */
export function toMentionViews(
  mentions: Mention[],
  options: { analyses?: MentionAnalysis[]; locations?: Location[] } = {},
): MentionView[] {
  const locationsById = new Map(
    (options.locations ?? []).map((location) => [location.id, location]),
  );

  const analysisByMention = new Map<string, MentionAnalysis>();
  for (const analysis of options.analyses ?? []) {
    const existing = analysisByMention.get(analysis.mentionId);
    if (!existing || existing.analyzedAt < analysis.analyzedAt) {
      analysisByMention.set(analysis.mentionId, analysis);
    }
  }

  return mentions.map((mention) =>
    toMentionView({
      mention,
      analysis: analysisByMention.get(mention.id) ?? null,
      locationsById,
    }),
  );
}
