import type { MetadataRoute } from "next";
import { appOrigin } from "@/lib/env";

/**
 * The product surface is disallowed here, but that is not a security control —
 * every one of those paths already requires a session, and a crawler that
 * ignored this file would still be redirected to sign-in.
 *
 * What it buys is that sign-in and invitation pages stay out of search results,
 * and crawlers stop spending their budget on redirects instead of on the
 * marketing pages we want indexed.
 */
const PRODUCT_PATHS = [
  "/overview",
  "/mentions",
  "/reviews/",
  "/reddit/",
  "/media/",
  "/responses",
  "/escalations",
  "/insights",
  "/locations",
  "/rules",
  "/integrations",
  "/brand-voice",
  "/settings",
  "/help",
];

const NON_PUBLIC_PATHS = [
  "/api/",
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
