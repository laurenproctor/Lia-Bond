import type { MonitoringQuery } from "@/domain";
import { SYNDICATION_WINDOW_MS } from "@/domain/entities/monitoring";
import type { GateRejectionReason } from "@/domain/enums";
import type { ExternalArticle } from "@/news/monitor";

/**
 * Admission control for news candidates.
 *
 * A pure function: no I/O, no clock beyond the injected `now`, no model call.
 * That is what makes it cheap enough to run on every candidate, and testable
 * against a fixture corpus rather than against production noise.
 *
 * This gate deliberately does **not** write `mentions.relevance_score` (D65).
 * That column belongs to the analysis layer, which supersedes any provisional
 * number within minutes. The score here is persisted only on rejections, where
 * it is the thing being tuned.
 */

/** A headline Lia has already admitted, for syndication detection. */
export interface SeenHeadline {
  headline: string;
  seenAt: string;
}

export interface GateContext {
  query: MonitoringQuery;
  now: string;
  /** Normalised headlines admitted recently, any tenant-scoped source. */
  recentHeadlines: readonly SeenHeadline[];
}

export type GateVerdict =
  | { admitted: true; score: number; isSyndicated: false }
  | { admitted: false; score: number; reason: GateRejectionReason };

/* -------------------------------------------------------------------------- */
/* Weights                                                                     */
/*                                                                            */
/* Named constants rather than inline numbers, because these are the dials a   */
/* later workflow will turn once `news_rejected_candidates` has enough rows to */
/* judge them against. Unvalidated today, exactly as prompt quality is (D43).  */
/* -------------------------------------------------------------------------- */

const TITLE_MATCH = 0.5;
const DESCRIPTION_MATCH = 0.2;
const MULTI_KEYWORD_BONUS = 0.15;
const LOCAL_OUTLET_BONUS = 0.25;
const AMBIGUITY_PENALTY = 0.25;
/** At or below this length, a single-word term is treated as ambiguous. */
const AMBIGUOUS_TERM_MAX_LENGTH = 8;

/**
 * Reduce a headline to its comparable core.
 *
 * Two papers running the same wire story differ in quote style, casing, and
 * trailing punctuation, and in nothing else. Lowercasing and stripping
 * non-alphanumerics collapses exactly that difference.
 */
export function normaliseHeadline(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, "")
    .replace(/\s+/g, " ")
    .trim();
}

function contains(haystack: string, needle: string): boolean {
  return haystack.includes(needle.toLowerCase());
}

function isAmbiguous(term: string): boolean {
  return !term.includes(" ") && term.length <= AMBIGUOUS_TERM_MAX_LENGTH;
}

export function evaluateCandidate(
  candidate: ExternalArticle,
  context: GateContext,
): GateVerdict {
  const { query, now, recentHeadlines } = context;
  const title = candidate.title.toLowerCase();
  const description = (candidate.description ?? "").toLowerCase();
  const haystack = `${title} ${description}`;

  /* Hard rejections, strongest reason first. An article that is both excluded
   * and syndicated should report the exclusion: it is the more actionable of
   * the two, because it means the query itself wants adjusting. */

  if (query.exclusions.some((term) => contains(haystack, term))) {
    return { admitted: false, score: 0, reason: "excluded_term" };
  }

  const domain = candidate.publisherDomain ?? "";
  if (query.deniedDomains.includes(domain)) {
    return { admitted: false, score: 0, reason: "domain_denied" };
  }

  const normalised = normaliseHeadline(candidate.title);
  const nowMs = new Date(now).getTime();
  const syndicated = recentHeadlines.some(
    (seen) =>
      seen.headline === normalised &&
      nowMs - new Date(seen.seenAt).getTime() <= SYNDICATION_WINDOW_MS,
  );
  if (syndicated) {
    return { admitted: false, score: 0, reason: "probable_syndication" };
  }

  /* Scoring. */

  const inTitle = query.keywords.filter((term) => contains(title, term));
  const inDescription = query.keywords.filter((term) => contains(description, term));
  const matched = new Set([...inTitle, ...inDescription]);

  if (matched.size === 0) {
    return { admitted: false, score: 0, reason: "below_threshold" };
  }

  let score = 0;
  if (inTitle.length > 0) score += TITLE_MATCH;
  if (inDescription.length > 0) score += DESCRIPTION_MATCH;
  if (matched.size >= 2) score += MULTI_KEYWORD_BONUS;

  if (
    query.queryType === "location" &&
    query.allowedDomains.length > 0 &&
    query.allowedDomains.includes(domain)
  ) {
    score += LOCAL_OUTLET_BONUS;
  }

  // A short single-word brand matched exactly once is the classic false
  // positive: "Bond" finds the bond market long before it finds the restaurant.
  // A second matching term is what distinguishes them.
  const onlyMatch = matched.size === 1 ? [...matched][0] : null;
  if (onlyMatch && isAmbiguous(onlyMatch)) {
    score -= AMBIGUITY_PENALTY;
  }

  score = Math.min(1, Math.max(0, Number(score.toFixed(3))));

  if (score < query.relevanceThreshold) {
    return { admitted: false, score, reason: "below_threshold" };
  }
  return { admitted: true, score, isSyndicated: false };
}
