import type { MetadataRoute } from "next";
import { appOrigin } from "@/lib/env";
import { SITE_ROUTES } from "@/lib/site/routes";

/**
 * Generated from the route table, so a page added there is indexed without a
 * second edit.
 *
 * `lastModified` comes from the table rather than from `new Date()`. A
 * build-time date tells a crawler every page changed on every deploy, which is
 * a signal it learns to discount — and then real changes go unnoticed too.
 */
export default function sitemap(): MetadataRoute.Sitemap {
  const origin = appOrigin();

  return SITE_ROUTES.map((route) => ({
    url: `${origin}${route.path === "/" ? "" : route.path}`,
    lastModified: new Date(route.lastModified),
    changeFrequency: "monthly" as const,
    priority: route.priority,
  }));
}
