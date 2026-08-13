/**
 * How a brand-voice phrase is matched against text.
 *
 * Both lists — "use these" and "avoid these" — behave the way an advertiser
 * expects a Google Ads phrase-match keyword to behave: every word the customer
 * typed has to appear, in the order they typed it, and extra words may sit
 * around it. So "it made our day" is satisfied by "Thank you — it really made
 * our day."
 *
 * That example is also where this departs from Google. Google's phrase match
 * allows the extra words only at the ends; "really" lands in the *middle*,
 * which a strict phrase match would miss. This allows a small number of words
 * between the typed ones, because covering that case is the whole reason the
 * rule exists here.
 *
 * Deliberately lexical: no stemming, no synonyms, no plural folding. A rule
 * somebody can predict by looking at the words in front of them is worth more
 * on a settings screen than a cleverer one whose misses cannot be explained.
 * Matching is case-insensitive and ignores punctuation, so "Made our day!" and
 * "made our day" are one instruction rather than two.
 */

/**
 * How many words may sit between two consecutive words of a phrase.
 *
 * Two covers the intensifiers and articles that actually get slipped in — "it
 * really made our day", "made our whole entire day" — without letting a phrase
 * drift across an unrelated clause. Unbounded matching would fire "it made our
 * day" on "it was made clear our server had a bad day", which is not the same
 * sentence in any sense a customer would accept, and a phrase that matches
 * something nobody would call a match is worse than one that misses.
 */
export const PHRASE_MATCH_MAX_GAP = 2;

export interface PhraseMatch {
  /** The phrase as the customer typed it. */
  phrase: string;
  /**
   * The span of the searched text that satisfied it, verbatim.
   *
   * Carried so the interface can show *what* matched. A loose matcher that only
   * says "found it" is one the customer cannot check.
   */
  matchedText: string;
  /** Offsets into the searched text, for highlighting. */
  start: number;
  end: number;
}

interface Token {
  value: string;
  start: number;
  end: number;
}

/**
 * Words, with their offsets in the original string.
 *
 * Interior apostrophes stay attached so "we're" is one word rather than two,
 * and the curly form is folded to the straight one — a phrase typed in a text
 * editor and a reply generated elsewhere must not miss each other over a
 * character nobody can see.
 */
const WORD_PATTERN = /[\p{L}\p{N}]+(?:['’][\p{L}\p{N}]+)*/gu;

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];

  for (const match of text.matchAll(WORD_PATTERN)) {
    tokens.push({
      value: match[0].toLowerCase().replace(/’/g, "'"),
      start: match.index,
      end: match.index + match[0].length,
    });
  }

  return tokens;
}

/**
 * The first place `phrase` matches inside `text`, or null.
 *
 * Returns the earliest match, and within it takes the earliest candidate for
 * each word. Earliest is also optimal: advancing as little as possible leaves
 * the largest remaining gap budget for the words still to be placed, so a match
 * missed here is one no other choice of positions would have found.
 */
export function findPhraseMatch(text: string, phrase: string): PhraseMatch | null {
  const needle = tokenize(phrase);
  // A phrase of pure punctuation has nothing to match on. Callers get null
  // rather than a match against every possible text.
  if (needle.length === 0) return null;

  const haystack = tokenize(text);
  if (haystack.length < needle.length) return null;

  for (let start = 0; start + needle.length <= haystack.length; start += 1) {
    if (haystack[start]!.value !== needle[0]!.value) continue;

    let cursor = start;
    let matched = true;

    for (let i = 1; i < needle.length; i += 1) {
      const limit = Math.min(cursor + 1 + PHRASE_MATCH_MAX_GAP, haystack.length - 1);
      let next = -1;

      for (let j = cursor + 1; j <= limit; j += 1) {
        if (haystack[j]!.value === needle[i]!.value) {
          next = j;
          break;
        }
      }

      if (next === -1) {
        matched = false;
        break;
      }
      cursor = next;
    }

    if (matched) {
      return {
        phrase,
        matchedText: text.slice(haystack[start]!.start, haystack[cursor]!.end),
        start: haystack[start]!.start,
        end: haystack[cursor]!.end,
      };
    }
  }

  return null;
}

/** Whether `phrase` matches anywhere in `text`. */
export function phraseMatches(text: string, phrase: string): boolean {
  return findPhraseMatch(text, phrase) !== null;
}

/** Every phrase in `phrases` that matches `text`, in the order given. */
export function findPhraseMatches(
  text: string,
  phrases: readonly string[],
): PhraseMatch[] {
  const matches: PhraseMatch[] = [];

  for (const phrase of phrases) {
    const match = findPhraseMatch(text, phrase);
    if (match) matches.push(match);
  }

  return matches;
}

/**
 * Whether anything in `phrases` already covers `candidate`.
 *
 * Used to keep a list from filling with instructions that restate each other:
 * once "made our day" is on the list, "it really made our day" adds no rule
 * that was not already there.
 */
export function isCoveredByPhrases(
  candidate: string,
  phrases: readonly string[],
): boolean {
  return phrases.some((phrase) => phraseMatches(candidate, phrase));
}
