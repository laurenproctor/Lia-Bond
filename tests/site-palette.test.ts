import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contrast, measured from the stylesheet rather than from a copy of it.
 *
 * The marketing palette comes from a design reference whose own values fail
 * WCAG AA in six places — the primary call to action worst, at 2.60:1 for white
 * on #FF7A2E. Those values were darkened deliberately, and the reasoning is in
 * docs/superpowers/specs/2026-08-04-marketing-site-design.md.
 *
 * This file parses `globals.css` instead of restating the hex values so that
 * there is exactly one place to change a colour. A token edited in the
 * stylesheet is measured here on the next run; a token restated in a fixture
 * would drift and the suite would pass while the site regressed.
 */

const CSS = readFileSync(
  fileURLToPath(new URL("../src/app/globals.css", import.meta.url)),
  "utf8",
);

function token(name: string): string {
  const match = CSS.match(new RegExp(`--color-site-${name}:\\s*(#[0-9a-fA-F]{6})`));
  const value = match?.[1];
  if (!value) throw new Error(`--color-site-${name} is not defined in globals.css`);
  return value;
}

/** WCAG 2.1 relative luminance. */
function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255) as [
    number,
    number,
    number,
  ];
  const [rLin, gLin, bLin] = [r, g, b].map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  ) as [number, number, number];
  return 0.2126 * rLin + 0.7152 * gLin + 0.0722 * bLin;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE = "#FFFFFF";
const AA_TEXT = 4.5;
/** WCAG 1.4.11: interactive boundaries, not ornament. */
const AA_NON_TEXT = 3;

describe("text on the white surface", () => {
  it.each([
    ["body", AA_TEXT],
    ["muted", AA_TEXT],
    ["ink", AA_TEXT],
    ["blue", AA_TEXT],
  ])("%s clears %s:1", (name, threshold) => {
    expect(contrast(token(name), WHITE)).toBeGreaterThanOrEqual(threshold);
  });
});

describe("text on the tinted section fill", () => {
  it.each(["body", "muted", "ink"])("%s clears AA on the tint", (name) => {
    expect(contrast(token(name), token("tint"))).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

describe("text on the ink surface", () => {
  it("the dark-surface muted grey clears AA", () => {
    // #8A93A3 is 2.93:1 on the tint and unusable there, but 6.19:1 on ink —
    // so it survives unchanged for footer headings and the dark pricing card.
    expect(contrast(token("muted-dark"), token("ink"))).toBeGreaterThanOrEqual(
      AA_TEXT,
    );
  });
});

describe("the primary call to action", () => {
  it("clears AA with an ink label on the brand orange", () => {
    // The reference puts white on this fill: 2.60:1, failing AA and even the
    // 3:1 large-text floor. Darkening the label instead of the fill keeps the
    // brand orange exactly as specified.
    expect(contrast(token("ink"), token("orange"))).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("still clears AA in the hover state", () => {
    expect(
      contrast(token("ink"), token("orange-hover")),
    ).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("would fail with a white label, which is why it does not have one", () => {
    expect(contrast(WHITE, token("orange"))).toBeLessThan(AA_TEXT);
  });
});

describe("interactive boundaries", () => {
  it("the form-control border clears 1.4.11", () => {
    expect(contrast(token("field"), WHITE)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });
});

describe("speech bubble metadata", () => {
  it("blue metadata clears AA on its own fill", () => {
    expect(
      contrast(token("blue-meta"), token("blue-tint")),
    ).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("amber metadata clears AA on its own fill", () => {
    expect(
      contrast(token("amber-meta"), token("amber-tint")),
    ).toBeGreaterThanOrEqual(AA_TEXT);
  });
});
