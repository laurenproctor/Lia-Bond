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
  | { admitted: true; score: number }
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

/**
 * At or below this length, and with no internal space, a matched term is
 * treated as ambiguous — a name shared with something else in the world
 * ("Bond", "Odo", "Zuma") rather than a phrase unlikely to occur by
 * coincidence ("Gramercy Tavern").
 *
 * DECISION: length is a weak proxy. It also catches legitimate one-word
 * brands — Nobu, Odo, Zuma, Semma, Estela, Carbone, Chipotle — exactly as
 * readily as it catches "Bond". Below, a term flagged ambiguous and matched
 * alone is *rejected* unless corroborated (see `evaluateCandidate`), so
 * those legitimate brands need a second keyword or an `allowedDomains` entry
 * to be admitted on their own name. That is an acceptable v1 position only
 * because the rejection is logged with its reason (D64) and is therefore
 * discoverable and tunable — it must not be read as "short brand names work
 * fine here."
 */
const AMBIGUOUS_TERM_MAX_LENGTH = 8;

/**
 * Reduce a headline to its comparable core.
 *
 * Two papers running the same wire story differ in quote style, casing,
 * dash/whitespace formatting, and Unicode normalisation form, and in nothing
 * else. `.normalize("NFC")` collapses composed vs. decomposed accents (NFD
 * "café" vs. NFC "café") to one representation; lowercasing and replacing
 * everything but letters, digits, and whitespace *with a space* — not
 * deletion, since "Reopens—Again" and "Reopens — Again" must collapse to the
 * same string, which deleting the dash instead of spacing it would not
 * guarantee — removes the rest.
 *
 * DECISION: this is exact-match syndication detection. It will not catch a
 * wire story a second outlet re-headlines ("… reopens" vs. "… reopens |
 * Reuters", or a locally rewritten headline covering the same story), so
 * some real syndication slips through as independent coverage. The inverse
 * risk also exists: two genuinely different stories that happen to share a
 * generic headline within the 72-hour window collapse into one. For a
 * multi-location restaurant group — the target customer — a generic headline
 * ("X opens new location") recurring across unrelated locations is a live
 * risk, not a hypothetical. Fuzzy matching is future work; today this trades
 * some false negatives and a smaller number of false positives for a
 * mechanism simple enough to reason about and test deterministically.
 */
export function normaliseHeadline(title: string): string {
  return title
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

const CURLY_SINGLE_QUOTES = /[‘’ʼ′]/g;
const CURLY_DOUBLE_QUOTES = /[“”″]/g;

/**
 * Reduce text to its comparable core for *keyword* matching.
 *
 * Deliberately lighter-touch than `normaliseHeadline`: it folds exactly the
 * differences that would otherwise cause a silent, indistinguishable-from-
 * "no match" drop — curly vs. straight quotes ("Lucali's" vs. "Lucali’s"),
 * doubled whitespace, non-breaking spaces (`\s` in a JS regex already matches
 * U+00A0), and composed vs. decomposed accents (`.normalize("NFC")`, the same
 * reason `normaliseHeadline` calls it) — but keeps every other character. It
 * does not strip punctuation the way `normaliseHeadline` does, so "GRAMERCY
 * TAVERN'S NEW CHEF" still contains "gramercy tavern" as a substring,
 * preserving the existing case-insensitive substring behaviour.
 */
function normaliseForMatch(value: string): string {
  return value
    .normalize("NFC")
    .toLowerCase()
    .replace(CURLY_SINGLE_QUOTES, "'")
    .replace(CURLY_DOUBLE_QUOTES, '"')
    .replace(/\s+/g, " ")
    .trim();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Whether `rawTerm` occurs in already-normalised `haystackNorm` as a whole
 * word.
 *
 * Uses Unicode-aware lookarounds instead of `\b`: JavaScript's `\b` is
 * defined against `[A-Za-z0-9_]` only, so a boundary next to an accented
 * letter ("café"), a non-Latin letter ("некролог"), or a punctuation-
 * terminated term ("R.I.P.") does not register as a boundary at all — the
 * exclusion then fails to match, and fails *open*: the article is admitted
 * and nothing in the rejection log explains why the operator's exclusion did
 * nothing. `(?<![\p{L}\p{N}_])` / `(?![\p{L}\p{N}_])` treat any letter or
 * digit in any script as a word character, closing that gap.
 */
function matchesWholeWord(haystackNorm: string, rawTerm: string): boolean {
  const needle = normaliseForMatch(rawTerm);
  if (needle.length === 0) return false;
  const pattern = new RegExp(
    `(?<![\\p{L}\\p{N}_])${escapeRegExp(needle)}(?![\\p{L}\\p{N}_])`,
    "u",
  );
  return pattern.test(haystackNorm);
}

/** Whether `rawTerm` occurs anywhere in already-normalised `haystackNorm`. */
function includesTerm(haystackNorm: string, rawTerm: string): boolean {
  return haystackNorm.includes(normaliseForMatch(rawTerm));
}

/** Exact match, or `domain` is a subdomain of `entry` on a dot boundary. */
function domainMatches(domain: string, entries: readonly string[]): boolean {
  return entries.some((entry) => domain === entry || domain.endsWith(`.${entry}`));
}

function isAmbiguous(term: string): boolean {
  return !term.includes(" ") && term.length <= AMBIGUOUS_TERM_MAX_LENGTH;
}

/**
 * Collapse keyword matches that are the same underlying evidence.
 *
 * Two matched keywords that differ only in case ("Bond" / "bond") are the
 * same term observed twice. A matched keyword wholly contained in a *longer*
 * matched keyword ("Bond" / "Bond NYC", when the text contains "Bond NYC")
 * is the same span of text counted twice. Neither is a second, independent
 * piece of evidence — an operator who lists both a short name and a longer
 * variant must not be able to manufacture free corroboration for the short
 * one, which is exactly what the multi-keyword bonus and the ambiguity
 * corroboration rule below are meant to require. Only the longer term of any
 * such pair survives.
 */
function distinctSignals(rawTerms: readonly string[]): Set<string> {
  const normalised = [...new Set(rawTerms.map((term) => normaliseForMatch(term)))];
  return new Set(
    normalised.filter(
      (term) =>
        !normalised.some(
          (other) =>
            other !== term && other.includes(term) && other.length > term.length,
        ),
    ),
  );
}

function parseTimestamp(value: string, label: string): number {
  const ms = new Date(value).getTime();
  if (Number.isNaN(ms)) {
    // A pure function cannot silently swallow bad input: an unparseable
    // timestamp previously made every syndication comparison `NaN`-false,
    // which disables the check without ever saying so. Failing loudly here
    // makes it the caller's contract violation to fix, not the gate's to
    // absorb.
    throw new RangeError(
      `evaluateCandidate: ${label} is not a valid ISO timestamp: ${JSON.stringify(value)}`,
    );
  }
  return ms;
}

export function evaluateCandidate(
  candidate: ExternalArticle,
  context: GateContext,
): GateVerdict {
  const { query, now, recentHeadlines } = context;
  const nowMs = parseTimestamp(now, "context.now");

  const titleNorm = normaliseForMatch(candidate.title);
  const descriptionNorm = normaliseForMatch(candidate.description ?? "");

  /* Hard rejections that need no score: an excluded term or a denied domain
   * mean the query itself is wrong for this source, independent of how well
   * anything else matches. Checked on each field separately — concatenating
   * title and description first would let a multi-word exclusion match
   * across the join between them, an occurrence that exists nowhere in the
   * actual text — and on word boundaries, so a short exclusion like "bar"
   * does not reject "barbecue". (GNews receives these same exclusions as
   * `NOT "term"`, a token-level match — see `src/news/gnews/normalise.ts` —
   * so word-boundary matching here narrows the gap but the provider's
   * tokeniser and this regex remain two different implementations of
   * "word".) */

  if (
    query.exclusions.some(
      (term) => matchesWholeWord(titleNorm, term) || matchesWholeWord(descriptionNorm, term),
    )
  ) {
    return { admitted: false, score: 0, reason: "excluded_term" };
  }

  const domain = candidate.publisherDomain ?? "";
  if (domainMatches(domain, query.deniedDomains)) {
    return { admitted: false, score: 0, reason: "domain_denied" };
  }

  /* Scoring. */

  const inTitle = query.keywords.filter((term) => includesTerm(titleNorm, term));
  const inDescription = query.keywords.filter((term) => includesTerm(descriptionNorm, term));
  const matched = distinctSignals([...inTitle, ...inDescription]);

  if (matched.size === 0) {
    // Genuinely nothing matched. Score 0 here means exactly that — distinct
    // from the ambiguity rejection below, which reports a real, nonzero
    // score even though it also rejects. Conflating the two would leave
    // `news_rejected_candidates` unable to tell "irrelevant" from "plausible
    // but unconfirmed", which is the reason the row exists at all (D64).
    return { admitted: false, score: 0, reason: "below_threshold" };
  }

  let score = 0;
  if (inTitle.length > 0) score += TITLE_MATCH;
  if (inDescription.length > 0) score += DESCRIPTION_MATCH;
  if (matched.size >= 2) score += MULTI_KEYWORD_BONUS;

  const isLocalOutlet =
    query.queryType === "location" &&
    query.allowedDomains.length > 0 &&
    domainMatches(domain, query.allowedDomains);
  if (isLocalOutlet) score += LOCAL_OUTLET_BONUS;

  score = Math.min(1, Math.max(0, Number(score.toFixed(3))));

  /* Ambiguity corroboration.
   *
   * A short single-word brand matched exactly once is the classic false
   * positive: "Bond" finds the bond market long before it finds the
   * restaurant, and it finds it just as fast whether "Bond" appears once or
   * is repeated across the title and the description — repetition of the
   * *same* term is the same evidence, not corroboration. This is therefore a
   * hard requirement, not an additive penalty: no score can buy its way past
   * ambiguity just by matching in more fields. What does count as
   * corroboration is either a second, distinct matched keyword ("Bond" +
   * "Union Square") or the publisher being on the query's `allowedDomains`
   * list — the locality signal the schema itself names. Without either, the
   * candidate is rejected regardless of the numeric score or threshold, and
   * the rejection carries the real score rather than zero (see above). */
  const [singleMatch] = matched;
  const onlyMatch = matched.size === 1 ? singleMatch : undefined;
  if (onlyMatch !== undefined && isAmbiguous(onlyMatch)) {
    // Deliberately not gated on `query.queryType === "location"`, unlike
    // `LOCAL_OUTLET_BONUS` above: an operator who explicitly allow-lists a
    // publisher domain has given corroborating evidence regardless of what
    // kind of query they set up, and this rejection has nothing to do with
    // the location-outlet scoring bonus. Do not "fix" this to match
    // `isLocalOutlet`'s condition — the asymmetry is intentional.
    const locallyCorroborated =
      query.allowedDomains.length > 0 && domainMatches(domain, query.allowedDomains);
    if (!locallyCorroborated) {
      return { admitted: false, score, reason: "below_threshold" };
    }
  }

  /*
   * DECISION: a description-only match (0.2) never clears the default
   * threshold (0.35) on its own. A piece headlined on the chef, naming the
   * restaurant only in the summary, is dropped by a plain brand query.
   * `MONITORING_QUERY_TYPES` includes "person" precisely so the chef can be
   * watched as their own query rather than relying on the restaurant's
   * description-only signal — and Task 8's mock fixture set (see the
   * "description-only" comment in `src/news/mock-monitor.ts`) frames the
   * same case as one "a naive title-only scan would miss," which reads as
   * an expectation that the gate admits it. It does not, by design: a lone
   * description mention is weak signal on its own, and the two framings are
   * reconciled here — the mock fixture exists to be handled sensibly (i.e.
   * scored lower and, by default, rejected with a legible reason), not to
   * be admitted outright. A query that wants it needs a second keyword, a
   * `person` query for the chef, or a lowered threshold.
   */
  if (score < query.relevanceThreshold) {
    return { admitted: false, score, reason: "below_threshold" };
  }

  /* Syndication is checked last, and only against a candidate that would
   * otherwise be admitted on content. An article that matches no keyword but
   * happens to share a headline with something recently seen is "below
   * threshold", full stop — reporting it as `probable_syndication` instead
   * would credit the gate with having found a relevant duplicate when it
   * found nothing relevant at all, polluting the rejection data the gate
   * depends on to be tunable. */
  const normalisedHeadline = normaliseHeadline(candidate.title);
  const syndicated = recentHeadlines.some((seen) => {
    const seenMs = parseTimestamp(seen.seenAt, "recentHeadlines[].seenAt");
    return seen.headline === normalisedHeadline && nowMs - seenMs <= SYNDICATION_WINDOW_MS;
  });
  if (syndicated) {
    return { admitted: false, score, reason: "probable_syndication" };
  }

  return { admitted: true, score };
}
