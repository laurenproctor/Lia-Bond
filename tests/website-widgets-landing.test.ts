import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { isNavItemActive, NAV_SECTIONS, type NavItem } from "@/lib/navigation";
import { renderReviewWidgetDocument } from "@/lib/widgets/document";
import { renderPressWidgetDocument } from "@/lib/widgets/press/document";
import { resolveRenderedPressWidget } from "@/lib/widgets/press/render";
import { samplePressWidgetRow } from "@/lib/widgets/press/sample";
import { resolveRenderedWidget } from "@/lib/widgets/render";
import {
  REVIEW_WIDGET_LAYOUTS,
  SAVABLE_REVIEW_WIDGET_LAYOUTS,
  type ReviewWidgetLayout,
} from "@/domain";
import { sampleReviewWidgetRow } from "@/lib/widgets/sample";

/**
 * The Website widgets landing page, and the routes around it.
 *
 * This suite is deliberately two halves, because the page has two kinds of
 * claim to make and only one of them is testable the ordinary way.
 *
 * **The samples are real.** Both cards frame the two real renderers through
 * their sample branches, so the first half runs those renderers and asserts
 * what they produce — which is the property the page exists for. A screenshot
 * or a React imitation would satisfy a visual check on the day it was written
 * and go stale silently.
 *
 * **The page's structure is asserted from its source.** There is no DOM in
 * this suite (see `vitest.config.mts`), so the second half reads the page
 * module and pins the facts that would otherwise only be caught by opening a
 * browser: two cards, two calls to action, the right destinations, and the
 * header copy. The same technique the SQL-mirror tests use, and it earns its
 * keep for the same reason — the alternative is nothing at all.
 */

const ROOT = resolve(process.cwd());
const LANDING = join(ROOT, "src", "app", "(app)", "integrations", "website-widgets", "page.tsx");

const NOW = Date.parse("2026-09-01T12:00:00.000Z");

/* -------------------------------------------------------------------------- */
/* Both samples, through the real renderers                                    */
/* -------------------------------------------------------------------------- */

describe("the review sample the landing page frames", () => {
  const html = renderReviewWidgetDocument({
    publicId: "sample",
    rendered: resolveRenderedWidget(sampleReviewWidgetRow("light", "single_review_text", NOW)),
    now: NOW,
  });

  it("is a complete widget document, drawn by the shipping renderer", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("Google Review");
  });

  it("shows five stars, a reviewer, a relative date, and the Lia line", () => {
    expect(html).toContain('aria-label="Rated 5 out of 5"');
    expect(html).toContain("Danielle W.");
    expect(html).toContain("1 week ago");
    expect(html).toContain("Powered by <strong>Lia</strong>");
  });

  it("carries Google's attribution and a link that actually resolves", () => {
    // A fabricated `?cid=` would be a link to a business that does not exist,
    // which is worse than no link at all.
    expect(html).toContain("Read on Google");
    expect(html).toContain('href="https://www.google.com/maps"');
  });

  it("offers all three arrangements, drawn by the shipping renderer", () => {
    // The card hosts `ReviewWidgetLayoutCarousel`, so the page can show what a
    // review widget can look like — not only the one arrangement a customer
    // can publish today.
    for (const layout of REVIEW_WIDGET_LAYOUTS) {
      const slide = renderReviewWidgetDocument({
        publicId: "sample",
        rendered: resolveRenderedWidget(sampleReviewWidgetRow("light", layout, NOW)),
        now: NOW,
      });
      expect(slide, layout).toContain("<blockquote>");
    }
  });

  it("draws media on the two arrangements that have it, and none on the text card", () => {
    const media = (layout: ReviewWidgetLayout) =>
      renderReviewWidgetDocument({
        publicId: "sample",
        rendered: resolveRenderedWidget(sampleReviewWidgetRow("light", layout, NOW)),
        now: NOW,
      }).includes('class="media"');

    expect(media("single_review_text")).toBe(false);
    expect(media("single_review_photo")).toBe(true);
    expect(media("single_review_video")).toBe(true);
  });

  it("still opens on the text card, which is the one a customer can embed", () => {
    // The carousel starts at index 0 and `REVIEW_WIDGET_LAYOUTS` leads with
    // the savable one, so the first thing a visitor sees is the product they
    // can actually buy. Pinned because it is an ordering dependency between
    // two files and nothing else would notice it changing.
    expect(REVIEW_WIDGET_LAYOUTS[0]).toBe("single_review_text");
    expect(SAVABLE_REVIEW_WIDGET_LAYOUTS).toEqual(["single_review_text"]);
    expect(html).not.toContain('class="media"');
  });

  it("renders in the dark theme too, since the card offers the choice", () => {
    const dark = renderReviewWidgetDocument({
      publicId: "sample",
      rendered: resolveRenderedWidget(sampleReviewWidgetRow("dark", "single_review_text", NOW)),
      now: NOW,
    });
    expect(dark).toContain("color-scheme: dark");
    expect(dark).not.toBe(html);
  });
});

describe("the press sample the landing page frames", () => {
  const html = renderPressWidgetDocument({
    publicId: "sample",
    rendered: resolveRenderedPressWidget(samplePressWidgetRow("light", NOW)),
  });

  it("is a complete widget document, drawn by the shipping renderer", () => {
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("In the press");
  });

  it("shows three clearly invented stories from three publications", () => {
    expect(html.match(/<li class="story">/g)).toHaveLength(3);
    expect(html).toContain("The Harbour Ledger");
    expect(html).toContain("Meridian Table");
    expect(html).toContain("Northside Dispatch");
  });

  it("draws every publication as a bundled mark, not a text fallback", () => {
    // The point of putting the sample here is to show what the widget looks
    // like *with logos in it*. Three text fallbacks would be a different
    // product.
    expect(html.match(/<img class="logo"/g)).toHaveLength(3);
    expect(html).not.toContain('class="publisher"');
  });

  it("shows a headline, an excerpt, a date, and a link on each story", () => {
    expect(html.match(/class="headline"/g)).toHaveLength(3);
    expect(html.match(/class="excerpt"/g)).toHaveLength(3);
    expect(html.match(/class="when"/g)).toHaveLength(3);
    expect(html.match(/Read article/g)).toHaveLength(3);
  });

  it("carries the Lia line", () => {
    expect(html).toContain("Powered by <strong>Lia</strong>");
  });

  it("renders in the dark theme too, with the dark marks", () => {
    const dark = renderPressWidgetDocument({
      publicId: "sample",
      rendered: resolveRenderedPressWidget(samplePressWidgetRow("dark", NOW)),
    });
    expect(dark).toContain("color-scheme: dark");
    expect(dark.match(/-dark\.v1\.svg/g)).toHaveLength(3);
  });

  it("is visibly a different object from the review sample", () => {
    // A visitor has to tell the two apart in under five seconds. A press card
    // is a citation list; a review card is a quotation.
    expect(html).not.toContain("<blockquote>");
    expect(html).not.toContain("Google Review");
  });
});

/* -------------------------------------------------------------------------- */
/* The page                                                                    */
/* -------------------------------------------------------------------------- */

describe("the landing page", () => {
  const source = readFileSync(LANDING, "utf8");

  it("exists at /integrations/website-widgets", () => {
    expect(existsSync(LANDING)).toBe(true);
  });

  it("carries the header the product brief specifies", () => {
    expect(source).toContain('title="Website widgets"');
    expect(source).toContain(
      "Turn the reputation Lia monitors into credible proof on your website.",
    );
  });

  it("shows two product cards, one per widget", () => {
    expect(source).toContain('kind="review"');
    expect(source).toContain('kind="press"');
    expect(source.match(/<WebsiteWidgetSampleCard/g)).toHaveLength(2);
  });

  it("names each product plainly", () => {
    expect(source).toContain('title="Review widget"');
    expect(source).toContain('title="Recent press widget"');
  });

  it("frames the real sample renderers rather than a screenshot", () => {
    expect(source).toContain("/embed/review-widget/preview?sample=1");
    expect(source).toContain("/embed/press-widget/preview?sample=1");
    expect(source).not.toMatch(/\.png|\.jpg|\.webp/);
  });

  it("offers the layout carousel on the review card only", () => {
    // The press widget has exactly one layout — `recent_press_list` — so a
    // one-tab carousel there would imply a choice nobody has.
    expect(source).toContain("layouts={{");
    expect(source.match(/layouts=\{\{/g)).toHaveLength(1);
  });

  it("never shows a media arrangement without saying it cannot be embedded", () => {
    // The single most important honesty property on this page: two of the
    // three arrangements cannot go on a customer's website today, and this is
    // the screen where somebody decides whether to buy the feature. The
    // carousel only renders the note when a slide is outside
    // `SAVABLE_REVIEW_WIDGET_LAYOUTS`, so passing one is what makes the
    // guarantee structural rather than a rule somebody has to remember.
    expect(source).toContain("unavailableNote:");
    const note = source.match(/unavailableNote:\s*"([^"]+)"/)?.[1] ?? "";
    expect(note.length).toBeGreaterThan(10);
    expect(note.toLowerCase()).toContain("embed");
  });

  it("sends each call to action to its own configurator", () => {
    expect(source).toContain('ctaLabel="Set up review widget"');
    expect(source).toContain('ctaHref="/integrations/review-widget"');
    expect(source).toContain('ctaLabel="Set up press widget"');
    expect(source).toContain('ctaHref="/integrations/press-widget"');
  });

  it("says in plain text that both samples are invented", () => {
    expect(source).toContain("is an example, written by us");
    expect(source).toContain("are invented");
  });

  it("lists the four shared capabilities and nothing more", () => {
    for (const capability of [
      "Light and dark themes",
      "Responsive on any screen",
      "Approved-domain controls",
      "Automatically stays current",
    ]) {
      expect(source, capability).toContain(capability);
    }
  });

  it("stacks the two cards on a narrow screen and sits them side by side on desktop", () => {
    expect(source).toContain("lg:grid-cols-2");
    expect(source).toContain("items-stretch");
  });

  it("puts neither configurator on the page", () => {
    // A visitor is choosing, not configuring. A configurator here would make
    // one of the two the product and the other a link somebody might miss.
    expect(source).not.toContain("Configurator");
    expect(source).not.toContain("EmbedPanel");
  });

  it("reads no tenant data, so it answers before organization context", () => {
    for (const forbidden of ["getOrganizationContext", "getDataSource", "scope"]) {
      expect(source, forbidden).not.toContain(forbidden);
    }
  });

  it("is not a marketing page", () => {
    // `CLAUDE.md`: no ornamental gradients, no oversized illustrations, no
    // animation for its own sake.
    expect(source).not.toMatch(/gradient|animate-|<video|hero/i);
  });
});

describe("the sample card", () => {
  const source = readFileSync(
    join(ROOT, "src", "components", "integrations", "website-widget-sample-card.tsx"),
    "utf8",
  );

  it("offers a light and dark control that changes only the sample", () => {
    expect(source).toContain("aria-pressed={theme === option}");
    expect(source).toContain('(["light", "dark"] as const)');
    // Each button carries its own name for a screen reader, since the icon
    // alone says nothing.
    expect(source).toContain('<span className="sr-only">{option} theme</span>');
  });

  it("gives every control and frame an accessible name", () => {
    expect(source).toContain('aria-label={`${title} example theme`}');
    expect(source).toContain("title={`${title} example, ${theme} theme`}");
    expect(source).toContain('aria-labelledby={`${kind}-widget-card`}');
  });

  it("listens only for its own widget's height messages", () => {
    // The page frames one of each at once, so a hook that accepted either
    // would let the press document resize the review sample.
    expect(source).toContain("useWidgetFrameHeight(frameRef, {\n    kind,");
  });

  it("keeps the two calls to action aligned at the bottom", () => {
    expect(source).toContain("mt-auto");
  });
});

/* -------------------------------------------------------------------------- */
/* Nothing that already worked stopped working                                 */
/* -------------------------------------------------------------------------- */

describe("the routes", () => {
  it.each([
    ["review configurator", ["(app)", "integrations", "review-widget", "page.tsx"]],
    ["press configurator", ["(app)", "integrations", "press-widget", "page.tsx"]],
    ["landing page", ["(app)", "integrations", "website-widgets", "page.tsx"]],
    ["review loader", ["embed", "review-widget.js", "route.ts"]],
    ["press loader", ["embed", "press-widget.js", "route.ts"]],
    ["review document", ["embed", "review-widget", "[publicId]", "route.ts"]],
    ["press document", ["embed", "press-widget", "[publicId]", "route.ts"]],
    ["review preview", ["embed", "review-widget", "preview", "route.ts"]],
    ["press preview", ["embed", "press-widget", "preview", "route.ts"]],
  ])("still serves the %s", (_label, segments) => {
    expect(existsSync(join(ROOT, "src", "app", ...segments))).toBe(true);
  });

  it("did not move the review configurator's URL", () => {
    // `/integrations/review-widget` has been in the sidebar and in customers'
    // browser history since the review widget shipped. The landing route is a
    // new front door, not a redirect.
    const source = readFileSync(
      join(ROOT, "src", "app", "actions", "review-widget.ts"),
      "utf8",
    );
    expect(source).toContain('"/integrations/review-widget"');
  });
});

describe("the sidebar", () => {
  const items: NavItem[] = NAV_SECTIONS.flatMap((section) => section.items);

  it("opens the landing page, not either configurator", () => {
    const item = items.find((entry) => entry.label === "Website widgets");
    expect(item?.href).toBe("/integrations/website-widgets");
  });

  it("stays highlighted on all three routes", () => {
    for (const path of [
      "/integrations/website-widgets",
      "/integrations/review-widget",
      "/integrations/press-widget",
    ]) {
      const active = items.filter((item) => isNavItemActive(item, path)).map((i) => i.label);
      expect(active, path).toEqual(["Website widgets"]);
    }
  });
});

describe("the integrations entry card", () => {
  const source = readFileSync(
    join(ROOT, "src", "components", "integrations", "website-widgets-entry-card.tsx"),
    "utf8",
  );

  it("opens the landing page", () => {
    expect(source).toContain('href="/integrations/website-widgets"');
  });

  it("mentions both products rather than only reviews", () => {
    expect(source).toContain("press");
    expect(source).toContain("review");
  });
});
