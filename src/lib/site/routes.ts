/**
 * The public marketing surface, in one place.
 *
 * Three consumers read this table: `SiteNav` reads `SITE_NAV`, `SiteFooter`
 * reads `SITE_FOOTER`, and `src/app/sitemap.ts` reads `SITE_ROUTES` directly.
 * `src/middleware.ts` is not a consumer — the gate there is a product
 * denylist (see the comment on `PRODUCT_PATHS` in that file), so a marketing
 * route only needs to exist here to show up in the sitemap and the nav; it was
 * never at risk of being redirected to `/sign-in`, and adding one does not
 * require touching the middleware.
 *
 * No `server-only` import: the navigation and footer render this on the client
 * side of the tree in places, and nothing here is a secret.
 */

/** An indexable page. Anchors are not routes — see `SITE_NAV`. */
export interface SiteRoute {
  path: string;
  /** Sitemap weight, 0–1. */
  priority: number;
  /**
   * Set deliberately, not from build time. A build-time date claims every page
   * changed on every deploy, which is noise a crawler learns to discount.
   * Bump the entry when the page's copy actually changes.
   */
  lastModified: string;
}

export interface SiteNavItem {
  label: string;
  href: string;
}

export interface SiteFooterColumn {
  heading: string;
  links: readonly SiteNavItem[];
}

export type IndustrySlug =
  | "hotels"
  | "restaurants"
  | "salons-and-barbershops"
  | "med-spas";

export interface Industry {
  slug: IndustrySlug;
  /** Footer and navigation label. Sentence case. */
  label: string;
}

const LAUNCH = "2026-08-04";

export const INDUSTRIES: readonly Industry[] = [
  { slug: "hotels", label: "Hotels" },
  { slug: "restaurants", label: "Restaurants" },
  { slug: "salons-and-barbershops", label: "Salons and barbershops" },
  { slug: "med-spas", label: "Med spas" },
] as const;

export const SITE_ROUTES: readonly SiteRoute[] = [
  { path: "/", priority: 1.0, lastModified: LAUNCH },
  { path: "/product", priority: 0.8, lastModified: LAUNCH },
  { path: "/platforms", priority: 0.8, lastModified: LAUNCH },
  { path: "/pricing", priority: 0.8, lastModified: LAUNCH },
  { path: "/for/hotels", priority: 0.7, lastModified: LAUNCH },
  { path: "/for/restaurants", priority: 0.7, lastModified: LAUNCH },
  { path: "/for/salons-and-barbershops", priority: 0.7, lastModified: LAUNCH },
  { path: "/for/med-spas", priority: 0.7, lastModified: LAUNCH },
  { path: "/contact", priority: 0.5, lastModified: LAUNCH },
  { path: "/privacy", priority: 0.3, lastModified: LAUNCH },
  { path: "/terms", priority: 0.3, lastModified: LAUNCH },
] as const;

/**
 * "Approach" is an anchor, not a route: it points at a section of the home
 * page, matching the reference navigation. It therefore appears here and never
 * in `SITE_ROUTES`, so the sitemap does not emit it as a separate URL.
 */
export const SITE_NAV: readonly SiteNavItem[] = [
  { label: "Product", href: "/product" },
  { label: "Platforms", href: "/platforms" },
  { label: "Pricing", href: "/pricing" },
  { label: "Approach", href: "/#judgment" },
] as const;

export const SITE_FOOTER: readonly SiteFooterColumn[] = [
  {
    heading: "Product",
    links: [
      { label: "How it works", href: "/product" },
      { label: "Platforms", href: "/platforms" },
      { label: "Pricing", href: "/pricing" },
      { label: "Our approach", href: "/#judgment" },
    ],
  },
  {
    heading: "For",
    links: INDUSTRIES.map((industry) => ({
      label: industry.label,
      href: `/for/${industry.slug}`,
    })),
  },
  {
    heading: "Company",
    links: [
      { label: "Contact", href: "/contact" },
      { label: "Sign in", href: "/sign-in" },
      { label: "Privacy", href: "/privacy" },
      { label: "Terms", href: "/terms" },
    ],
  },
] as const;
