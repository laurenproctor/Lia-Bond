import { BRAND_VOICE_AXES, type BrandVoiceAxes } from "@/domain";

/**
 * The voice, in plain language.
 *
 * Derived on every render rather than stored. The card exists so that somebody
 * who does not want to read five sliders can check the configuration, which a
 * stored summary would defeat the moment it drifted.
 *
 * Pure: no I/O, no framework imports.
 */

/** Band boundaries. Values at or below each threshold take that band. */
const LOW_MAX = 33;
const MIDDLE_MAX = 66;

function bandIndex(value: number): 0 | 1 | 2 {
  if (value <= LOW_MAX) return 0;
  if (value <= MIDDLE_MAX) return 1;
  return 2;
}

export function summarizeBrandVoice(axes: BrandVoiceAxes): string[] {
  return BRAND_VOICE_AXES.map((axis) => axis.bands[bandIndex(axes[axis.key])]);
}
