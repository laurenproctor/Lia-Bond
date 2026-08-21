import { describe, expect, it } from "vitest";
import { widgetDocumentCsp, widgetDocumentHeaders } from "@/lib/widgets/csp";
import { frameAncestorsDirective } from "@/lib/widgets/domains";
import { safeHttpUrl } from "@/lib/widgets/html";
import { WIDGET_KINDS, WIDGET_KIND_NAMES } from "@/lib/widgets/kinds";
import { buildLoaderScript, loaderAcceptsPublicId } from "@/lib/widgets/loader";
import { generateWidgetPublicId, isWidgetPublicIdShaped } from "@/lib/widgets/public-id";
import { buildEmbedSnippet, widgetFrameUrl, widgetScriptUrl } from "@/lib/widgets/snippet";

/**
 * The press embed's public surface: the id, the snippet, the loader, and the
 * content policy.
 *
 * Everything here is code the *customer's* visitors execute, on a page Lia
 * does not control, from a snippet that outlives every deploy. The suite is
 * therefore about invariants rather than behaviour — that the id cannot be
 * confused with the review widget's, that the loader is still ES5, that the
 * origin check is still there, and that `img-src` is still narrow.
 */

describe("the press public id", () => {
  it("is issued with its own prefix", () => {
    const id = generateWidgetPublicId("press");
    expect(id).toMatch(/^pw_[A-Za-z0-9_-]{20}$/);
    expect(isWidgetPublicIdShaped(id, "press")).toBe(true);
  });

  it("is unguessable rather than sequential", () => {
    // A sequential id would let anybody walk the range and produce a list of
    // every restaurant group using Lia, with their live press strip attached.
    const ids = new Set(Array.from({ length: 200 }, () => generateWidgetPublicId("press")));
    expect(ids.size).toBe(200);
  });

  it("is not interchangeable with a review widget's", () => {
    // The route checks the prefix, so a review id pasted into a press snippet
    // is answered immediately — rather than becoming a lookup that returns
    // nothing and sends somebody hunting for a deleted widget.
    const review = generateWidgetPublicId("review");
    const press = generateWidgetPublicId("press");
    expect(isWidgetPublicIdShaped(review, "press")).toBe(false);
    expect(isWidgetPublicIdShaped(press, "review")).toBe(false);
  });

  it.each([
    "",
    "pw_",
    "pw_tooshort",
    "pw_abcdefghijklmnopqrstuvwxyz",
    "pw_abcdefghijklmnopqrs/",
    "PW_abcdefghijklmnopqrst",
    "../../etc/passwd",
    "pw_abcdefghijklmnopqrst ",
  ])("refuses %s before it reaches a query", (value) => {
    expect(isWidgetPublicIdShaped(value, "press")).toBe(false);
  });

  it("agrees with the pattern compiled into the loader", () => {
    // The loader's copy lives inside a template literal and cannot import
    // anything, which is precisely the kind of duplication that drifts.
    const id = generateWidgetPublicId("press");
    expect(loaderAcceptsPublicId(id, "press")).toBe(true);
    expect(loaderAcceptsPublicId(generateWidgetPublicId("review"), "press")).toBe(false);
  });
});

describe("the snippet", () => {
  const PRESS_ID = "pw_abcdefghijklmnopqrst";

  it("is two lines: a mount point and an async script", () => {
    expect(buildEmbedSnippet("https://lia.bond", PRESS_ID, "press")).toBe(
      '<div data-lia-press-widget="pw_abcdefghijklmnopqrst"></div>\n' +
        '<script async src="https://lia.bond/embed/press-widget.js"></script>',
    );
  });

  it("points at the origin it was generated for", () => {
    const preview = buildEmbedSnippet("https://lia-git-branch.vercel.app", PRESS_ID, "press");
    expect(preview).toContain("https://lia-git-branch.vercel.app/embed/press-widget.js");
  });

  it("trims a trailing slash rather than emitting a double one", () => {
    expect(widgetFrameUrl("https://lia.bond/", PRESS_ID, "press")).toBe(
      "https://lia.bond/embed/press-widget/pw_abcdefghijklmnopqrst",
    );
  });

  it("cannot be confused with the review widget's on a page carrying both", () => {
    const press = buildEmbedSnippet("https://lia.bond", PRESS_ID, "press");
    const review = buildEmbedSnippet("https://lia.bond", "rw_abcdefghijklmnopqrst", "review");
    expect(press).not.toContain("data-lia-review-widget");
    expect(review).not.toContain("data-lia-press-widget");
    expect(widgetScriptUrl("https://lia.bond", "press")).not.toBe(
      widgetScriptUrl("https://lia.bond", "review"),
    );
  });
});

describe("the press loader script", () => {
  const script = buildLoaderScript("https://lia.bond", "press");

  it("checks the origin of every message it receives", () => {
    // The security-relevant line in the file: without it, any frame on the
    // page could resize Lia's frame over the page's own controls.
    expect(script).toContain("event.origin !== ORIGIN");
  });

  it("matches a resize to the frame's own window, not to the id in the message", () => {
    expect(script).toContain("contentWindow === event.source");
  });

  it("ignores the review widget's messages", () => {
    // A page running both loads both loaders. Each must ignore the other, or
    // one widget resizes the other's frame.
    expect(script).toContain('"lia-press-widget"');
    expect(script).not.toContain("lia-review-widget");
    expect(script).toContain("data.source !== MESSAGE_SOURCE");
  });

  it("scans only its own attribute", () => {
    expect(script).toContain('"data-lia-press-widget"');
    expect(script).not.toContain("data-lia-review-widget");
  });

  it("mounts each host element exactly once", () => {
    expect(script).toContain('getAttribute(MOUNTED) === "1"');
  });

  it("re-scans when the page changes, for builders that inject after load", () => {
    expect(script).toContain("MutationObserver");
  });

  it("handles a page that has already finished parsing", () => {
    // An `async` script may arrive at any time, including after
    // DOMContentLoaded has been and gone.
    expect(script).toContain('document.readyState === "loading"');
  });

  it("sandboxes the frame while keeping the origin its message channel needs", () => {
    expect(script).toContain("allow-scripts allow-same-origin");
    expect(script).not.toContain("allow-forms");
    expect(script).not.toContain("allow-top-navigation");
  });

  it("rejects an absurd or zero height", () => {
    expect(script).toContain("height > 4000");
  });

  it("needs no cookie, no storage, and no session", () => {
    for (const forbidden of ["document.cookie", "localStorage", "sessionStorage", "fetch("]) {
      expect(script, forbidden).not.toContain(forbidden);
    }
  });

  it("carries no modern syntax that an old browser would choke on", () => {
    // The design target is "the oldest thing that will ever load this", since
    // the snippet outlives everything else in the repository.
    expect(script).not.toMatch(/\bconst\b|\blet\b|=>|`/);
  });

  it("bakes in the origin it was generated for", () => {
    expect(buildLoaderScript("https://preview.example.com/", "press")).toContain(
      '"https://preview.example.com"',
    );
  });
});

describe("the widget kind table", () => {
  it("gives each widget a distinct prefix, attribute, path, and message source", () => {
    // Everything that keeps two widgets on one page from interfering lives
    // here, so a collision would be a single-line mistake with a very wide
    // blast radius.
    for (const field of [
      "publicIdPrefix",
      "attribute",
      "scriptPath",
      "framePath",
      "messageSource",
    ] as const) {
      const values = WIDGET_KIND_NAMES.map((kind) => WIDGET_KINDS[kind][field]);
      expect(new Set(values).size, field).toBe(values.length);
    }
  });
});

describe("the content policy", () => {
  it("lets the press document load Lia's own logo files and nothing else", () => {
    const csp = widgetDocumentCsp({
      frameAncestors: frameAncestorsDirective([]),
      imgSrc: "'self' data:",
    });
    // The directive that stops a publisher's server ever seeing a visitor.
    // Asserted on the directive rather than the whole header, because
    // `frame-ancestors *` is the correct rendering of an empty allowlist and
    // is a different question.
    const imgSrc = csp.split("; ").find((part) => part.startsWith("img-src"));
    expect(imgSrc).toBe("img-src 'self' data:");
    expect(imgSrc).not.toContain("https:");
    expect(imgSrc).not.toContain("*");
  });

  it("keeps the review document's narrower allowance untouched", () => {
    const csp = widgetDocumentCsp({
      frameAncestors: "frame-ancestors 'self'",
      imgSrc: "data:",
    });
    expect(csp).toContain("img-src data:");
    expect(csp).not.toContain("'self' data:");
  });

  it("forbids every other kind of subresource on both widgets", () => {
    const csp = widgetDocumentCsp({
      frameAncestors: "frame-ancestors 'self'",
      imgSrc: "'self' data:",
    });
    expect(csp).toContain("default-src 'none'");
    expect(csp).toContain("form-action 'none'");
    expect(csp).toContain("base-uri 'none'");
    // `connect-src` and `font-src` fall to `default-src 'none'`, so provider
    // text that somehow escaped escaping still could not reach the network.
    expect(csp).not.toContain("connect-src");
  });

  it("does not set sandbox in the header, which would break the height channel", () => {
    // The loader sets it on the iframe element, where the embedder controls
    // it. Setting it here too would give the frame an opaque origin, and every
    // message would arrive as origin "null".
    const csp = widgetDocumentCsp({
      frameAncestors: "frame-ancestors 'self'",
      imgSrc: "'self' data:",
    });
    expect(csp).not.toContain("sandbox");
  });

  it("never indexes a widget document and never leaks the embedding page's URL", () => {
    const headers = widgetDocumentHeaders({ csp: "x", cacheControl: "no-store" });
    expect(headers["x-robots-tag"]).toBe("noindex, nofollow");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["x-content-type-options"]).toBe("nosniff");
  });

  it("sends no X-Frame-Options, which cannot express a list", () => {
    const headers = widgetDocumentHeaders({ csp: "x", cacheControl: "no-store" });
    expect(Object.keys(headers)).not.toContain("x-frame-options");
  });
});

describe("outbound URL validation", () => {
  it.each([
    "https://harbourledger.example/story",
    "http://northsidedispatch.example/story",
    "https://a.example/story?utm_source=lia#top",
  ])("accepts %s", (value) => {
    expect(safeHttpUrl(value)).not.toBeNull();
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,<script>alert(1)</script>",
    "blob:https://a.example/x",
    "file:///etc/passwd",
    "//a.example/story",
    "ftp://a.example/story",
    "not a url",
    "",
    "   ",
    null,
    undefined,
  ])("refuses %s", (value) => {
    expect(safeHttpUrl(value as string | null)).toBeNull();
  });

  it("refuses a value long enough to be a payload rather than a link", () => {
    expect(safeHttpUrl(`https://a.example/${"x".repeat(3000)}`)).toBeNull();
  });
});
