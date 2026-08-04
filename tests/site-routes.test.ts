import { describe, expect, it } from "vitest";
import {
  INDUSTRIES,
  SITE_FOOTER,
  SITE_NAV,
  SITE_ROUTES,
  isSitePath,
} from "@/lib/site/routes";

/**
 * The route table is the single source the navigation, the footer, the sitemap
 * and the middleware allowlist all read.
 *
 * The first suite is the one that matters: `src/middleware.ts` redirects every
 * path it does not recognise to `/sign-in`, so a marketing page missing from
 * this table is a page that bounces anonymous visitors to a login screen. That
 * is the bug this file exists to prevent recurring.
 */

describe("isSitePath", () => {
  it("admits every route in the table", () => {
    for (const route of SITE_ROUTES) {
      expect(isSitePath(route.path), route.path).toBe(true);
    }
  });

  it("admits the generated crawl files", () => {
    // Both are caught by the middleware matcher. Gating them would redirect
    // crawlers to /sign-in and de-index the site.
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
