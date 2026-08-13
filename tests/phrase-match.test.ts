import { describe, expect, it } from "vitest";
import {
  findPhraseMatch,
  findPhraseMatches,
  isCoveredByPhrases,
  phraseMatches,
  PHRASE_MATCH_MAX_GAP,
} from "@/domain";

/**
 * Brand-voice phrase matching.
 *
 * The behaviour customers were promised: the words they typed, in the order
 * they typed them, with extra words allowed around *and between* them. The
 * bound on "between" is the whole design — without it the rule degenerates into
 * "these words appear somewhere in this order", which matches sentences no
 * reasonable person would call a match.
 */

describe("the case this exists for", () => {
  it("covers an inserted word in the middle", () => {
    expect(phraseMatches("Thank you — it really made our day.", "it made our day")).toBe(
      true,
    );
  });

  it("still covers the phrase said exactly", () => {
    expect(phraseMatches("Thank you — it made our day.", "it made our day")).toBe(true);
  });

  it("covers extra words at either end, as a phrase match should", () => {
    expect(phraseMatches("Honestly, it made our day and then some.", "made our day")).toBe(
      true,
    );
  });
});

describe("word order", () => {
  it("requires the typed order", () => {
    expect(phraseMatches("our day was made", "made our day")).toBe(false);
  });

  it("requires every word", () => {
    expect(phraseMatches("it made our week", "it made our day")).toBe(false);
  });
});

describe("the gap bound", () => {
  it(`allows ${PHRASE_MATCH_MAX_GAP} words between consecutive words`, () => {
    expect(phraseMatches("made absolutely our day", "made our day")).toBe(true);
    expect(phraseMatches("made absolutely completely our day", "made our day")).toBe(true);
  });

  it("stops at one word past the bound, rather than drifting across a clause", () => {
    expect(phraseMatches("made a really quite long our day", "made our day")).toBe(false);
  });

  it("does not match words scattered across unrelated clauses", () => {
    expect(
      phraseMatches(
        "it was made clear that our server was having a bad day",
        "it made our day",
      ),
    ).toBe(false);
  });
});

describe("normalisation", () => {
  it("ignores case", () => {
    expect(phraseMatches("MADE OUR DAY", "made our day")).toBe(true);
  });

  it("ignores surrounding punctuation", () => {
    expect(phraseMatches("...made, our — day!", "made our day")).toBe(true);
  });

  it("treats a curly apostrophe as a straight one", () => {
    expect(phraseMatches("we’re glad", "we're glad")).toBe(true);
    expect(phraseMatches("we're glad", "we’re glad")).toBe(true);
  });

  it("keeps an apostrophe inside a word rather than splitting it", () => {
    // "were" must not satisfy "we're" — they are different words.
    expect(phraseMatches("we were glad", "we're glad")).toBe(false);
  });
});

describe("word boundaries", () => {
  it("does not match inside a longer word, which a substring check would", () => {
    // The `includes` this replaced matched here; a phrase list that fires on
    // "dayboat" when the customer wrote "day" is worse than one that misses.
    expect(phraseMatches("our dayboat scallops", "our day")).toBe(false);
    expect("our dayboat scallops".includes("our day")).toBe(true);
  });
});

describe("degenerate input", () => {
  it("never matches on a blank phrase", () => {
    expect(findPhraseMatch("anything at all", "   ")).toBeNull();
    expect(findPhraseMatch("anything at all", "")).toBeNull();
  });

  it("never matches on a phrase of pure punctuation", () => {
    expect(findPhraseMatch("anything at all", "!!! ---")).toBeNull();
  });

  it("does not match a phrase longer than the text", () => {
    expect(phraseMatches("day", "it made our day")).toBe(false);
  });
});

describe("what matched", () => {
  it("reports the span of the text, not the phrase", () => {
    const match = findPhraseMatch("Thank you — it really made our day.", "it made our day");

    expect(match).not.toBeNull();
    expect(match!.matchedText).toBe("it really made our day");
    expect(match!.phrase).toBe("it made our day");
  });

  it("reports offsets that slice back to the matched text", () => {
    const text = "Thank you — it really made our day.";
    const match = findPhraseMatch(text, "it made our day")!;

    expect(text.slice(match.start, match.end)).toBe(match.matchedText);
  });

  it("reports the earliest match when there are several", () => {
    const match = findPhraseMatch("made our day, and made our day again", "made our day")!;

    expect(match.start).toBe(0);
  });
});

describe("lists", () => {
  it("returns every matching phrase, in the order given", () => {
    const found = findPhraseMatches("it really made our day and we'll be back", [
      "made our day",
      "never said",
      "we'll be back",
    ]);

    expect(found.map((match) => match.phrase)).toEqual([
      "made our day",
      "we'll be back",
    ]);
  });

  it("reports coverage of a candidate by an existing list", () => {
    expect(isCoveredByPhrases("it really made our day", ["made our day"])).toBe(true);
    expect(isCoveredByPhrases("we'd love to see you again", ["made our day"])).toBe(false);
  });

  it("is empty for an empty list", () => {
    expect(findPhraseMatches("anything", [])).toEqual([]);
    expect(isCoveredByPhrases("anything", [])).toBe(false);
  });
});
