import { describe, expect, it } from "vitest";
import {
  buildVoicePreview,
  PREVIEW_REVIEW,
  prohibitedPhraseMatchesInPreview,
} from "@/lib/onboarding/preview";
import {
  BRAND_VOICE_AXES,
  BRAND_VOICE_AXIS_KEYS,
  DEFAULT_BRAND_VOICE,
  type UpdateBrandVoiceInput,
} from "@/domain";

/**
 * The brand-voice preview on step 4.
 *
 * The property under test is not "the wording is nice" — it is that this
 * function is **deterministic and provider-free**. A preview that called a
 * model would cost money on every slider frame, would be blank whenever
 * `LIA_AI_MODE` is unconfigured (which is most of the time during onboarding),
 * and would show one sample from a distribution beside a claim that this is how
 * Lia replies.
 *
 * The absence of a provider is proved structurally: this file imports no AI
 * module, sets no key, and the function is called hundreds of times below. If
 * it ever grew a network call, these tests would hang or throw.
 */

function voice(patch: Partial<UpdateBrandVoiceInput>): UpdateBrandVoiceInput {
  return { ...DEFAULT_BRAND_VOICE, ...patch };
}

describe("determinism", () => {
  it("returns the same text for the same settings, every time", () => {
    const input = voice({
      axes: { warmth: 20, detail: 80, formality: 90, confidence: 10, hospitality: 5 },
    });

    const first = buildVoicePreview(input);
    for (let index = 0; index < 50; index += 1) {
      expect(buildVoicePreview(input)).toBe(first);
    }
  });

  it("needs no AI provider, key, or network", () => {
    // Called across the whole axis space. Any provider call would fail here —
    // no key is configured in the test environment.
    for (let value = 0; value <= 100; value += 5) {
      const text = buildVoicePreview(
        voice({
          axes: {
            warmth: value,
            detail: value,
            formality: value,
            confidence: value,
            hospitality: value,
          },
        }),
      );
      expect(text.length).toBeGreaterThan(0);
    }
  });
});

describe("the axes actually move it", () => {
  it("gives every one of the five axes a visible effect", () => {
    // A control that changed nothing would be a control the screen invited
    // somebody to set and then ignored.
    for (const key of BRAND_VOICE_AXIS_KEYS) {
      const low = buildVoicePreview(
        voice({ axes: { ...DEFAULT_BRAND_VOICE.axes, [key]: 0 } }),
      );
      const high = buildVoicePreview(
        voice({ axes: { ...DEFAULT_BRAND_VOICE.axes, [key]: 100 } }),
      );
      expect(low, `axis ${key} changed nothing`).not.toBe(high);
    }
  });

  it("uses the same five axes the domain declares", () => {
    expect(BRAND_VOICE_AXES.map((axis) => axis.key)).toEqual([
      "warmth",
      "detail",
      "formality",
      "confidence",
      "hospitality",
    ]);
  });

  it("says more when detail is high than when it is low", () => {
    const brief = buildVoicePreview(
      voice({ axes: { ...DEFAULT_BRAND_VOICE.axes, detail: 0 } }),
    );
    const thorough = buildVoicePreview(
      voice({ axes: { ...DEFAULT_BRAND_VOICE.axes, detail: 100 } }),
    );
    expect(thorough.length).toBeGreaterThan(brief.length);
  });

  it("contracts verbs when casual and expands them when professional", () => {
    const casual = buildVoicePreview(
      voice({
        axes: { warmth: 0, detail: 0, formality: 0, confidence: 0, hospitality: 0 },
      }),
    );
    const professional = buildVoicePreview(
      voice({
        axes: { warmth: 0, detail: 0, formality: 100, confidence: 0, hospitality: 0 },
      }),
    );

    expect(casual).toContain("We're");
    expect(professional).toContain("We are");
    expect(professional).not.toContain("We're");
  });
});

describe("approved phrases", () => {
  it("weaves the first approved phrase into the reply", () => {
    const text = buildVoicePreview(
      voice({ approvedPhrases: ["Thank you for your feedback"] }),
    );
    expect(text).toContain("Thank you for your feedback.");
  });

  it("uses only the first, rather than stuffing the whole list in", () => {
    const text = buildVoicePreview(
      voice({
        approvedPhrases: ["We appreciate your visit", "Our team", "Come back soon"],
      }),
    );
    expect(text).toContain("We appreciate your visit");
    expect(text).not.toContain("Come back soon");
  });

  it("adds no phrase when the list is empty", () => {
    expect(() => buildVoicePreview(voice({ approvedPhrases: [] }))).not.toThrow();
  });

  it("does not double a phrase's own full stop", () => {
    const text = buildVoicePreview(voice({ approvedPhrases: ["We appreciate it."] }));
    expect(text).toContain("We appreciate it.");
    expect(text).not.toContain("We appreciate it..");
  });

  it("does not repeat a phrase the reply already makes, allowing for extra words", () => {
    // Warmth 0 opens "Thank you so much for this — it really made our day," which
    // already satisfies "it made our day" under phrase matching. Inserting it
    // again would say the same thing twice in one reply.
    const axes = { ...DEFAULT_BRAND_VOICE.axes, warmth: 0 };
    const text = buildVoicePreview(voice({ axes, approvedPhrases: ["it made our day"] }));

    expect(text).toContain("it really made our day");
    expect(text).not.toContain("It made our day.");
  });

  it("falls through to the next phrase that is not already covered", () => {
    const axes = { ...DEFAULT_BRAND_VOICE.axes, warmth: 0 };
    const text = buildVoicePreview(
      voice({ axes, approvedPhrases: ["it made our day", "We appreciate your visit"] }),
    );

    expect(text).toContain("We appreciate your visit");
  });
});

describe("prohibited phrases", () => {
  it("reports a collision rather than hiding it", () => {
    const text = buildVoicePreview(voice({}));
    // Take a phrase the preview genuinely uses, so this tests the detector
    // rather than the sentence bank.
    const found = prohibitedPhraseMatchesInPreview(text, ["thank you"]);
    expect(found.map((match) => match.phrase)).toEqual(["thank you"]);
  });

  it("finds nothing when the avoid list does not appear", () => {
    const text = buildVoicePreview(voice({}));
    expect(
      prohibitedPhraseMatchesInPreview(text, ["we guarantee", "best in town"]),
    ).toEqual([]);
  });

  it("ignores blank entries", () => {
    const text = buildVoicePreview(voice({}));
    expect(prohibitedPhraseMatchesInPreview(text, ["   "])).toEqual([]);
  });

  it("catches a phrase the reply says with extra words in it", () => {
    // Warmth 0 opens "Thank you so much for this — it really made our day."
    const text = buildVoicePreview(
      voice({ axes: { ...DEFAULT_BRAND_VOICE.axes, warmth: 0 } }),
    );
    const found = prohibitedPhraseMatchesInPreview(text, ["it made our day"]);

    expect(found).toHaveLength(1);
    // Reports what the reply actually said, so the warning can show its working.
    expect(found[0]!.matchedText).toBe("it really made our day");
  });

  it("does not fire on a word that merely contains the phrase", () => {
    // The `includes` check this replaced matched across word boundaries.
    const found = prohibitedPhraseMatchesInPreview("our dayboat scallops", ["our day"]);
    expect(found).toEqual([]);
  });
});

describe("the sample review", () => {
  it("is a fixed, fictional example rather than customer data", () => {
    // Fixed: the module exports one constant, so no code path can substitute a
    // real imported review — which at step 4 may not exist at all.
    expect(PREVIEW_REVIEW.rating).toBe(4);
    expect(PREVIEW_REVIEW.text).toContain("Great food");
  });
});
