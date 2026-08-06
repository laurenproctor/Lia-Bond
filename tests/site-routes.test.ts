import { describe, expect, it } from "vitest";
import {
  INDUSTRIES,
  SITE_FOOTER,
  SITE_NAV,
  SITE_ROUTES,
  isSitePath,
} from "@/lib/site/routes";
import { PRODUCT_PATHS, isProductPath } from "@/middleware";

/**
 * The route table is the single source the navigation, the footer and the
 * sitemap read.
 *
 * `src/middleware.ts` gates the opposite way: it redirects an anonymous
 * request only when the path is a *known product route* (`isProductPath`,
 * tested below), and lets everything else — including any marketing page
 * missing from `SITE_ROUTES`, and any unknown path — fall through to Next.
 * That inversion is deliberate: the old allowlist bounced every URL it did
 * not recognise to `/sign-in`, which meant a mistyped marketing link or a
 * dead search-engine result landed a stranger on a login form instead of a
 * 404. `isSitePath` still matters — it is what the sitemap and the nav read
 * — but it has no role in deciding what gets redirected any more.
 */

describe("isSitePath", () => {
  it("admits every route in the table", () => {
    for (const route of SITE_ROUTES) {
      expect(isSitePath(route.path), route.path).toBe(true);
    }
  });

  it("admits the generated crawl files", () => {
    expect(isSitePath("/robots.txt")).toBe(true);
    expect(isSitePath("/sitemap.xml")).toBe(true);
  });

  it("does not admit product routes", () => {
    for (const path of ["/overview", "/mentions", "/settings", "/escalations"]) {
      expect(isSitePath(path), path).toBe(false);
    }
  });

  it("does not admit a prefix match", () => {
    // "/pricing-internal" starts with a real route but is not one.
    expect(isSitePath("/pricing-internal")).toBe(false);
  });
});

/**
 * `isProductPath` is the actual authentication gate: `src/middleware.ts`
 * redirects an anonymous visitor to `/sign-in` exactly when this returns
 * true. These are the tests that would have caught the old bug, restated for
 * the new posture — and they fail against the pre-inversion allowlist for the
 * right reason: that implementation gated on the *complement* of the site
 * table, so an unknown path like "/nope" or "/for/dentists" was redirected
 * to sign-in instead of falling through to a 404.
 */
describe("isProductPath", () => {
  it("protects every listed product route", () => {
    for (const path of PRODUCT_PATHS) {
      expect(isProductPath(path), path).toBe(true);
    }
  });

  it("protects nested paths under a product route", () => {
    for (const path of [
      "/reviews/google/abc-123",
      "/reddit/thread-9",
      "/media/press-1",
      "/settings/team",
    ]) {
      expect(isProductPath(path), path).toBe(true);
    }
  });

  it("protects API routes", () => {
    // Under the old allowlist, no "/api/..." path was ever admitted, so an
    // anonymous request was always redirected to sign-in. The OAuth callback
    // and the review-sync endpoint rely on that: only a signed-in visitor
    // reaches them. The denylist must keep gating "/api" or that protection
    // silently disappears.
    for (const path of [
      "/api/integrations/google-business-profile/connect",
      "/api/integrations/google-business-profile/callback",
      "/api/integrations/google-business-profile/reviews/sync",
    ]) {
      expect(isProductPath(path), path).toBe(true);
    }
  });

  it("does not protect a marketing path that only shares a prefix", () => {
    // A hypothetical marketing page sharing a prefix with "/overview" must
    // not be swept into the gate by a naive `startsWith`.
    for (const path of ["/overview-of-pricing", "/settings-guide", "/help-center"]) {
      expect(isProductPath(path), path).toBe(false);
    }
  });

  it("does not protect the marketing routes", () => {
    for (const route of SITE_ROUTES) {
      expect(isProductPath(route.path), route.path).toBe(false);
    }
  });

  it("does not protect unknown paths", () => {
    // The behaviour change this file exists to lock in: an unrecognised path
    // is no longer redirected to sign-in, so it can render a real 404.
    for (const path of ["/nope", "/for/dentists", "/pricng"]) {
      expect(isProductPath(path), path).toBe(false);
    }
  });

  it("does not protect the auth screens", () => {
    for (const path of [
      "/sign-in",
      "/sign-up",
      "/forgot-password",
      "/reset-password",
      "/invite",
    ]) {
      expect(isProductPath(path), path).toBe(false);
    }
  });
});

describe("navigation", () => {
  it("links only to real routes or on-page anchors", () => {
    const paths = new Set(SITE_ROUTES.map((route) => route.path));
    const targets = [
      ...SITE_NAV.map((item) => item.href),
      ...SITE_FOOTER.flatMap((column) => column.links.map((link) => link.href)),
    ];

    for (const href of targets) {
      if (href.startsWith("/#") || href === "/sign-in") continue;
      expect(paths.has(href), href).toBe(true);
    }
  });

  it("gives every industry a route", () => {
    const paths = new Set(SITE_ROUTES.map((route) => route.path));
    for (const industry of INDUSTRIES) {
      expect(paths.has(`/for/${industry.slug}`), industry.slug).toBe(true);
    }
  });
});

describe("sitemap metadata", () => {
  it("gives every route a usable priority", () => {
    for (const route of SITE_ROUTES) {
      expect(route.priority).toBeGreaterThan(0);
      expect(route.priority).toBeLessThanOrEqual(1);
    }
  });

  it("dates every route explicitly rather than at build time", () => {
    for (const route of SITE_ROUTES) {
      expect(route.lastModified, route.path).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });
});
