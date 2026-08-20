import { describe, expect, it } from "vitest";
import type { ReviewWidgetRenderRow } from "@/domain";
import { escapeHtml, renderReviewWidgetDocument } from "@/lib/widgets/document";
import { widgetReviewDate } from "@/lib/widgets/relative-date";
import { resolveRenderedWidget } from "@/lib/widgets/render";
import { sampleReviewWidgetRow } from "@/lib/widgets/sample";

/**
 * What actually reaches a stranger's screen.
 *
 * This is the boundary where a third party's text becomes markup on a
 * restaurant's own domain, so the escaping cases are not routine coverage —
 * they are the reason the renderer takes a typed payload rather than a
 * mention.
 */

const NOW = Date.parse("2026-08-20T12:00:00.000Z");

function row(overrides: Partial<ReviewWidgetRenderRow> = {}): ReviewWidgetRenderRow {
  return {
    theme: "light",
    layout: "single_review_text",
    status: "active",
    attributionSuppressed: false,
    allowedDomains: [],
    selectionMode: "most_recent",
    reviewRating: 5,
    reviewText: "Responsive, thoughtful, and genuinely easy to work with.",
    reviewAuthorName: "Alicia Moreno",
    reviewPublishedAt: "2026-08-17T12:00:00.000Z",
    profileUrl: "https://maps.google.com/?cid=1001",
    ...overrides,
  };
}

/* -------------------------------------------------------------------------- */
/* Resolution                                                                  */
/* -------------------------------------------------------------------------- */

describe("resolving what to draw", () => {
  it("draws the review when one resolved", () => {
    const rendered = resolveRenderedWidget(row());

    expect(rendered.state).toBe("ready");
    if (rendered.state !== "ready") return;

    expect(rendered.review.authorName).toBe("Alicia Moreno");
    expect(rendered.review.authorInitials).toBe("AM");
    expect(rendered.review.readOnGoogleUrl).toContain("cid=1001");
  });

  it("reports an unknown public id rather than throwing", () => {
    // A public embed that could throw is a public embed that shows a stack
    // trace on a restaurant's homepage.
    const rendered = resolveRenderedWidget(null);

    expect(rendered.state).toBe("unavailable");
    if (rendered.state !== "unavailable") return;
    expect(rendered.reason).toBe("unknown_widget");
  });

  it("reports a disabled widget as disabled, not as empty", () => {
    const rendered = resolveRenderedWidget(row({ status: "disabled" }));

    expect(rendered.state).toBe("unavailable");
    if (rendered.state !== "unavailable") return;
    expect(rendered.reason).toBe("disabled");
  });

  it("distinguishes a lost pinned review from a location with nothing to show", () => {
    // The distinction the product brief asks for by name. Both are the same
    // absence in the database and two entirely different sentences on a
    // customer's website.
    const pinned = resolveRenderedWidget(
      row({ selectionMode: "specific", reviewText: null, reviewRating: null, reviewPublishedAt: null }),
    );
    const automatic = resolveRenderedWidget(
      row({ selectionMode: "most_recent", reviewText: null, reviewRating: null, reviewPublishedAt: null }),
    );

    expect(pinned.state === "unavailable" && pinned.reason).toBe(
      "selected_review_unavailable",
    );
    expect(automatic.state === "unavailable" && automatic.reason).toBe(
      "no_eligible_review",
    );
  });

  it("never substitutes another review for a lost pinned one", () => {
    const rendered = resolveRenderedWidget(
      row({ selectionMode: "specific", reviewText: null, reviewRating: null, reviewPublishedAt: null }),
    );
    expect(rendered.state).toBe("unavailable");
  });

  it("keeps the widget's theme on the unavailable card", () => {
    // Otherwise a dark widget flashes a white rectangle into a dark page the
    // moment its review stops qualifying.
    const rendered = resolveRenderedWidget(row({ theme: "dark", status: "disabled" }));
    expect(rendered.theme).toBe("dark");
  });

  it("drops an untrusted profile URL rather than linking to it", () => {
    const rendered = resolveRenderedWidget(
      row({ profileUrl: "https://google.evil.example/maps" }),
    );

    expect(rendered.state).toBe("ready");
    if (rendered.state !== "ready") return;
    expect(rendered.review.readOnGoogleUrl).toBeNull();
  });

  it("uses Google's own wording for an anonymous reviewer", () => {
    const rendered = resolveRenderedWidget(row({ reviewAuthorName: null }));

    expect(rendered.state).toBe("ready");
    if (rendered.state !== "ready") return;
    expect(rendered.review.authorName).toBe("A Google user");
  });

  it("treats whitespace-only review text as no review at all", () => {
    const rendered = resolveRenderedWidget(row({ reviewText: "   " }));
    expect(rendered.state).toBe("unavailable");
  });
});

describe("the attribution line", () => {
  it("is shown, because Lia has no plan model to sell its removal", () => {
    expect(resolveRenderedWidget(row()).showAttribution).toBe(true);
  });

  it("is the only thing the suppression column controls", () => {
    // Nothing writes the column today. This holds the seam honest so a future
    // plan gate has somewhere to land that already works.
    expect(resolveRenderedWidget(row({ attributionSuppressed: true })).showAttribution).toBe(
      false,
    );
  });
});

/* -------------------------------------------------------------------------- */
/* The document                                                                */
/* -------------------------------------------------------------------------- */

function render(overrides: Partial<ReviewWidgetRenderRow> = {}): string {
  return renderReviewWidgetDocument({
    publicId: "rw_abcdefghijklmnopqrst",
    rendered: resolveRenderedWidget(row(overrides)),
    now: NOW,
  });
}

describe("the rendered document", () => {
  it("is a complete standalone page", () => {
    const html = render();
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html).toContain("</html>");
  });

  it("requests nothing from the network", () => {
    // No webfont, no logo image, no stylesheet. The widget must add no
    // third-party request to a customer's page and nothing for a consent
    // banner to have an opinion about.
    const html = render();
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).not.toMatch(/src="https?:/i);
    expect(html).not.toContain("fonts.googleapis.com");
  });

  it("carries the review, the reviewer, the stars, and the date", () => {
    const html = render();

    expect(html).toContain("Responsive, thoughtful, and genuinely easy to work with.");
    expect(html).toContain("Alicia Moreno");
    expect(html).toContain("AM");
    expect(html).toContain("Rated 5 out of 5");
    expect(html).toContain("3 days ago");
  });

  it("attributes the review to Google", () => {
    expect(render()).toContain("Google Review");
  });

  it("renders Read on Google only when a trusted URL exists", () => {
    expect(render()).toContain("Read on Google");
    expect(render({ profileUrl: null })).not.toContain("Read on Google");
  });

  it("opens the Google link safely", () => {
    // `noopener` because the frame is sandboxed with `allow-popups-to-escape-
    // sandbox`, so the opened tab is a real window with a real opener.
    expect(render()).toContain('rel="noopener noreferrer nofollow"');
  });

  it("changes palette with the theme and nothing else", () => {
    const light = render({ theme: "light" });
    const dark = render({ theme: "dark" });

    expect(light).toContain("color-scheme: light");
    expect(dark).toContain("color-scheme: dark");
    expect(light).toContain("#ffffff");
    expect(dark).toContain("#12130f");
    // Same content, different clothes.
    expect(dark).toContain("Alicia Moreno");
  });

  it("keeps Google's mark in its own colours in both themes", () => {
    // Recolouring a trademark to suit a palette is the one thing a review
    // widget must not do — the mark is the attribution.
    for (const theme of ["light", "dark"] as const) {
      expect(render({ theme })).toContain("#4285F4");
      expect(render({ theme })).toContain("#EA4335");
    }
  });

  it("carries the Powered by Lia line", () => {
    expect(render()).toContain("Powered by");
  });

  it("says why it is empty, in words a restaurant guest can read", () => {
    const html = render({ status: "disabled" });

    expect(html).toContain("switched off");
    // No internal vocabulary reaches a stranger's screen.
    expect(html).not.toContain("eligib");
    expect(html).not.toContain("dismissed");
  });
});

/* -------------------------------------------------------------------------- */
/* Escaping                                                                    */
/* -------------------------------------------------------------------------- */

describe("review text is attacker-controlled", () => {
  it("escapes markup in the review body", () => {
    const html = render({
      reviewText: '<script>alert("xss")</script> lovely food',
    });

    expect(html).not.toContain("<script>alert");
    expect(html).toContain("&lt;script&gt;");
  });

  it("escapes markup in the reviewer's name", () => {
    const html = render({ reviewAuthorName: '"><img src=x onerror=alert(1)>' });

    // The escaped text still *reads* "onerror=alert(1)". What matters is that
    // no tag survives: `<` is what turns a string into an element.
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img");
  });

  it("escapes both quote forms, since the same helper writes attributes", () => {
    expect(escapeHtml(`a "b" 'c' <d> &e`)).toBe("a &quot;b&quot; &#39;c&#39; &lt;d&gt; &amp;e");
  });

  it("escapes the ampersand first, so nothing double-decodes", () => {
    expect(escapeHtml("&lt;")).toBe("&amp;lt;");
  });

  it("leaves no unescaped angle bracket from a hostile profile URL", () => {
    // The URL is validated before it gets here, but the escape is the last
    // line and is tested as though it were the only one.
    const html = render({ profileUrl: 'https://maps.google.com/?cid="><b>' });
    expect(html).not.toContain('"><b>');
  });
});

/* -------------------------------------------------------------------------- */
/* Dates                                                                       */
/* -------------------------------------------------------------------------- */

describe("the date under the reviewer's name", () => {
  const now = Date.parse("2026-08-20T12:00:00.000Z");

  it("reads the way a guest would say it", () => {
    expect(widgetReviewDate("2026-08-20T11:00:00.000Z", now)).toBe("today");
    expect(widgetReviewDate("2026-08-19T10:00:00.000Z", now)).toBe("yesterday");
    expect(widgetReviewDate("2026-08-17T12:00:00.000Z", now)).toBe("3 days ago");
    expect(widgetReviewDate("2026-08-06T12:00:00.000Z", now)).toBe("2 weeks ago");
    expect(widgetReviewDate("2026-06-20T12:00:00.000Z", now)).toBe("2 months ago");
  });

  it("gives a real date once a relative phrase stops being useful", () => {
    // "31 months ago" reads as a bug.
    expect(widgetReviewDate("2023-04-11T12:00:00.000Z", now)).toBe("11 April 2023");
  });

  it("treats a future date as a clock disagreement, not a prediction", () => {
    expect(widgetReviewDate("2027-01-01T00:00:00.000Z", now)).toBe("today");
  });

  it("renders nothing rather than 'Invalid Date' for an unparseable value", () => {
    expect(widgetReviewDate("not-a-date", now)).toBe("");
  });
});

/* -------------------------------------------------------------------------- */
/* The teaser's example review                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The empty state promises "this is the widget itself, not a picture of it",
 * and these hold that promise: the sample has to survive the real resolver, or
 * the teaser silently degrades into an unavailable card and shows a new
 * customer an empty rectangle at the exact moment they are deciding whether to
 * connect an account.
 */
describe("the sample used by the empty-state teaser", () => {
  it("resolves to a drawable review in both themes", () => {
    for (const theme of ["light", "dark"] as const) {
      const rendered = resolveRenderedWidget(sampleReviewWidgetRow(theme, NOW));

      expect(rendered.state).toBe("ready");
      expect(rendered.theme).toBe(theme);
      if (rendered.state !== "ready") return;

      expect(rendered.review.text.length).toBeGreaterThan(0);
      expect(rendered.review.rating).toBe(5);
      // Fiction, but a real Google destination — an invented listing id would
      // be a link to a business that does not exist.
      expect(rendered.review.readOnGoogleUrl).toContain("https://www.google.com/maps");
    }
  });

  it("carries a date a widget would plausibly be showing", () => {
    const row = sampleReviewWidgetRow("light", NOW);
    expect(widgetReviewDate(row.reviewPublishedAt ?? "", NOW)).toBe("1 week ago");
  });

  it("shows the attribution line, like every other widget", () => {
    const html = renderReviewWidgetDocument({
      publicId: "sample",
      rendered: resolveRenderedWidget(sampleReviewWidgetRow("light", NOW)),
      now: NOW,
    });

    expect(html).toContain("Powered by");
    expect(html).toContain("Read on Google");
  });
});
