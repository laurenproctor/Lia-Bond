import { describe, expect, it } from "vitest";
import { normalizeGoogleUrl } from "@/integrations/google-business-profile/urls";
import {
  frameAncestorsDirective,
  normalizeWidgetDomain,
  normalizeWidgetDomains,
  splitDomainInput,
} from "@/lib/widgets/domains";
import { buildLoaderScript, loaderAcceptsPublicId } from "@/lib/widgets/loader";
import { generateWidgetPublicId, isWidgetPublicIdShaped } from "@/lib/widgets/public-id";
import { buildEmbedSnippet, widgetFrameUrl } from "@/lib/widgets/snippet";

/**
 * The parts of the widget that live outside Lia.
 *
 * Everything here ends up either in a customer's page source or in the header
 * that decides whether a browser will paint the frame — so the failure modes
 * are "a snippet that does not work on a site nobody can debug for them" and
 * "a restriction that does not restrict".
 */

/* -------------------------------------------------------------------------- */
/* Public ids                                                                  */
/* -------------------------------------------------------------------------- */

describe("public ids", () => {
  it("issues a shaped, prefixed id", () => {
    const id = generateWidgetPublicId();
    expect(id.startsWith("rw_")).toBe(true);
    expect(isWidgetPublicIdShaped(id)).toBe(true);
  });

  it("does not repeat", () => {
    // Not a statistical claim — 120 bits makes that pointless to assert — but
    // it does catch a generator accidentally wired to a constant.
    const ids = new Set(Array.from({ length: 200 }, () => generateWidgetPublicId()));
    expect(ids.size).toBe(200);
  });

  it("rejects anything it did not issue", () => {
    for (const value of [
      "",
      "rw_",
      "rw_short",
      "abcdefghijklmnopqrstuvw",
      "rw_../../../etc/passwd00",
      "rw_" + "a".repeat(21),
      "RW_aaaaaaaaaaaaaaaaaaaa",
    ]) {
      expect(isWidgetPublicIdShaped(value), value).toBe(false);
    }
  });

  it("agrees with the pattern the loader script carries", () => {
    // The loader's copy of this regex lives inside a template literal and
    // cannot import anything, which is exactly the kind of duplication that
    // drifts silently. A mismatch would mean ids Lia issues that the script on
    // the customer's page refuses to mount.
    const script = buildLoaderScript("https://lia.bond");
    const inScript = /\/\^rw_\[A-Za-z0-9_-\]\{20\}\$\//.test(script);

    expect(inScript).toBe(true);
    expect(loaderAcceptsPublicId(generateWidgetPublicId())).toBe(true);
  });
});

/* -------------------------------------------------------------------------- */
/* The snippet                                                                 */
/* -------------------------------------------------------------------------- */

describe("the embed snippet", () => {
  it("is a mount point followed by an async script", () => {
    const snippet = buildEmbedSnippet("https://lia.bond", "rw_abcdefghijklmnopqrst");

    expect(snippet).toBe(
      '<div data-lia-review-widget="rw_abcdefghijklmnopqrst"></div>\n' +
        '<script async src="https://lia.bond/embed/review-widget.js"></script>',
    );
  });

  it("points at the deployment it was generated on", () => {
    // A preview deployment must not hand somebody a snippet that loads
    // production's script.
    const preview = buildEmbedSnippet("https://lia-git-branch.vercel.app", "rw_a".padEnd(23, "b"));
    expect(preview).toContain("https://lia-git-branch.vercel.app/embed/review-widget.js");
  });

  it("tolerates a trailing slash on the configured origin", () => {
    expect(widgetFrameUrl("https://lia.bond/", "rw_abcdefghijklmnopqrst")).toBe(
      "https://lia.bond/embed/review-widget/rw_abcdefghijklmnopqrst",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Approved domains                                                            */
/* -------------------------------------------------------------------------- */

describe("normalising what somebody typed into a domain", () => {
  it("accepts the forms people actually paste", () => {
    for (const input of [
      "example.com",
      "EXAMPLE.COM",
      " example.com ",
      "https://example.com",
      "http://example.com/",
      "https://example.com/menu?utm_source=x",
      "example.com.",
    ]) {
      expect(normalizeWidgetDomain(input), input).toBe("example.com");
    }
  });

  it("keeps a leading wildcard label, which is what CSP can express", () => {
    expect(normalizeWidgetDomain("*.example.com")).toBe("*.example.com");
  });

  it("refuses values a frame-ancestors source could not enforce", () => {
    for (const input of [
      "localhost",
      "intranet",
      "192.168.0.1",
      "example.*",
      "ex*ample.com",
      "user:pass@example.com",
      "example.com:8443",
      "",
      "   ",
    ]) {
      expect(normalizeWidgetDomain(input), input).toBeNull();
    }
  });

  it("de-duplicates the same site typed two ways", () => {
    const { domains } = normalizeWidgetDomains([
      "example.com",
      "https://example.com/",
      "EXAMPLE.com",
    ]);
    expect(domains).toEqual(["example.com"]);
  });

  it("keeps the good entries and reports the bad ones", () => {
    // Refusing the whole save would make somebody find the bad entry by
    // bisection.
    const { domains, rejected } = normalizeWidgetDomains([
      "example.com",
      "localhost",
      "shop.example.com",
    ]);

    expect(domains).toEqual(["example.com", "shop.example.com"]);
    expect(rejected).toEqual(["localhost"]);
  });

  it("caps the list and reports the overflow rather than truncating silently", () => {
    const many = Array.from({ length: 25 }, (_, index) => `site${index}.example.com`);
    const { domains, rejected } = normalizeWidgetDomains(many);

    expect(domains).toHaveLength(20);
    expect(rejected).toHaveLength(5);
  });

  it("splits a pasted list on whitespace, commas, and semicolons", () => {
    expect(splitDomainInput("a.com\nb.com, c.com;  d.com")).toEqual([
      "a.com",
      "b.com",
      "c.com",
      "d.com",
    ]);
  });
});

describe("the frame-ancestors directive", () => {
  it("is unrestricted when the customer has restricted nothing", () => {
    // Closed-by-default would mean every widget was broken until somebody
    // found this setting.
    expect(frameAncestorsDirective([])).toBe("frame-ancestors *");
  });

  it("keeps Lia's own origin alongside the customer's list", () => {
    // Otherwise a customer would have to add lia.bond to their own allowlist
    // to see the preview of what they are publishing.
    const directive = frameAncestorsDirective(["example.com"]);
    expect(directive).toContain("'self'");
  });

  it("emits both schemes, because restaurant websites are not all on TLS", () => {
    const directive = frameAncestorsDirective(["example.com", "*.shop.example.com"]);

    expect(directive).toContain("https://example.com");
    expect(directive).toContain("http://example.com");
    expect(directive).toContain("https://*.shop.example.com");
  });
});

/* -------------------------------------------------------------------------- */
/* The loader                                                                  */
/* -------------------------------------------------------------------------- */

describe("the loader script", () => {
  const script = buildLoaderScript("https://lia.bond");

  it("checks the origin of every message it receives", () => {
    // The security-relevant line in the file: without it, any frame on the
    // page could resize Lia's frame over the page's own controls.
    expect(script).toContain("event.origin !== ORIGIN");
  });

  it("matches a resize to the frame's own window, not to the id in the message", () => {
    // The id is readable in the page's HTML; a window handle is not.
    expect(script).toContain("contentWindow === event.source");
  });

  it("mounts each host element exactly once", () => {
    expect(script).toContain('getAttribute(MOUNTED) === "1"');
  });

  it("re-scans when the page changes, for builders that inject after load", () => {
    expect(script).toContain("MutationObserver");
  });

  it("sandboxes the frame while keeping the origin its message channel needs", () => {
    expect(script).toContain("allow-scripts allow-same-origin");
    expect(script).not.toContain("allow-forms");
    expect(script).not.toContain("allow-top-navigation");
  });

  it("carries no modern syntax that an old browser would choke on", () => {
    // The design target is "the oldest thing that will ever load this", since
    // the snippet outlives everything else in the repository.
    expect(script).not.toMatch(/\bconst\b|\blet\b|=>|`/);
  });

  it("bakes in the origin it was generated for", () => {
    expect(buildLoaderScript("https://preview.example.com/")).toContain(
      '"https://preview.example.com"',
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Where "Read on Google" may point                                            */
/* -------------------------------------------------------------------------- */

describe("trusted Google destinations", () => {
  it("accepts the shapes a mapped listing actually stores", () => {
    for (const input of [
      "https://maps.google.com/?cid=1001",
      "https://www.google.com/maps/place/?q=place_id:abc",
      "https://google.co.uk/maps?cid=7",
      "https://maps.app.goo.gl/abc123",
    ]) {
      expect(normalizeGoogleUrl(input), input).not.toBeNull();
    }
  });

  it("keeps the query string, which is where a Maps link carries its identity", () => {
    // Dropping it — as the Yelp equivalent does — would turn a link to one
    // restaurant into a link to Google Maps' front page.
    expect(normalizeGoogleUrl("https://maps.google.com/?cid=1001")).toContain("cid=1001");
  });

  it("refuses a look-alike host anybody can register", () => {
    for (const input of [
      "https://google.evil.example/maps",
      "https://notgoogle.com/",
      "https://google.com.attacker.test/",
      "https://usercontent.google.evil/",
    ]) {
      expect(normalizeGoogleUrl(input), input).toBeNull();
    }
  });

  it("refuses a scheme that is not https", () => {
    expect(normalizeGoogleUrl("http://maps.google.com/?cid=1")).toBeNull();
    expect(normalizeGoogleUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeGoogleUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  it("refuses embedded credentials, the classic way to disguise a host", () => {
    expect(normalizeGoogleUrl("https://google.com@evil.example/")).toBeNull();
  });

  it("refuses an arbitrary subdomain of a Google domain", () => {
    // Google's own user-content hosts are not places to send somebody who was
    // told they were going to a review page.
    expect(normalizeGoogleUrl("https://uploads.google.com/anything")).toBeNull();
  });
});
