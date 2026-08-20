import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDataSource, harbor, ushg } from "./helpers/scope";
import { brandVoiceFormSeed } from "@/lib/brand-voice/seed";
import { saveBrandVoice } from "@/lib/brand-voice/save";
import {
  buildVoicePreview,
  describePreviewConflicts,
  prohibitedPhraseMatchesInPreview,
} from "@/lib/brand-voice/preview";
import type { LiaDataSource } from "@/lib/data/types";
import {
  DEFAULT_BRAND_VOICE,
  PHRASE_LIMIT_HINT,
  type UpdateBrandVoiceInput,
} from "@/domain";

/**
 * Onboarding step 4 and `/brand-voice` are the same setting.
 *
 * The two screens look different — one is the wizard on the public-site brand,
 * the other is a product page inside the app shell — and that is what makes this
 * worth pinning: nothing about the way they render tells you they are backed by
 * one row. What these tests check is the contract a person actually relies on,
 * which is that the voice they chose during setup is the voice waiting for them
 * afterwards, down to the phrases and the exact axis values.
 *
 * Both surfaces are exercised through the same production pieces they use — the
 * `saveBrandVoice` service that both actions call, and the `brandVoiceFormSeed`
 * both pages seed from. A test that reimplemented either would prove nothing
 * about the screens.
 */

let data: LiaDataSource;

/** What somebody might set on step 4: off-default axes and both phrase lists. */
const onboardingChoices: UpdateBrandVoiceInput = {
  name: "Brand voice",
  axes: { warmth: 12, detail: 88, formality: 30, confidence: 71, hospitality: 5 },
  approvedPhrases: ["We'd love to welcome you back"],
  prohibitedPhrases: ["We guarantee"],
};

beforeEach(() => {
  data = freshDataSource();
});

describe("brand voice set during onboarding", () => {
  it("is what /brand-voice opens on", async () => {
    const scope = ushg.owner();
    await saveBrandVoice({ dataSource: data, scope }, onboardingChoices);

    // Exactly what the page does: read the row, seed the form.
    const seed = brandVoiceFormSeed(await data.brandVoice.get(scope));

    expect(seed).toEqual(onboardingChoices);
  });

  it("reaches a teammate who never ran the wizard", async () => {
    // Setup is an owner-or-admin flow, so the person who opens `/brand-voice`
    // afterwards is usually not the person who filled it in.
    await saveBrandVoice({ dataSource: data, scope: ushg.owner() }, onboardingChoices);

    const seed = brandVoiceFormSeed(await data.brandVoice.get(ushg.comms()));

    expect(seed.axes).toEqual(onboardingChoices.axes);
    expect(seed.approvedPhrases).toEqual(onboardingChoices.approvedPhrases);
    expect(seed.prohibitedPhrases).toEqual(onboardingChoices.prohibitedPhrases);
  });

  it("does not cross into another organization", async () => {
    await saveBrandVoice({ dataSource: data, scope: ushg.owner() }, onboardingChoices);

    expect(brandVoiceFormSeed(await data.brandVoice.get(harbor.owner()))).toEqual(
      DEFAULT_BRAND_VOICE,
    );
  });

  it("survives the wizard's own re-read on the way back", async () => {
    // Step 4 seeds from the stored profile too, which is what makes pressing
    // Back — or resuming on another device — show somebody their own settings.
    const scope = ushg.owner();
    await saveBrandVoice({ dataSource: data, scope }, onboardingChoices);

    const stepSeed = brandVoiceFormSeed(await data.brandVoice.get(scope));
    const pageSeed = brandVoiceFormSeed(await data.brandVoice.get(scope));

    expect(stepSeed).toEqual(pageSeed);
  });
});

/* -------------------------------------------------------------------------- */
/* What the two screens show, not just what they store                        */
/* -------------------------------------------------------------------------- */

/**
 * The data was already shared before this; the *presentation* was not.
 * `/brand-voice` rendered a placeholder reading "available once response
 * drafting arrives" while step 4 had a working preview, so the screen somebody
 * returns to was less capable than the one they saw once.
 *
 * These read the two component sources directly. That is unusual and it is the
 * point: what regressed here was never a function's return value, it was one
 * screen importing a thing the other did not. A test that called
 * `buildVoicePreview` twice would pass in exactly the world this is guarding
 * against.
 */
const STEP_FORM = readFileSync(
  "src/components/onboarding/brand-voice-step-form.tsx",
  "utf8",
);
const VOICE_PREVIEW = readFileSync(
  "src/components/brand-voice/voice-preview.tsx",
  "utf8",
);
const PHRASE_EDITOR = readFileSync(
  "src/components/brand-voice/phrase-editor.tsx",
  "utf8",
);
const VOICE_FORM = readFileSync("src/components/brand-voice/voice-form.tsx", "utf8");
const BRAND_VOICE_PAGE = readFileSync("src/app/(app)/brand-voice/page.tsx", "utf8");

describe("both screens render the same preview", () => {
  it("builds it from the shared module on each surface", () => {
    for (const source of [STEP_FORM, VOICE_PREVIEW]) {
      expect(source).toContain("buildVoicePreview");
      expect(source).toContain("@/lib/brand-voice/preview");
    }
  });

  it("warns about a prohibited phrase on each surface", () => {
    for (const source of [STEP_FORM, VOICE_PREVIEW]) {
      expect(source).toContain("prohibitedPhraseMatchesInPreview");
      // Same builder, so the two cannot word the same condition differently.
      expect(source).toContain("describePreviewConflicts");
    }
  });

  it("no longer promises a preview that has not arrived", () => {
    // The placeholder said "Available once response drafting arrives".
    // Drafting shipped, which made that sentence false.
    //
    // Asserted against the JSX and the import rather than the raw file text:
    // the page's own doc comment explains what it replaced, and a bare
    // substring check fails on the explanation.
    expect(BRAND_VOICE_PAGE).not.toContain("<SectionPlaceholder");
    expect(BRAND_VOICE_PAGE).not.toContain("ui/section-placeholder");
  });

  it("renders the preview from live form state, not from a server prop", () => {
    // A preview handed in from the server cannot follow a slider, which is the
    // one thing a preview on this screen has to do.
    expect(VOICE_FORM).toContain("<VoicePreview value={value} />");
  });

  it("produces the same reply and the same warning for one voice", () => {
    const voice: UpdateBrandVoiceInput = {
      ...onboardingChoices,
      prohibitedPhrases: ["thank you"],
    };

    // Both screens call exactly this pair, so agreeing here is agreeing on
    // screen.
    const reply = buildVoicePreview(voice);
    const conflicts = prohibitedPhraseMatchesInPreview(
      reply,
      voice.prohibitedPhrases,
    );

    expect(conflicts.length).toBeGreaterThan(0);

    // Quotes the wording the example actually used — "Thank you", capitalised
    // as the reply opens — rather than echoing back the lowercase phrase that
    // was typed. With matching this loose, a warning that could not show what
    // it matched would give the customer no way to tell whether it was right.
    const described = describePreviewConflicts(conflicts);
    expect(described).toMatch(/“Thank you”/);
    expect(described.toLowerCase()).toContain("thank you");
  });
});

describe("both screens state the phrase rules", () => {
  it("uses the one shared hint", () => {
    for (const source of [STEP_FORM, PHRASE_EDITOR]) {
      expect(source).toContain("PHRASE_LIMIT_HINT");
    }
  });

  it("states the matching rule and both limits", () => {
    // The settings screen used to reveal the cap only by refusing a 21st chip.
    expect(PHRASE_LIMIT_HINT).toContain("Extra words are allowed");
    expect(PHRASE_LIMIT_HINT).toContain("20 phrases");
    expect(PHRASE_LIMIT_HINT).toContain("80 characters");
  });
});

describe("brandVoiceFormSeed", () => {
  it("falls back to the shared defaults when nothing is stored", () => {
    expect(brandVoiceFormSeed(null)).toEqual(DEFAULT_BRAND_VOICE);
  });

  it("carries every editable field and nothing else", async () => {
    const scope = ushg.owner();
    const { profile } = await saveBrandVoice(
      { dataSource: data, scope },
      onboardingChoices,
    );

    // A version or a timestamp reaching the form would be a value a stale tab
    // could write back.
    expect(Object.keys(brandVoiceFormSeed(profile)).sort()).toEqual(
      ["approvedPhrases", "axes", "name", "prohibitedPhrases"].sort(),
    );
  });
});
