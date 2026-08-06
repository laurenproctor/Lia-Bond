import { describe, expect, it } from "vitest";
import { BRAND_VOICE_AXES, type BrandVoiceAxes } from "@/domain";
import { summarizeBrandVoice } from "@/lib/brand-voice/summary";

/**
 * The summary is derived rather than stored so it cannot disagree with the
 * sliders. These tests pin the band boundaries, which are the only place that
 * derivation can go subtly wrong.
 */

function axesAt(value: number): BrandVoiceAxes {
  return {
    warmth: value,
    detail: value,
    formality: value,
    confidence: value,
    hospitality: value,
  };
}

describe("summarizeBrandVoice", () => {
  it("returns one line per axis, in taxonomy order", () => {
    const lines = summarizeBrandVoice(axesAt(50));
    expect(lines).toHaveLength(BRAND_VOICE_AXES.length);
  });

  it("uses the low band at and below 33", () => {
    expect(summarizeBrandVoice(axesAt(0))[0]).toBe(BRAND_VOICE_AXES[0]?.bands[0]);
    expect(summarizeBrandVoice(axesAt(33))[0]).toBe(BRAND_VOICE_AXES[0]?.bands[0]);
  });

  it("uses the middle band from 34 to 66", () => {
    expect(summarizeBrandVoice(axesAt(34))[0]).toBe(BRAND_VOICE_AXES[0]?.bands[1]);
    expect(summarizeBrandVoice(axesAt(66))[0]).toBe(BRAND_VOICE_AXES[0]?.bands[1]);
  });

  it("uses the high band from 67 up", () => {
    expect(summarizeBrandVoice(axesAt(67))[0]).toBe(BRAND_VOICE_AXES[0]?.bands[2]);
    expect(summarizeBrandVoice(axesAt(100))[0]).toBe(BRAND_VOICE_AXES[0]?.bands[2]);
  });

  it("describes each axis independently", () => {
    const mixed: BrandVoiceAxes = {
      warmth: 0,
      detail: 100,
      formality: 50,
      confidence: 0,
      hospitality: 100,
    };
    const lines = summarizeBrandVoice(mixed);

    expect(lines[0]).toBe(BRAND_VOICE_AXES[0]?.bands[0]);
    expect(lines[1]).toBe(BRAND_VOICE_AXES[1]?.bands[2]);
    expect(lines[2]).toBe(BRAND_VOICE_AXES[2]?.bands[1]);
  });

  it("produces no empty lines for any value in range", () => {
    for (let value = 0; value <= 100; value += 1) {
      for (const line of summarizeBrandVoice(axesAt(value))) {
        expect(line.length).toBeGreaterThan(0);
      }
    }
  });
});
