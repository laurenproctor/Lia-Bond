/**
 * The public marketing surface, in one place.
 *
 * Four consumers read this table: the site navigation, the site footer,
 * `src/app/sitemap.ts`, and — the load-bearing one — `isSitePath` in
 * `src/middleware.ts`.
 *
 * That last consumer is why the table exists rather than each component
 * listing its own links. The middleware redirects any path it does not
 * recognise to `/sign-in`, so a marketing page added to the navigation but not
 * to an allowlist would render for the author (signed in) and bounce every
 * real visitor. One table means adding a route cannot produce that state.
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

/**
 * Generated files that Next serves from the app directory. The middleware
 * matcher excludes static assets but not these, so they need explicit
 * admission or a crawler fetching them is redirected to the sign-in page.
 */
const GENERATED_PUBLIC_FILES = ["/robots.txt", "/sitemap.xml"] as const;

const PUBLIC_SITE_PATHS: ReadonlySet<string> = new Set([
  ...SITE_ROUTES.map((route) => route.path),
  ...GENERATED_PUBLIC_FILES,
]);

/**
 * Exact match only, deliberately.
 *
 * A prefix test would admit `/pricing-internal` and any future private route
 * that happened to share a prefix with a marketing page. The table is complete,
 * so there is nothing to gain by being loose.
 */
export function isSitePath(pathname: string): boolean {
  return PUBLIC_SITE_PATHS.has(pathname);
}
