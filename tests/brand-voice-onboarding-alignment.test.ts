import { beforeEach, describe, expect, it } from "vitest";
import { freshDataSource, harbor, ushg } from "./helpers/scope";
import { brandVoiceFormSeed } from "@/lib/brand-voice/seed";
import { saveBrandVoice } from "@/lib/brand-voice/save";
import type { LiaDataSource } from "@/lib/data/types";
import { DEFAULT_BRAND_VOICE, type UpdateBrandVoiceInput } from "@/domain";

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
