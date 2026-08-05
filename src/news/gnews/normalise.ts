import type { ExternalArticle, NewsSearchQuery } from "@/news/monitor";

/**
 * GNews search syntax.
 *
 * Multi-word terms must be quoted or the provider treats them as separate
 * words, which is the difference between finding "Gramercy Tavern" and finding
 * every article containing "tavern".
 */
export function buildGNewsQuery(query: NewsSearchQuery): string {
  const quote = (term: string) => (term.includes(" ") ? `"${term}"` : term);
  const positive = query.keywords.map(quote).join(" OR ");
  if (query.exclusions.length === 0) return positive;
  const negative = query.exclusions.map((term) => `NOT ${quote(term)}`).join(" ");
  // Parenthesised only when there is a disjunction to protect: with one
  // keyword, `positive` is already a single term and grouping it would be
  // inert. With several, an unparenthesised `"A" OR "B" NOT "C"` is at the
  // mercy of the provider's operator precedence — if `NOT` binds tighter than
  // `OR`, it silently narrows to "A, or B without C" instead of the intended
  // "A or B, minus C," and nothing would surface the difference.
  const grouped = query.keywords.length > 1 ? `(${positive})` : positive;
  return `${grouped} ${negative}`;
}

function domainOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function isoOrNull(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

/**
 * Length ceilings mirroring `mentionSchema`'s own bounds.
 *
 * GNews's `url` doubles as both the article's identity (`externalId`,
 * `mentionSchema.externalId` is `max(300)`) and its permalink — a long slug
 * with tracking parameters can clear 300 characters easily. Bounding here,
 * where the length contract actually belongs, means an oversized value is a
 * counted `malformedCount` like any other unparseable payload, rather than a
 * `ZodError` thrown mid-batch by `mentions.ingest` — which would cost every
 * other article in the same poll its own admission. Kept as local constants,
 * not imported values, so a change to either schema's bound is a visible
 * two-file diff rather than a silent one.
 */
const MAX_EXTERNAL_ID_LENGTH = 300;
const MAX_TITLE_LENGTH = 400;
const MAX_PUBLISHER_NAME_LENGTH = 200;

/**
 * One GNews article to Lia's shape, or null.
 *
 * Null rather than throw: one unusable article must not cost a query its other
 * nine. The caller counts nulls into `malformedCount`.
 *
 * `content` is deliberately dropped. The free tier truncates it mid-sentence
 * with a "[1234 chars]" marker, and a truncated body stored as if it were the
 * article would be quoted back by the analysis layer as though complete.
 */
export function normaliseGNewsArticle(raw: unknown): ExternalArticle | null {
  if (typeof raw !== "object" || raw === null) return null;
  const article = raw as Record<string, unknown>;

  const url = typeof article.url === "string" ? article.url : null;
  const title = typeof article.title === "string" ? article.title.trim() : "";
  const publishedAt = isoOrNull(article.publishedAt);
  if (!url || !title || !publishedAt) return null;
  if (url.length > MAX_EXTERNAL_ID_LENGTH) return null;
  if (title.length > MAX_TITLE_LENGTH) return null;

  const source =
    typeof article.source === "object" && article.source !== null
      ? (article.source as Record<string, unknown>)
      : {};

  const publisherName = typeof source.name === "string" ? source.name : null;
  if (publisherName !== null && publisherName.length > MAX_PUBLISHER_NAME_LENGTH) return null;

  return {
    externalId: url,
    url,
    title,
    description:
      typeof article.description === "string" && article.description.trim()
        ? article.description.trim()
        : null,
    publisherName,
    publisherDomain: domainOf(url),
    authorName: null,
    publishedAt,
    language: null,
    metadata: {
      imageUrl: typeof article.image === "string" ? article.image : null,
      sourceUrl: typeof source.url === "string" ? source.url : null,
    },
  };
}
