import { describe, expect, it } from "vitest";
import {
  BRAND_VOICE_AXES,
  BRAND_VOICE_AXIS_KEYS,
  DEFAULT_BRAND_VOICE,
  updateBrandVoiceInputSchema,
} from "@/domain";

/**
 * Brand voice input validation.
 *
 * The contradiction rule is the one that matters: a phrase in both lists
 * reaches generation as an instruction that cannot be satisfied.
 */

const valid = {
  name: "Maison Laurent voice",
  axes: { warmth: 45, detail: 40, formality: 55, confidence: 44, hospitality: 35 },
  approvedPhrases: ["thank you for sharing"],
  prohibitedPhrases: ["not our fault"],
};

describe("axis taxonomy", () => {
  it("declares one axis per key, in the same order", () => {
    expect(BRAND_VOICE_AXES.map((axis) => axis.key)).toEqual([...BRAND_VOICE_AXIS_KEYS]);
  });

  it("gives every axis three bands and two pole labels", () => {
    for (const axis of BRAND_VOICE_AXES) {
      expect(axis.bands).toHaveLength(3);
      expect(axis.leftLabel.length).toBeGreaterThan(0);
      expect(axis.rightLabel.length).toBeGreaterThan(0);
    }
  });
});

describe("axis values", () => {
  it("accepts the boundaries", () => {
    for (const value of [0, 100]) {
      const axes = { warmth: value, detail: value, formality: value, confidence: value, hospitality: value };
      expect(updateBrandVoiceInputSchema.parse({ ...valid, axes }).axes.warmth).toBe(value);
    }
  });

  it("rejects a value outside 0 to 100", () => {
    const axes = { ...valid.axes, warmth: 101 };
    expect(() => updateBrandVoiceInputSchema.parse({ ...valid, axes })).toThrow();
  });

  it("rejects a fractional value", () => {
    const axes = { ...valid.axes, warmth: 44.5 };
    expect(() => updateBrandVoiceInputSchema.parse({ ...valid, axes })).toThrow();
  });
});

describe("phrase lists", () => {
  it("trims and drops blank entries", () => {
    const parsed = updateBrandVoiceInputSchema.parse({
      ...valid,
      approvedPhrases: ["  we're here to help  ", "   ", ""],
    });
    expect(parsed.approvedPhrases).toEqual(["we're here to help"]);
  });

  it("removes duplicates case-insensitively, keeping the first spelling", () => {
    const parsed = updateBrandVoiceInputSchema.parse({
      ...valid,
      approvedPhrases: ["Thank you", "thank YOU", "thank you "],
    });
    expect(parsed.approvedPhrases).toEqual(["Thank you"]);
  });

  it("rejects a phrase over 80 characters", () => {
    expect(() =>
      updateBrandVoiceInputSchema.parse({ ...valid, approvedPhrases: ["x".repeat(81)] }),
    ).toThrow();
  });

  it("rejects more than 20 phrases in a list", () => {
    const many = Array.from({ length: 21 }, (_, index) => `phrase ${index}`);
    expect(() =>
      updateBrandVoiceInputSchema.parse({ ...valid, approvedPhrases: many }),
    ).toThrow();
  });

  it("rejects a phrase present in both lists", () => {
    expect(() =>
      updateBrandVoiceInputSchema.parse({
        ...valid,
        approvedPhrases: ["We appreciate the feedback"],
        prohibitedPhrases: ["we appreciate the feedback"],
      }),
    ).toThrow(/both/i);
  });

  it("allows both lists to be empty", () => {
    const parsed = updateBrandVoiceInputSchema.parse({
      ...valid,
      approvedPhrases: [],
      prohibitedPhrases: [],
    });
    expect(parsed.approvedPhrases).toEqual([]);
    expect(parsed.prohibitedPhrases).toEqual([]);
  });
});

describe("defaults", () => {
  it("are themselves valid input", () => {
    expect(() => updateBrandVoiceInputSchema.parse(DEFAULT_BRAND_VOICE)).not.toThrow();
  });

  it("start with no phrases, so nothing is asserted on a new organization's behalf", () => {
    expect(DEFAULT_BRAND_VOICE.approvedPhrases).toEqual([]);
    expect(DEFAULT_BRAND_VOICE.prohibitedPhrases).toEqual([]);
  });
});
