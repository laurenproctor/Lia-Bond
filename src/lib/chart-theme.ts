/**
 * Chart colour roles.
 *
 * `SERIES_COLORS` is the categorical order — assigned by slot, never cycled or
 * reordered when a filter changes the series count. The order was checked for
 * colour-vision separation and normal-vision separation against a white
 * surface; two of the slots sit under 3:1 contrast, which is why every
 * categorical chart in the app ships a labelled legend or value list.
 *
 * Status colours are reserved for sentiment and risk and never used as a
 * categorical slot.
 */

export const SERIES_COLORS = [
  "var(--color-series-1)",
  "var(--color-series-2)",
  "var(--color-series-3)",
  "var(--color-series-4)",
  "var(--color-series-5)",
] as const;

/** Resolved hex, for legends and swatches that cannot use a CSS variable. */
export const SERIES_HEX = [
  "#5b43f1",
  "#eb6834",
  "#1baf7a",
  "#2684ff",
  "#e87ba4",
] as const;

export const STATUS_COLORS = {
  positive: "var(--color-positive)",
  neutral: "var(--color-neutral)",
  negative: "var(--color-negative)",
} as const;
