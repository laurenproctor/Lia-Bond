import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  isTrustedLogoPath,
  normalizePublisherDomain,
  publisherDisplayName,
  PUBLISHER_LOGOS,
  resolvePublisherLogo,
} from "@/lib/widgets/press/publisher-logos";
import { SAMPLE_PRESS_PUBLISHER_DOMAINS } from "@/lib/widgets/press/sample";

/**
 * The publication logo registry, and the boundary around it.
 *
 * The press widget is the only thing Lia publishes that loads an image, and
 * every one of those images is a file Lia itself serves. The registry decides
 * *which* local file; the iframe's `img-src 'self' data:` decides that only
 * local files are possible. This suite tests the first half — that a domain
 * from a provider can only ever select a bundled asset, that the asset exists,
 * and that its declared dimensions are the file's own.
 *
 * The second half is tested in `tests/press-widget-render.test.ts`, which
 * asserts the rendered document names no remote origin.
 */

const PUBLIC_ROOT = join(resolve(process.cwd()), "public");

describe("normalising a publisher domain", () => {
  it.each([
    ["harbourledger.example", "harbourledger.example"],
    ["HarbourLedger.Example", "harbourledger.example"],
    ["www.harbourledger.example", "harbourledger.example"],
    ["https://www.harbourledger.example/food/story?utm=1", "harbourledger.example"],
    ["http://harbourledger.example:8443/story", "harbourledger.example"],
    ["harbourledger.example.", "harbourledger.example"],
    ["  harbourledger.example  ", "harbourledger.example"],
    ["news.harbourledger.example", "news.harbourledger.example"],
  ])("reduces %s to %s", (input, expected) => {
    expect(normalizePublisherDomain(input)).toBe(expected);
  });

  it.each([
    [null],
    [undefined],
    [""],
    ["   "],
    ["localhost"],
    ["intranet"],
    ["203.0.113.7"],
    ["user@harbourledger.example"],
    ["har bour.example"],
    ["../../etc/passwd"],
    ["/widget-logos/harbour-ledger/harbour-ledger.v1.svg"],
  ])("refuses %s, which falls back to text", (input) => {
    expect(normalizePublisherDomain(input as string | null)).toBeNull();
  });

  it("refuses a value long enough to be an attack rather than a hostname", () => {
    expect(normalizePublisherDomain(`${"a".repeat(300)}.example`)).toBeNull();
  });
});

describe("resolving a logo", () => {
  it("finds a registered publication by its exact domain", () => {
    const logo = resolvePublisherLogo("harbourledger.example");
    expect(logo?.key).toBe("harbour-ledger");
    expect(logo?.name).toBe("The Harbour Ledger");
  });

  it("normalises before looking up, rather than trusting the caller", () => {
    // The resolver normalises too. This is deliberate belt-and-braces on the
    // one value in the feature that selects an asset path.
    expect(resolvePublisherLogo("https://WWW.HarbourLedger.Example/story")?.key).toBe(
      "harbour-ledger",
    );
  });

  it.each([
    ["eater.com"],
    ["metrotribune.com"],
    ["timeout.com"],
    ["some-outlet-nobody-registered.com"],
  ])("returns null for %s, an unregistered publication", (domain) => {
    expect(resolvePublisherLogo(domain)).toBeNull();
  });

  it.each([
    ["../../../etc/passwd"],
    ["/widget-logos/harbour-ledger/harbour-ledger.v1.svg"],
    ["https://evil.example/logo.svg"],
    ["harbourledger.example.evil.example"],
  ])("cannot be made to select an asset by passing %s", (value) => {
    // The registry is keyed by normalised hostname, and a path, a URL, or a
    // look-alike domain is not one of its keys. There is no branch in which a
    // caller supplies an asset path.
    expect(resolvePublisherLogo(value)).toBeNull();
  });

  it("reads a traversal attempt as a host with a path, and keeps the host", () => {
    // `harbourledger.example/../meridian-table` normalises to
    // `harbourledger.example` — everything after the first slash is discarded
    // as a path. The result is the Harbour Ledger's own mark, which is the
    // right answer: the only thing a caller can influence is *which
    // registered publication* is chosen, never which file on disk.
    const logo = resolvePublisherLogo("harbourledger.example/../meridian-table");
    expect(logo?.key).toBe("harbour-ledger");
    expect(isTrustedLogoPath(logo?.light.path ?? "")).toBe(true);
  });

  it("returns null when nothing was reported at all", () => {
    expect(resolvePublisherLogo(null)).toBeNull();
    expect(resolvePublisherLogo(undefined)).toBeNull();
  });
});

describe("every bundled asset", () => {
  const entries = Object.entries(PUBLISHER_LOGOS);

  it("is registered under a normalised key", () => {
    for (const [domain] of entries) {
      expect(normalizePublisherDomain(domain), domain).toBe(domain);
    }
  });

  it.each(entries)("%s names only trusted paths", (_domain, logo) => {
    expect(isTrustedLogoPath(logo.light.path)).toBe(true);
    expect(isTrustedLogoPath(logo.dark.path)).toBe(true);
  });

  it.each(entries)("%s ships both themes on disk", (_domain, logo) => {
    for (const asset of [logo.light, logo.dark]) {
      expect(existsSync(join(PUBLIC_ROOT, asset.path)), asset.path).toBe(true);
    }
  });

  it.each(entries)("%s declares the dimensions the file itself carries", (_domain, logo) => {
    // A declared width that disagrees with the artwork is how a mark ends up
    // stretched — the single most recognisable way to make a publication look
    // like it did not consent to appear.
    for (const asset of [logo.light, logo.dark]) {
      const svg = readFileSync(join(PUBLIC_ROOT, asset.path), "utf8");
      expect(svg, asset.path).toContain(`viewBox="0 0 ${asset.width} ${asset.height}"`);
      expect(svg, asset.path).toContain(`width="${asset.width}"`);
      expect(svg, asset.path).toContain(`height="${asset.height}"`);
    }
  });

  it.each(entries)("%s keeps its mark subordinate to a headline", (_domain, logo) => {
    // The CSS caps rendered height at 20px; a design height far from 24
    // means the intrinsic aspect ratio would fight the box.
    expect(logo.light.height).toBe(24);
    expect(logo.dark.height).toBe(24);
  });

  it.each(entries)("%s records its provenance in the README", (_domain, logo) => {
    // A logo with no row in the provenance table is a logo nobody can defend.
    const readme = readFileSync(join(PUBLIC_ROOT, "widget-logos", "README.md"), "utf8");
    expect(readme).toContain(`${logo.key}/`);
    expect(readme).toContain(logo.name);
  });

  it("fetches nothing: no asset references a remote origin", () => {
    for (const [, logo] of entries) {
      for (const asset of [logo.light, logo.dark]) {
        const svg = readFileSync(join(PUBLIC_ROOT, asset.path), "utf8");
        expect(svg, asset.path).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
        // No script, no foreignObject, no external image — an SVG served to a
        // customer's page is markup, and these are the parts of it that are
        // not decoration.
        expect(svg, asset.path).not.toMatch(/<script|<foreignObject|<image/i);
      }
    }
  });

  it("has no orphan file on disk that the registry does not name", () => {
    const registered = new Set(
      entries.flatMap(([, logo]) => [logo.light.path, logo.dark.path]),
    );
    const root = join(PUBLIC_ROOT, "widget-logos");

    for (const dir of readdirSync(root, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      for (const file of readdirSync(join(root, dir.name))) {
        if (!file.endsWith(".svg")) continue;
        expect(
          registered.has(`/widget-logos/${dir.name}/${file}`),
          `${dir.name}/${file} is on disk but not in PUBLISHER_LOGOS`,
        ).toBe(true);
      }
    }
  });
});

describe("the shipped registry", () => {
  it("covers every publication the landing page's sample draws", () => {
    // The sample must render three marks, not three text fallbacks — the
    // whole point of putting it on the landing page is to show what the
    // widget looks like with logos in it.
    for (const domain of SAMPLE_PRESS_PUBLISHER_DOMAINS) {
      expect(resolvePublisherLogo(domain), domain).not.toBeNull();
    }
  });

  it("contains only invented publications, all under .example", () => {
    // RFC 2606 reserves `.example`, so a real customer can never be covered by
    // one of these and no trademark is reproduced. The day a real publication
    // is licensed, this expectation changes together with the README's
    // provenance table — deliberately, so nobody adds a real mark without
    // touching the file that records permission for it.
    for (const domain of Object.keys(PUBLISHER_LOGOS)) {
      expect(domain.endsWith(".example"), domain).toBe(true);
    }
  });
});

describe("the text fallback", () => {
  it("prefers the publisher's reported name", () => {
    expect(publisherDisplayName("Metro Tribune", "metrotribune.com")).toBe("Metro Tribune");
  });

  it("falls back to the normalised domain when no name was reported", () => {
    expect(publisherDisplayName(null, "https://www.metrotribune.com/x")).toBe(
      "metrotribune.com",
    );
    expect(publisherDisplayName("   ", "metrotribune.com")).toBe("metrotribune.com");
  });

  it("returns null rather than inventing a publisher", () => {
    // The card then draws no masthead row. "Unknown" tells a reader nothing
    // and looks like a bug.
    expect(publisherDisplayName(null, null)).toBeNull();
    expect(publisherDisplayName(null, "localhost")).toBeNull();
  });
});
