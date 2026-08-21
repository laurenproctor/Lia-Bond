import { describe, expect, it } from "vitest";
import { PRESS_WIDGET_PALETTES } from "@/lib/widgets/press/document";
import { resolveRenderedPressWidget } from "@/lib/widgets/press/render";
import { renderPressWidgetDocument } from "@/lib/widgets/press/document";
import { samplePressWidgetRow } from "@/lib/widgets/press/sample";

/**
 * Contrast and keyboard access in the two press palettes.
 *
 * The same job `tests/review-widget-contrast.test.ts` does, and it matters for
 * the same reason: these colours are painted onto somebody *else's* website,
 * where Lia will never see the accessibility complaint that results. The
 * palettes are measured as exported rather than restated in a fixture — a
 * token copied into a test drifts, and the suite then passes while the widget
 * regresses.
 *
 * The dark palette is not the light one inverted, so both are measured in full
 * rather than one being assumed to follow from the other.
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
/** WCAG 1.4.11: a focus ring is a non-text indicator of a control's boundary. */
const AA_NON_TEXT = 3;

describe.each(["light", "dark"] as const)("the %s press palette", (theme) => {
  const palette = PRESS_WIDGET_PALETTES[theme];

  it("clears full AA for the headline, which is the card's whole point", () => {
    // 15px bold is not large text under any reading of 1.4.3 — 18.66px is the
    // bold threshold — so the headline gets no concession.
    expect(contrast(palette.headline, palette.surface)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("clears full AA for the excerpt", () => {
    expect(contrast(palette.body, palette.surface)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("clears AA for the date, which is the smallest text on the card", () => {
    expect(contrast(palette.muted, palette.surface)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("clears AA for the eyebrow above the list", () => {
    expect(contrast(palette.eyebrow, palette.surface)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("clears AA for the Read article link", () => {
    expect(contrast(palette.link, palette.surface)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("keeps a text-fallback publisher name legible on its plate", () => {
    // The fallback is the *ordinary* rendering, not the exceptional one — no
    // real publication has a bundled mark today — so its contrast is measured
    // against the tinted plate it actually sits on rather than against the
    // card.
    expect(contrast(palette.publisher, palette.plate)).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("gives the focus ring a perceivable edge against the card", () => {
    // Both the headline anchor and "Read article" outline in `palette.link`.
    // A focus indicator nobody can see is a keyboard trap with extra steps.
    expect(contrast(palette.link, palette.surface)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });

  it("separates its stories with a rule somebody can actually see", () => {
    expect(contrast(palette.rule, palette.surface)).toBeGreaterThan(1.05);
  });

  it("draws the card's own edge visibly against its surface", () => {
    expect(contrast(palette.border, palette.surface)).toBeGreaterThan(1.05);
  });
});

describe("the two press palettes are genuinely different designs", () => {
  it("does not simply invert one into the other", () => {
    expect(PRESS_WIDGET_PALETTES.dark.surface).not.toBe(
      PRESS_WIDGET_PALETTES.light.headline,
    );
    expect(PRESS_WIDGET_PALETTES.dark.headline).not.toBe(
      PRESS_WIDGET_PALETTES.light.surface,
    );
  });

  it("uses a lighter surface for light and a darker one for dark", () => {
    expect(luminance(PRESS_WIDGET_PALETTES.light.surface)).toBeGreaterThan(
      luminance(PRESS_WIDGET_PALETTES.dark.surface),
    );
  });

  it("is not the review widget's palette wearing different names", () => {
    // A review is a quotation and a press strip is a citation list. They are
    // deliberately different objects on a page, and a shared palette is the
    // first step towards them being one.
    expect(PRESS_WIDGET_PALETTES.dark.surface).not.toBe("#12130f");
  });
});

describe("keyboard and screen-reader access", () => {
  const html = renderPressWidgetDocument({
    publicId: "pw_abcdefghijklmnopqrst",
    rendered: resolveRenderedPressWidget(
      samplePressWidgetRow("light", Date.parse("2026-09-01T12:00:00.000Z")),
    ),
  });

  it("gives every interactive element a visible focus style", () => {
    expect(html).toContain(".headline a:focus-visible");
    expect(html).toContain(".read:focus-visible");
    expect(html).not.toContain("outline: none");
  });

  it("marks the list as a list, so it is announced as one", () => {
    expect(html).toContain('<ul class="stories">');
    expect(html.match(/<li class="story">/g)).toHaveLength(3);
  });

  it("never hides a logo behind an empty alt while its name is missing", () => {
    // Either the mark carries the publication's name, or the name is a text
    // node. There is never a mark with empty alt and no adjacent name.
    expect(html).not.toContain('alt=""');
  });

  it("declares the document's language and a title", () => {
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<title>Recent press</title>");
  });

  it("adapts to a narrow column with a container query, not a viewport one", () => {
    // The frame is as wide as the customer's column, not as wide as the
    // screen, so a viewport media query measures the wrong box — a
    // phone-shaped widget in a narrow sidebar on a 27-inch monitor would never
    // trigger it.
    expect(html).toContain("@container (max-width: 460px)");
    expect(html).toContain("container-type: inline-size");
    expect(html).not.toContain("@media (max-width:");
  });

  it("respects a reduced-motion preference", () => {
    expect(html).toContain("@media (prefers-reduced-motion: no-preference)");
  });

  it("keeps a mark subordinate to the headline it sits above", () => {
    // Capped in CSS rather than per asset, so a publication that ships a
    // taller mark cannot shout over the story.
    expect(html).toContain("height: 20px");
    expect(html).toContain("object-fit: contain");
  });
});
