import { describe, expect, it } from "vitest";
import {
  canonicalYelpBusinessUrl,
  isTrustedYelpUrl,
  isYelpAlias,
  normalizeYelpUrl,
} from "@/yelp/urls";

/**
 * URL validation is the security boundary of the assisted-posting handoff.
 *
 * "Open in Yelp" turns a stored string into somewhere a customer's browser
 * goes, and one of the two sources for that string is a text box a customer
 * pasted into. Every refusal below is a redirect that would otherwise have
 * been offered under a Yelp label.
 */
describe("normalizeYelpUrl — what it accepts", () => {
  it("accepts a Yelp business page", () => {
    expect(normalizeYelpUrl("https://www.yelp.com/biz/maison-laurent-brooklyn")).toBe(
      "https://www.yelp.com/biz/maison-laurent-brooklyn",
    );
  });

  it("accepts a bare apex host", () => {
    expect(normalizeYelpUrl("https://yelp.com/biz/maison-laurent")).toBe(
      "https://yelp.com/biz/maison-laurent",
    );
  });

  it("accepts the international domains Yelp actually runs", () => {
    for (const host of ["yelp.co.uk", "yelp.ca", "yelp.com.au", "yelp.fr", "yelp.co.jp"]) {
      expect(isTrustedYelpUrl(`https://www.${host}/biz/example`)).toBe(true);
    }
  });

  it("preserves path casing, because a review fragment is an identifier", () => {
    const url = "https://www.yelp.com/biz/example?hrid=AbC-123";
    // The query goes; what remains of the path keeps its case.
    expect(normalizeYelpUrl("https://www.yelp.com/biz/Example-Cafe")).toBe(
      "https://www.yelp.com/biz/Example-Cafe",
    );
    expect(normalizeYelpUrl(url)).toBe("https://www.yelp.com/biz/example");
  });
});

describe("normalizeYelpUrl — canonicalisation", () => {
  it("drops the query string entirely rather than filtering known trackers", () => {
    // The deduplication contract's URL branch depends on this: the same review
    // shared from two places differs only in tracking parameters, and a raw
    // comparison would read them as two different reviews.
    const a = normalizeYelpUrl(
      "https://www.yelp.com/biz/example?utm_source=share&hrid=abc",
    );
    const b = normalizeYelpUrl("https://www.yelp.com/biz/example?osq=dinner");
    expect(a).toBe("https://www.yelp.com/biz/example");
    expect(a).toBe(b);
  });

  it("drops the fragment", () => {
    expect(normalizeYelpUrl("https://www.yelp.com/biz/example#reviews")).toBe(
      "https://www.yelp.com/biz/example",
    );
  });

  it("lowercases the host and strips a trailing slash", () => {
    expect(normalizeYelpUrl("https://WWW.YELP.COM/biz/example/")).toBe(
      "https://www.yelp.com/biz/example",
    );
  });

  it("trims surrounding whitespace from a pasted value", () => {
    expect(normalizeYelpUrl("  https://www.yelp.com/biz/example  ")).toBe(
      "https://www.yelp.com/biz/example",
    );
  });
});

describe("normalizeYelpUrl — what it refuses", () => {
  it("refuses a non-Yelp host", () => {
    expect(normalizeYelpUrl("https://www.example.com/biz/example")).toBeNull();
  });

  it("refuses a lookalike domain that merely contains the word yelp", () => {
    // The reason the host list is an allowlist rather than a pattern: anybody
    // can register these.
    for (const host of [
      "yelp.example.com",
      "notyelp.com",
      "yelp.com.evil.test",
      "yelp-com.test",
      "yelp.xyz",
    ]) {
      expect(normalizeYelpUrl(`https://${host}/biz/example`)).toBeNull();
    }
  });

  it("refuses a subdomain other than www", () => {
    expect(normalizeYelpUrl("https://evil.yelp.com.attacker.test/biz/x")).toBeNull();
    expect(normalizeYelpUrl("https://m.yelp.com/biz/example")).toBeNull();
  });

  it("refuses javascript: and data: schemes", () => {
    expect(normalizeYelpUrl("javascript:alert(1)")).toBeNull();
    expect(normalizeYelpUrl("data:text/html,<script>alert(1)</script>")).toBeNull();
  });

  it("refuses plain http, which is a downgrade rather than a Yelp link", () => {
    expect(normalizeYelpUrl("http://www.yelp.com/biz/example")).toBeNull();
  });

  it("refuses embedded credentials, the classic way to disguise a host", () => {
    expect(normalizeYelpUrl("https://www.yelp.com@evil.test/biz/example")).toBeNull();
    expect(normalizeYelpUrl("https://user:pass@www.yelp.com/biz/example")).toBeNull();
  });

  it("refuses an empty, blank, or absurdly long value", () => {
    expect(normalizeYelpUrl("")).toBeNull();
    expect(normalizeYelpUrl("   ")).toBeNull();
    expect(normalizeYelpUrl(`https://www.yelp.com/biz/${"a".repeat(3000)}`)).toBeNull();
  });

  it("refuses something that is not a URL at all", () => {
    expect(normalizeYelpUrl("maison laurent yelp page")).toBeNull();
  });
});

describe("canonicalYelpBusinessUrl", () => {
  it("builds the .com page from an alias", () => {
    expect(canonicalYelpBusinessUrl("maison-laurent-brooklyn")).toBe(
      "https://www.yelp.com/biz/maison-laurent-brooklyn",
    );
  });

  it("refuses an alias that would escape the path segment", () => {
    // This is the one place provider data becomes a destination, so the alias
    // is validated rather than interpolated.
    for (const alias of [
      "../../evil",
      "example/../..",
      "example?next=evil",
      "example#frag",
      "Example-Caps",
      "",
    ]) {
      expect(canonicalYelpBusinessUrl(alias)).toBeNull();
    }
  });

  it("round-trips through the validator it feeds", () => {
    const built = canonicalYelpBusinessUrl("maison-laurent");
    expect(built).not.toBeNull();
    expect(isTrustedYelpUrl(built as string)).toBe(true);
  });
});

describe("isYelpAlias", () => {
  it("accepts Yelp's lowercase hyphenated slugs", () => {
    expect(isYelpAlias("maison-laurent-brooklyn-2")).toBe(true);
  });

  it("refuses uppercase, spaces, and path separators", () => {
    expect(isYelpAlias("Maison-Laurent")).toBe(false);
    expect(isYelpAlias("maison laurent")).toBe(false);
    expect(isYelpAlias("maison/laurent")).toBe(false);
  });
});
