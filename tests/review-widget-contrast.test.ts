import { describe, expect, it } from "vitest";
import { WIDGET_PALETTES } from "@/lib/widgets/document";

/**
 * Contrast in the two widget palettes.
 *
 * `tests/site-palette.test.ts` measures the marketing palette from
 * `globals.css` for the reason it records: a token restated in a fixture
 * drifts, and the suite passes while the site regresses. This does the same
 * for the widget, measuring the exported palettes rather than a copy — and it
 * matters more here than anywhere else in the product, because these colours
 * are painted onto somebody *else's* website, where Lia will never see the
 * accessibility complaint that results.
 *
 * The dark palette is not the light one inverted, so both are measured in
 * full rather than one being assumed to follow from the other.
 */

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

const AA_TEXT = 4.5;
/** WCAG 1.4.3: 18px+ counts as large text. The quotation is 21px. */
const AA_LARGE = 3;
/** WCAG 1.4.11: the avatar disc's label sits on a filled shape, not on paper. */
const AA_NON_TEXT = 3;

describe.each(["light", "dark"] as const)("the %s palette", (theme) => {
  const palette = WIDGET_PALETTES[theme];

  it("puts the quotation on its surface at large-text contrast", () => {
    expect(contrast(palette.quote, palette.surface)).toBeGreaterThanOrEqual(AA_LARGE);
  });

  it("clears full AA for the reviewer's name and the body copy", () => {
    expect(contrast(palette.quote, palette.surface)).toBeGreaterThanOrEqual(AA_TEXT);
    expect(contrast(palette.body, palette.surface)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("clears AA for the date, which is the smallest text on the card", () => {
    // 13px is not large text under any reading of 1.4.3, so the muted tone
    // gets no concession.
    expect(contrast(palette.muted, palette.surface)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("clears AA for the Read on Google link", () => {
    expect(contrast(palette.link, palette.surface)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("keeps the avatar initials legible on the disc", () => {
    expect(contrast(palette.discText, palette.disc)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("gives both star states a perceivable outline", () => {
    // WCAG 1.4.11 applies: a star rating is a graphic required to understand
    // the content. The gold fill measures 1.84:1 on white and could never
    // carry this on its own, which is exactly why the stars are stroked and
    // the fill is the secondary signal rather than the only one.
    expect(contrast(palette.starOutline, palette.surface)).toBeGreaterThanOrEqual(
      AA_NON_TEXT,
    );
    expect(contrast(palette.starEmpty, palette.surface)).toBeGreaterThanOrEqual(
      AA_NON_TEXT,
    );
  });

  it("draws the card's own edge visibly against its surface", () => {
    // Not an AA requirement — a card border is ornament, not a control
    // boundary — but a border nobody can see is a border that need not exist.
    expect(contrast(palette.border, palette.surface)).toBeGreaterThan(1.05);
  });
});

describe("the two palettes are genuinely different designs", () => {
  it("does not simply invert one into the other", () => {
    // Stated as a test because the cheap thing to do when adding a theme is to
    // swap surface and text and call it done, and gold-on-near-black is a
    // deliberate choice the reference makes for a reason.
    expect(WIDGET_PALETTES.dark.surface).not.toBe(WIDGET_PALETTES.light.quote);
    expect(WIDGET_PALETTES.dark.quote).not.toBe(WIDGET_PALETTES.light.surface);
  });

  it("uses a lighter surface for light and a darker one for dark", () => {
    expect(luminance(WIDGET_PALETTES.light.surface)).toBeGreaterThan(
      luminance(WIDGET_PALETTES.dark.surface),
    );
  });
});

describe("the star rating does not depend on colour alone", () => {
  it("draws earned stars filled and the rest hollow", async () => {
    // The form carries the rating. Two colours of the same shape would be a
    // 1.4.1 failure (use of colour) as well as a contrast one, and this is the
    // assertion that stops somebody 'simplifying' the renderer back to it.
    const { renderReviewWidgetDocument } = await import("@/lib/widgets/document");
    const { resolveRenderedWidget } = await import("@/lib/widgets/render");

    const html = renderReviewWidgetDocument({
      publicId: "rw_abcdefghijklmnopqrst",
      rendered: resolveRenderedWidget({
        theme: "light",
        layout: "single_review_text",
        status: "active",
        attributionSuppressed: false,
        allowedDomains: [],
        selectionMode: "most_recent",
        reviewRating: 4,
        reviewText: "Lovely evening.",
        reviewAuthorName: "Dana R.",
        reviewPublishedAt: "2026-08-17T12:00:00.000Z",
        profileUrl: null,
        media: null,
      }),
      now: Date.parse("2026-08-20T12:00:00.000Z"),
    });

    const filled = html.match(/fill="#f5b418"/g) ?? [];
    const hollow = html.match(/fill="none" stroke="#8b939f"/g) ?? [];

    expect(filled).toHaveLength(4);
    expect(hollow).toHaveLength(1);
  });
});
