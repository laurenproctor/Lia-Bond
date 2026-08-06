import type { MetadataRoute } from "next";
import { appOrigin } from "@/lib/env";
import { PRODUCT_PATHS } from "@/middleware";

/**
 * The product surface is disallowed here, but that is not a security control —
 * every one of those paths already requires a session, and a crawler that
 * ignored this file would still be redirected to sign-in.
 *
 * What it buys is that sign-in and invitation pages stay out of search results,
 * and crawlers stop spending their budget on redirects instead of on the
 * marketing pages we want indexed.
 *
 * `PRODUCT_PATHS` is imported from `src/middleware.ts` rather than restated
 * here. Spec decision M10 is specifically about not keeping a route list in
 * two places: a second, hand-maintained copy is exactly how this file
 * previously drifted from the gate it was supposed to mirror — it had
 * `/reviews/` with a trailing slash the middleware's list never had, and it
 * was missing `/api` entirely. Importing the same array both routes and
 * disallows from cannot drift, by construction. `/api` is already covered by
 * this import, so `NON_PUBLIC_PATHS` below no longer repeats it.
 */
const NON_PUBLIC_PATHS = [
  "/auth/",
  "/invite/",
  "/sign-in",
  "/sign-up",
  "/forgot-password",
  "/reset-password",
];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: "*",
      allow: "/",
      disallow: [...PRODUCT_PATHS, ...NON_PUBLIC_PATHS],
    },
    sitemap: `${appOrigin()}/sitemap.xml`,
  };
}
