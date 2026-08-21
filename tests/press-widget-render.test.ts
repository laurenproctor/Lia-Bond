import { describe, expect, it } from "vitest";
import type { PressWidgetRenderRow, PressWidgetStoryRow } from "@/domain";
import { renderPressWidgetDocument } from "@/lib/widgets/press/document";
import { excerptOf, PRESS_EXCERPT_LENGTH } from "@/lib/widgets/press/excerpt";
import { resolveRenderedPressWidget } from "@/lib/widgets/press/render";
import { samplePressWidgetRow } from "@/lib/widgets/press/sample";
import { widgetArticleDate, widgetArticleDateTime } from "@/lib/widgets/press/date";

/**
 * What reaches a stranger's screen.
 *
 * The press document is a string served inside somebody else's website, built
 * from text a third-party API supplied. Two properties matter more than
 * anything else about how it looks:
 *
 *   * every provider-controlled value is escaped; and
 *   * every URL that becomes an anchor or an image is one this codebase chose
 *     the shape of.
 *
 * The rest of the file covers the states — because an unavailable widget on a
 * restaurant's homepage is a sentence a guest reads, not an error a developer
 * reads.
 */

function story(overrides: Partial<PressWidgetStoryRow> = {}): PressWidgetStoryRow {
  return {
    headline: "A dining room that taught a neighbourhood to book early",
    excerpt: "A long look at how one kitchen rebuilt its lunch service.",
    publisherName: "The Harbour Ledger",
    publisherDomain: "harbourledger.example",
    sourceUrl: "https://harbourledger.example/story",
    publishedAt: "2026-08-12T09:00:00.000Z",
    ...overrides,
  };
}

function row(overrides: Partial<PressWidgetRenderRow> = {}): PressWidgetRenderRow {
  return {
    theme: "light",
    layout: "recent_press_list",
    status: "active",
    attributionSuppressed: false,
    allowedDomains: [],
    stories: [story()],
    ...overrides,
  };
}

function render(input: PressWidgetRenderRow | null): string {
  return renderPressWidgetDocument({
    publicId: "pw_abcdefghijklmnopqrst",
    rendered: resolveRenderedPressWidget(input),
  });
}

describe("the ready document", () => {
  it("draws the headline, the excerpt, the date, and the link", () => {
    const html = render(row());
    expect(html).toContain("A dining room that taught a neighbourhood to book early");
    expect(html).toContain("A long look at how one kitchen rebuilt its lunch service.");
    expect(html).toContain("12 August 2026");
    expect(html).toContain('href="https://harbourledger.example/story"');
    expect(html).toContain("Read article");
  });

  it("marks every outbound link as untrusted", () => {
    const html = render(row());
    // `noopener` is what stops the destination reaching back through
    // `window.opener` on a page Lia does not control.
    const anchors = html.match(/<a [^>]*href="https:[^"]*"[^>]*>/g) ?? [];
    expect(anchors.length).toBeGreaterThan(0);
    for (const anchor of anchors) {
      expect(anchor).toContain('rel="noopener noreferrer nofollow"');
      expect(anchor).toContain('target="_blank"');
    }
  });

  it("draws up to three stories, in the order given", () => {
    const html = render(
      row({
        stories: [
          story({ headline: "First", sourceUrl: "https://a.example/1" }),
          story({ headline: "Second", sourceUrl: "https://a.example/2" }),
          story({ headline: "Third", sourceUrl: "https://a.example/3" }),
        ],
      }),
    );
    expect(html.indexOf("First")).toBeLessThan(html.indexOf("Second"));
    expect(html.indexOf("Second")).toBeLessThan(html.indexOf("Third"));
  });

  it("carries the attribution line", () => {
    expect(render(row())).toContain("Powered by <strong>Lia</strong>");
  });

  it("omits it when a plan has bought it away", () => {
    // Nothing writes `attributionSuppressed` today; this proves the seam is
    // wired rather than decorative.
    expect(render(row({ attributionSuppressed: true }))).not.toContain("Powered by");
  });

  it("labels the group once rather than once per story", () => {
    const html = render(
      row({
        stories: [
          story({ headline: "First", sourceUrl: "https://a.example/1" }),
          story({ headline: "Second", sourceUrl: "https://a.example/2" }),
        ],
      }),
    );
    expect(html.match(/In the press/g)).toHaveLength(1);
  });

  it("gives the date a machine-readable form as well as a human one", () => {
    expect(render(row())).toContain('<time class="when" datetime="2026-08-12">');
  });
});

describe("escaping", () => {
  const HOSTILE = `</p><script>alert('x')</script>`;

  it.each([
    ["headline", () => row({ stories: [story({ headline: HOSTILE })] })],
    ["excerpt", () => row({ stories: [story({ excerpt: HOSTILE })] })],
    [
      "publisher name",
      () =>
        row({
          stories: [
            // Unregistered domain, so the name is drawn as text rather than
            // used only as alt text.
            story({ publisherName: HOSTILE, publisherDomain: "unregistered.example" }),
          ],
        }),
    ],
  ])("escapes a hostile %s", (_field, build) => {
    const html = render(build());
    expect(html).not.toContain("<script>alert(");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes a hostile URL rather than breaking out of the attribute", () => {
    const html = render(
      row({
        stories: [story({ sourceUrl: 'https://a.example/"><script>alert(1)</script>' })],
      }),
    );
    expect(html).not.toContain("<script>alert(1)");
  });

  it("escapes both quote forms, because the same helper writes attributes", () => {
    const html = render(row({ stories: [story({ headline: `a "b" 'c'` })] }));
    expect(html).toContain("a &quot;b&quot; &#39;c&#39;");
  });
});

describe("URL validation at the rendering boundary", () => {
  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "//harbourledger.example/story",
    "file:///etc/passwd",
    "",
    null,
  ])("drops a story whose destination is %s", (sourceUrl) => {
    // A press card *is* a link. A headline with no destination is the shape of
    // a fabricated one, so the story goes rather than the anchor.
    const html = render(
      row({ stories: [story({ headline: "Dropped", sourceUrl })] }),
    );
    expect(html).not.toContain("Dropped");
    expect(html).toContain("No press coverage to show yet.");
  });

  it("drops only the bad story, never its neighbours", () => {
    const html = render(
      row({
        stories: [
          story({ headline: "Kept one", sourceUrl: "https://a.example/1" }),
          story({ headline: "Dropped", sourceUrl: "javascript:alert(1)" }),
          story({ headline: "Kept two", sourceUrl: "https://a.example/2" }),
        ],
      }),
    );
    expect(html).toContain("Kept one");
    expect(html).toContain("Kept two");
    expect(html).not.toContain("Dropped");
    expect(html).not.toContain("javascript:");
  });

  it.each([
    ["a story with no headline", story({ headline: null })],
    ["a story with a blank headline", story({ headline: "   " })],
    ["a story with no publication date", story({ publishedAt: null })],
  ])("drops %s", (_label, bad) => {
    const html = render(row({ stories: [bad] }));
    expect(html).toContain("No press coverage to show yet.");
  });
});

describe("publication logos", () => {
  it("draws a registered publication's mark, with its name as alt text", () => {
    const html = render(row());
    expect(html).toContain('src="/widget-logos/harbour-ledger/harbour-ledger.v1.svg"');
    expect(html).toContain('alt="The Harbour Ledger"');
  });

  it("draws the dark variant on a dark card", () => {
    const html = render(row({ theme: "dark" }));
    expect(html).toContain("/widget-logos/harbour-ledger/harbour-ledger-dark.v1.svg");
    expect(html).not.toContain("/widget-logos/harbour-ledger/harbour-ledger.v1.svg");
  });

  it("reserves the mark's own intrinsic dimensions", () => {
    // Without these the card reflows when the file lands, and the auto-height
    // message the loader already acted on becomes wrong.
    const html = render(row());
    expect(html).toContain('width="168" height="24"');
    expect(html).toContain("object-fit: contain");
  });

  it("uses the registry's name, not the provider's, as the accessible name", () => {
    // A provider reporting "Harbour Ledger — Food & Drink" must not put that
    // in an image's accessible name; the registry's name was checked when the
    // mark was added.
    const html = render(
      row({ stories: [story({ publisherName: "Harbour Ledger — Food & Drink" })] }),
    );
    expect(html).toContain('alt="The Harbour Ledger"');
  });

  it("falls back to the publisher's name as text for an unregistered outlet", () => {
    const html = render(
      row({
        stories: [
          story({ publisherName: "Metro Tribune", publisherDomain: "metrotribune.com" }),
        ],
      }),
    );
    expect(html).toContain("Metro Tribune");
    expect(html).not.toContain("<img");
  });

  it("never hides a story for want of a mark", () => {
    const html = render(
      row({
        stories: [
          story({
            headline: "Still shown",
            publisherName: null,
            publisherDomain: null,
          }),
        ],
      }),
    );
    expect(html).toContain("Still shown");
  });

  it("normalises the domain before resolving, so a raw provider value still matches", () => {
    const html = render(
      row({ stories: [story({ publisherDomain: "https://WWW.HarbourLedger.Example/x" })] }),
    );
    expect(html).toContain("/widget-logos/harbour-ledger/harbour-ledger.v1.svg");
  });

  it("never emits a remote image origin, whatever the resolver returned", () => {
    const html = render(
      row({
        stories: [
          story({ publisherDomain: "https://cdn.evil.example/tracker.png" }),
          story({
            headline: "Second",
            sourceUrl: "https://a.example/2",
            publisherDomain: "//evil.example/logo.svg",
          }),
        ],
      }),
    );
    // The only `src` a press document may carry is a root-relative path under
    // /widget-logos. The CSP is the enforcement; this is the belt.
    for (const match of html.match(/src="[^"]*"/g) ?? []) {
      expect(match).toMatch(/^src="\/widget-logos\//);
    }
  });
});

describe("unavailable states", () => {
  it.each([
    [null, "This press widget is no longer available."],
    [row({ status: "disabled" }), "This press widget is switched off."],
    [row({ stories: [] }), "No press coverage to show yet."],
  ])("says the right sentence", (input, expected) => {
    expect(render(input)).toContain(expected);
  });

  it("never names Lia's internal vocabulary to a visitor", () => {
    for (const input of [null, row({ status: "disabled" }), row({ stories: [] })]) {
      const html = render(input);
      for (const leak of [
        "eligib",
        "dismiss",
        "escalat",
        "syndicat",
        "monitoring quer",
        "organization",
        "capture_method",
      ]) {
        expect(html.toLowerCase(), leak).not.toContain(leak);
      }
    }
  });

  it("draws an unknown widget as a light card", () => {
    // There is no widget to ask for a theme, and light is the one that
    // disappears into a page rather than punching a black rectangle into it.
    expect(render(null)).toContain("color-scheme: light");
  });

  it("keeps the frame quiet rather than showing an error panel", () => {
    const html = render(row({ stories: [] }));
    expect(html).not.toContain("role=\"alert\"");
    expect(html).toContain('class="empty"');
  });
});

describe("the document itself", () => {
  it("fetches nothing beyond Lia's own logo files", () => {
    const html = render(row());
    expect(html).not.toContain("<link");
    expect(html).not.toMatch(/src="https?:/);
    expect(html).not.toContain("@import");
  });

  it("carries a noindex meta as well as the header", () => {
    expect(render(row())).toContain('<meta name="robots" content="noindex">');
  });

  it("posts height messages under the press widget's own source name", () => {
    // A page carrying both widgets has two loaders listening; a shared name
    // would let one resize the other's frame.
    const html = render(row());
    expect(html).toContain('"lia-press-widget"');
    expect(html).not.toContain("lia-review-widget");
  });

  it("is a complete standalone document", () => {
    const html = render(row());
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("</html>");
  });
});

describe("the sample", () => {
  const NOW = Date.parse("2026-09-01T12:00:00.000Z");

  it("renders three invented publications, each with its own mark", () => {
    const html = render(samplePressWidgetRow("light", NOW));
    expect(html).toContain('alt="The Harbour Ledger"');
    expect(html).toContain('alt="Meridian Table"');
    expect(html).toContain('alt="Northside Dispatch"');
  });

  it("renders every mark in the dark theme too", () => {
    const html = render(samplePressWidgetRow("dark", NOW));
    for (const key of ["harbour-ledger", "meridian-table", "northside-dispatch"]) {
      expect(html).toContain(`/widget-logos/${key}/${key}-dark.v1.svg`);
    }
  });

  it("links only to example.com, never into a real publisher's domain", () => {
    // A fabricated link into a real outlet would 404 on somebody else's
    // server and read as a broken product.
    const html = render(samplePressWidgetRow("light", NOW));
    for (const href of html.match(/href="[^"]*"/g) ?? []) {
      expect(href).toMatch(/^href="https:\/\/example\.com\//);
    }
  });

  it("honours an item limit, so the landing page can show fewer", () => {
    const rendered = resolveRenderedPressWidget(samplePressWidgetRow("light", NOW, 1));
    expect(rendered.state === "ready" && rendered.stories).toHaveLength(1);
  });
});

describe("excerpts", () => {
  it("passes a short description through untouched", () => {
    expect(excerptOf("A short line.")).toBe("A short line.");
  });

  it("collapses whitespace, because a provider's line breaks are not layout", () => {
    expect(excerptOf("A  line\nwith\tbreaks")).toBe("A line with breaks");
  });

  it("returns null for nothing at all", () => {
    expect(excerptOf(null)).toBeNull();
    expect(excerptOf("   ")).toBeNull();
  });

  it("cuts on a word boundary and marks the cut", () => {
    const long = `${"word ".repeat(80)}end`;
    const cut = excerptOf(long) ?? "";
    expect(cut.length).toBeLessThanOrEqual(PRESS_EXCERPT_LENGTH + 1);
    expect(cut.endsWith("…")).toBe(true);
    expect(cut).not.toContain("wor…");
  });
});

describe("article dates", () => {
  it("is absolute, because a press date is part of a citation", () => {
    expect(widgetArticleDate("2026-08-12T09:00:00.000Z")).toBe("12 August 2026");
  });

  it("reads the instant in UTC, so the same story renders identically everywhere", () => {
    // The document is server-rendered once and cached at the edge; a
    // machine-local time zone would make the cached copy wrong for somebody.
    expect(widgetArticleDate("2026-08-12T23:30:00.000Z")).toBe("12 August 2026");
  });

  it("returns an empty string rather than inventing a date", () => {
    expect(widgetArticleDate("not a date")).toBe("");
    expect(widgetArticleDateTime("not a date")).toBe("");
  });

  it("carries a date-only datetime, not a false precision", () => {
    expect(widgetArticleDateTime("2026-08-12T09:34:07.000Z")).toBe("2026-08-12");
  });
});
