import { describe, expect, it } from "vitest";
import { INDUSTRIES, SITE_FOOTER, SITE_NAV, SITE_ROUTES } from "@/lib/site/routes";
import { PRODUCT_PATHS, isProductPath } from "@/proxy";

/**
 * The route table is the single source the navigation, the footer and the
 * sitemap read.
 *
 * `src/proxy.ts` gates the opposite way: it redirects an anonymous
 * request only when the path is a *known product route* (`isProductPath`,
 * tested below), and lets everything else — including any marketing page
 * missing from `SITE_ROUTES`, and any unknown path — fall through to Next.
 * That inversion is deliberate: the old allowlist bounced every URL it did
 * not recognise to `/sign-in`, which meant a mistyped marketing link or a
 * dead search-engine result landed a stranger on a login form instead of a
 * 404.
 */

/**
 * `isProductPath` is the actual authentication gate: `src/proxy.ts`
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

  it("does not protect the cron routes, which have no session to gate on", () => {
    // The one carve-out inside "/api", and the reason `SESSIONLESS_PATHS` is
    // checked before `PRODUCT_PATHS`. Vercel Cron invokes these with no
    // browser session at all, so gating them would redirect every scheduled
    // invocation to "/sign-in" and the handler's own `CRON_SECRET` check
    // would never run — every poll and analysis sweep silently stops.
    //
    // This assertion exists because that failure is invisible: nothing errors,
    // the routes still build, and the only symptom is data that quietly stops
    // arriving. The two branches that own these routes and this gate were
    // developed in parallel and never saw each other until they were merged.
    for (const path of [
      "/api/cron",
      "/api/cron/news-poll",
      "/api/cron/analyze-mentions",
    ]) {
      expect(isProductPath(path), path).toBe(false);
    }
  });

  it("still protects an API path that only shares a prefix with the carve-out", () => {
    // Segment match, not `startsWith`, on the exemption too — otherwise a
    // future "/api/cronjobs" or "/api/cron-admin" would inherit the bypass and
    // be reachable with no session at all. The carve-out is the more dangerous
    // direction of the two, so it gets its own assertion.
    for (const path of ["/api/cronjobs", "/api/cron-admin"]) {
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
