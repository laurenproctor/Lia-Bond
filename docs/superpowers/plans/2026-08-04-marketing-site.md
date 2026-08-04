# Marketing site implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the public Lia.bond marketing site — eleven statically rendered pages at `/`, a working early-access form that persists and notifies, and the crawl surface a public site needs.

**Architecture:** A `(site)` route group inside the existing Next.js app owns `/` and ten more public paths. A single route table (`src/lib/site/routes.ts`) feeds the navigation, the footer, the sitemap, and the middleware's public-path check, so a new page cannot silently land behind the auth gate. Marketing design tokens live in the existing `@theme` block under a `site-` prefix. Pages compose a small primitive library and stay well under the 300-line guideline.

**Tech Stack:** Next.js 16 (App Router), React 19, TypeScript strict, Tailwind CSS 4, Zod 4, Supabase, Resend, Vitest.

**Spec:** `docs/superpowers/specs/2026-08-04-marketing-site-design.md`

## Global constraints

- **Sentence case throughout the interface.** Headings, buttons, labels, nav items. Never Title Case.
- **Server components by default.** The only client components are `SiteNav` (mobile disclosure), `AccessForm` (the form), and `(site)/error.tsx` (Next requires error boundaries to be client components).
- **TypeScript strict. No `any`** unless justified in a comment.
- **No page component over ~300 lines.**
- **Never imply direct publishing where the connector does not support it** (CLAUDE.md rule 6). Platform claims derive from `src/domain/entities/platform.ts` and `src/lib/seed/dataset.ts`, not from the reference copy.
- **Accessible labels and keyboard states.** Every interactive element reachable and visibly focused.
- **No inline secrets.**
- **Palette is fixed by Task 2.** Never hand-write a hex value in a component; use the `site-*` tokens.
- **Font stack:** Inter stays on `<html>` as the application default — six auth routes have no group layout and depend on it. `(site)` overrides with Geist via the `font-site` utility. See Task 3.
- **Commit after every task.**

---

## File structure

| File | Responsibility |
| --- | --- |
| `src/lib/site/routes.ts` | The route table. Nav, footer, sitemap, middleware all read it |
| `src/lib/site/early-access.ts` | Pure validation + message composition for the form |
| `src/lib/site/content/*.ts` | Typed copy records per page |
| `src/app/actions/early-access.ts` | The one public server action |
| `src/components/site/*.tsx` | Marketing primitives |
| `src/app/(site)/**` | Eleven routes, group layout, error boundary |
| `src/app/robots.ts`, `src/app/sitemap.ts` | Crawl surface |
| `supabase/migrations/20260806*.sql` | `early_access_requests` + its RLS |
| `tests/site-*.test.ts`, `tests/early-access.test.ts` | Vitest suites |

---

## Task 1: Route table and the public gate

The highest-risk change in the project. `src/middleware.ts` currently redirects any path not in `PUBLIC_PATHS` to `/sign-in`, and `/` is not in that list — so without this task the marketing homepage bounces every anonymous visitor to a sign-in screen. `/robots.txt` and `/sitemap.xml` are caught by the same matcher and must be allowed too, or crawlers get redirected.

**Files:**
- Create: `src/lib/site/routes.ts`
- Modify: `src/middleware.ts`
- Test: `tests/site-routes.test.ts`

**Interfaces:**
- Produces: `SITE_ROUTES: readonly SiteRoute[]`, `SITE_NAV: readonly SiteNavItem[]`, `SITE_FOOTER: readonly SiteFooterColumn[]`, `INDUSTRIES: readonly Industry[]`, `isSitePath(pathname: string): boolean`, types `SiteRoute`, `SiteNavItem`, `SiteFooterColumn`, `Industry`, `IndustrySlug`

- [ ] **Step 1: Write the failing test**

Create `tests/site-routes.test.ts`:

```ts
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
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/site-routes.test.ts`
Expected: FAIL — cannot resolve `@/lib/site/routes`.

- [ ] **Step 3: Write the route table**

Create `src/lib/site/routes.ts`:

```ts
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
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/site-routes.test.ts`
Expected: PASS, 6 tests.

- [ ] **Step 5: Open the gate in middleware**

In `src/middleware.ts`, add the import at the top alongside the existing ones:

```ts
import { isSitePath } from "@/lib/site/routes";
```

Then extend the redirect condition. Find:

```ts
  if (!user && !isPublic(pathname)) {
```

Replace with:

```ts
  // `isSitePath` is separate from `isPublic` rather than folded into it because
  // the two answer different questions: `isPublic` means "an auth screen that
  // must stay reachable without a session", `isSitePath` means "public
  // marketing". Merging them would blur a distinction the comments above
  // explain carefully.
  if (!user && !isPublic(pathname) && !isSitePath(pathname)) {
```

- [ ] **Step 6: Verify the gate by hand**

Run: `npm run dev`

With `NEXT_PUBLIC_SUPABASE_URL` and `NEXT_PUBLIC_SUPABASE_ANON_KEY` set and no session cookie, request `/pricing`. Expected: a 404 from Next (the route does not exist yet) — **not** a 307 redirect to `/sign-in`. The 404 proves the gate opened.

```bash
curl -s -o /dev/null -w "%{http_code} %{redirect_url}\n" http://localhost:3000/pricing
```

Expected: `404` with an empty redirect target. If you see `307 .../sign-in`, the middleware edit did not take.

- [ ] **Step 7: Run the full suite and commit**

```bash
npm run typecheck && npx vitest run
git add src/lib/site/routes.ts src/middleware.ts tests/site-routes.test.ts
git commit -m "Add the marketing route table and open the public gate"
```

---

## Task 2: Design tokens and the contrast guard

The reference palette fails WCAG AA in six places, the primary CTA worst at 2.60:1. This task lands the corrected tokens and a test that re-measures them from the stylesheet on every run, so the correction cannot silently regress.

**Files:**
- Modify: `src/app/globals.css`
- Test: `tests/site-palette.test.ts`

**Interfaces:**
- Produces: Tailwind utilities `bg-site-*`, `text-site-*`, `border-site-*`, `font-site`; CSS custom properties `--color-site-*`

- [ ] **Step 1: Write the failing test**

Create `tests/site-palette.test.ts`:

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Contrast, measured from the stylesheet rather than from a copy of it.
 *
 * The marketing palette comes from a design reference whose own values fail
 * WCAG AA in six places — the primary call to action worst, at 2.60:1 for white
 * on #FF7A2E. Those values were darkened deliberately, and the reasoning is in
 * docs/superpowers/specs/2026-08-04-marketing-site-design.md.
 *
 * This file parses `globals.css` instead of restating the hex values so that
 * there is exactly one place to change a colour. A token edited in the
 * stylesheet is measured here on the next run; a token restated in a fixture
 * would drift and the suite would pass while the site regressed.
 */

const CSS = readFileSync(
  fileURLToPath(new URL("../src/app/globals.css", import.meta.url)),
  "utf8",
);

function token(name: string): string {
  const match = CSS.match(new RegExp(`--color-site-${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!match) throw new Error(`--color-site-${name} is not defined in globals.css`);
  return match[1];
}

/** WCAG 2.1 relative luminance. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
  const linear = channels.map((c) =>
    c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4,
  );
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE = "#FFFFFF";
const AA_TEXT = 4.5;
/** WCAG 1.4.11: interactive boundaries, not ornament. */
const AA_NON_TEXT = 3;

describe("text on the white surface", () => {
  it.each([
    ["body", AA_TEXT],
    ["muted", AA_TEXT],
    ["ink", AA_TEXT],
    ["blue", AA_TEXT],
  ])("%s clears %s:1", (name, threshold) => {
    expect(contrast(token(name), WHITE)).toBeGreaterThanOrEqual(threshold);
  });
});

describe("text on the tinted section fill", () => {
  it.each(["body", "muted", "ink"])("%s clears AA on the tint", (name) => {
    expect(contrast(token(name), token("tint"))).toBeGreaterThanOrEqual(AA_TEXT);
  });
});

describe("text on the ink surface", () => {
  it("the dark-surface muted grey clears AA", () => {
    // #8A93A3 is 2.93:1 on the tint and unusable there, but 6.19:1 on ink —
    // so it survives unchanged for footer headings and the dark pricing card.
    expect(contrast(token("muted-dark"), token("ink"))).toBeGreaterThanOrEqual(
      AA_TEXT,
    );
  });
});

describe("the primary call to action", () => {
  it("clears AA with an ink label on the brand orange", () => {
    // The reference puts white on this fill: 2.60:1, failing AA and even the
    // 3:1 large-text floor. Darkening the label instead of the fill keeps the
    // brand orange exactly as specified.
    expect(contrast(token("ink"), token("orange"))).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("still clears AA in the hover state", () => {
    expect(
      contrast(token("ink"), token("orange-hover")),
    ).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("would fail with a white label, which is why it does not have one", () => {
    expect(contrast(WHITE, token("orange"))).toBeLessThan(AA_TEXT);
  });
});

describe("interactive boundaries", () => {
  it("the form-control border clears 1.4.11", () => {
    expect(contrast(token("field"), WHITE)).toBeGreaterThanOrEqual(AA_NON_TEXT);
  });
});

describe("speech bubble metadata", () => {
  it("blue metadata clears AA on its own fill", () => {
    expect(
      contrast(token("blue-meta"), token("blue-tint")),
    ).toBeGreaterThanOrEqual(AA_TEXT);
  });

  it("amber metadata clears AA on its own fill", () => {
    expect(
      contrast(token("amber-meta"), token("amber-tint")),
    ).toBeGreaterThanOrEqual(AA_TEXT);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/site-palette.test.ts`
Expected: FAIL — `--color-site-body is not defined in globals.css`.

- [ ] **Step 3: Add the tokens**

In `src/app/globals.css`, inside the existing `@theme { … }` block, after the `--shadow-panel` line and before the closing brace, add:

```css
  /* ---------------------------------------------------------------------
     Marketing site.

     Public routes under `(site)` use a different brand from the product: the
     reference is a Claude Design artifact — white surfaces, ink headings, a
     brand orange, a supporting blue, and hand-drawn speech bubbles.

     Six values are darkened from the reference to clear WCAG AA. Each is a
     same-hue darkening, so the site still reads as the reference. The
     reasoning is in docs/superpowers/specs/2026-08-04-marketing-site-design.md
     and `tests/site-palette.test.ts` re-measures every one of them from this
     file on each run.

     Prefixed because `@theme` is global: without `site-`, these would collide
     with the product's navy and purple scales above.
     --------------------------------------------------------------------- */
  --color-site-ink: #0b0f18;
  --color-site-body: #3a4454;
  /* Reference #8A93A3 — 2.93:1 on the tint. */
  --color-site-muted: #697386;
  /* The reference grey, kept for the ink surface where it measures 6.19:1. */
  --color-site-muted-dark: #8a93a3;
  /* Ornament only. Form controls take --color-site-field. */
  --color-site-border: #e6eaf0;
  /* Reference #E6EAF0 — 1.21:1, failing WCAG 1.4.11 on an input. */
  --color-site-field: #8296b4;
  --color-site-tint: #f6f9fd;

  --color-site-orange: #ff7a2e;
  --color-site-orange-hover: #e8651c;

  /* Reference #0D88FF — 3.51:1 as text. Kept below for non-text use. */
  --color-site-blue: #0074e5;
  /* Strokes, dots, rules. Never carries text. */
  --color-site-blue-mark: #0d88ff;
  --color-site-blue-tint: #eaf3ff;
  --color-site-blue-edge: #a8d0ff;
  --color-site-blue-ink: #13314f;
  /* Reference #5E83A6 — 3.56:1. */
  --color-site-blue-meta: #507292;

  --color-site-amber-tint: #fff3ea;
  --color-site-amber-edge: #c0521a;
  --color-site-amber-ink: #9a3f12;
  /* Reference #B97A52 — 3.23:1. */
  --color-site-amber-meta: #9c633f;

  --font-site: var(--font-geist), ui-sans-serif, system-ui, -apple-system,
    "Segoe UI", Roboto, sans-serif;
```

- [ ] **Step 4: Scope the base styles to the site surface**

The `@layer base` block styles `body` for the product — `bg-gray-50`, 14px, a purple focus ring and a purple selection. The site wrapper carries `data-surface="site"` (Task 6) so those can be overridden without touching the product.

In `src/app/globals.css`, inside `@layer base`, after the existing `[data-surface="dark"] :focus-visible` rule, add:

```css
  /* The marketing site's own keyboard and selection colours. Scoped to the
     wrapper `(site)/layout.tsx` renders, so the product keeps its purple. */
  [data-surface="site"] :focus-visible {
    outline-color: var(--color-site-blue);
  }

  [data-surface="site"] ::selection {
    background: var(--color-site-blue-mark);
    color: #ffffff;
  }
```

- [ ] **Step 5: Add the bubble motion**

Still in `src/app/globals.css`, after the `lia-shimmer` keyframes, add:

```css
/* The speech bubbles drift. Decorative only — nothing is communicated by the
   movement, which is why the reduced-motion block below stops it outright
   rather than shortening it. */
@keyframes lia-float-a {
  0%,
  100% {
    transform: translateY(0) rotate(-4.5deg);
  }
  50% {
    transform: translateY(-7px) rotate(-4.5deg);
  }
}

@keyframes lia-float-b {
  0%,
  100% {
    transform: translateY(0) rotate(5deg);
  }
  50% {
    transform: translateY(-5px) rotate(5deg);
  }
}

@utility site-float-a {
  animation: lia-float-a 6.5s ease-in-out infinite;
}

@utility site-float-b {
  animation: lia-float-b 5.8s ease-in-out infinite;
}
```

Then find the existing `@media (prefers-reduced-motion: reduce)` block at the end of the file and add these rules inside it:

```css
  .site-float-a,
  .site-float-b {
    animation: none;
  }
```

- [ ] **Step 6: Run the test to verify it passes**

Run: `npx vitest run tests/site-palette.test.ts`
Expected: PASS. The `it.each` blocks produce 11 assertions across 6 describes.

- [ ] **Step 7: Commit**

```bash
git add src/app/globals.css tests/site-palette.test.ts
git commit -m "Add marketing design tokens with AA contrast corrections"
```

---

## Task 3: Document the two-font arrangement

**Amended after the pre-flight scan.** The original task moved Inter out of the
root layout and into `(app)`. That would have been correct if every route lived
in a group — but six do not. `/sign-in`, `/sign-up`, `/forgot-password`,
`/reset-password`, `/invite`, and `/auth` sit directly under `src/app` with no
layout of their own, so removing the root font variable would have dropped Inter
on all six and left them on the system stack.

So Inter stays on `<html>` as the application-wide default, and the `(site)`
layout overrides it with Geist for marketing routes only. `(app)` needs no
change at all.

The mechanism worth understanding, because Task 6 depends on it: `body` computes
`font-family: var(--font-sans)` at the body element, and descendants inherit the
*already-computed* value. Declaring `--font-geist` on a wrapper is therefore not
enough on its own — the wrapper must also re-declare `font-family`, which is
what the `font-site` utility does. Variable plus utility, together, or Geist
never takes effect.

The cost accepted here: Inter is preloaded on marketing routes where Geist
actually renders. Step 2 measures it so the number is known rather than assumed.

**Files:**
- Modify: `src/app/layout.tsx` (comment only, no behaviour change)

- [ ] **Step 1: Record why the root font stays**

In `src/app/layout.tsx`, replace the bare `inter` constant declaration:

```ts
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});
```

with the same declaration carrying its reason:

```ts
/**
 * The application-wide default, set here rather than per route group.
 *
 * Six routes — /sign-in, /sign-up, /forgot-password, /reset-password, /invite,
 * and /auth — sit directly under `src/app` with no layout of their own, so this
 * is the only place that can give them a typeface. Moving Inter down into
 * `(app)` would silently drop them onto the system stack.
 *
 * The marketing site overrides this in `(site)/layout.tsx`, which declares
 * Geist and re-applies `font-family` via the `font-site` utility. Re-applying
 * is required, not decorative: `body` resolves `var(--font-sans)` here, and
 * descendants inherit that computed value rather than re-resolving the
 * variable.
 */
const inter = Inter({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-inter",
});
```

Change nothing else. `<html className={inter.variable}>` stays exactly as it is.

- [ ] **Step 2: Confirm the auth routes still have Inter**

Run: `npm run dev`, open `http://localhost:3000/sign-in`, and inspect the
heading in devtools.

Expected: `font-family` resolves to a name containing `__Inter`. This is the
regression the pre-flight scan caught; the check exists so it stays caught.

- [ ] **Step 3: Typecheck and commit**

```bash
npm run typecheck
git add src/app/layout.tsx
git commit -m "Record why the root layout owns the default font"
```

---

## Task 4: The wordmark

**Files:**
- Create: `src/components/site/logo-mark.tsx`

**Interfaces:**
- Produces: `LogoMark({ className }: { className?: string })`

The reference ships the logo as two 1024×1024 PNGs — one a blue neon mark on a solid black tile, which would render as a black square on the white navigation. This builds it as type plus an inline SVG bubble instead: it takes `currentColor`, so one component serves the ink navigation and the cream footer, and it stays crisp at any size.

**This approximates the reference artwork rather than tracing it.** If a designer supplies a true vector wordmark, it drops into this one file.

- [ ] **Step 1: Write the component**

Create `src/components/site/logo-mark.tsx`:

```tsx
/**
 * The Lia wordmark: "lia", with the dot of the i replaced by a speech bubble.
 *
 * Type plus one small SVG rather than an image. The reference ships a raster
 * whose navigation variant is a blue mark on an opaque black tile — a black
 * square against a white bar — and the pair weighs 1.6MB. This takes
 * `currentColor`, so the same component renders ink on the white navigation and
 * cream on the dark footer, and it stays sharp at any size.
 *
 * The bubble is the product's own idea in miniature: public speech, held and
 * handled. It reappears at full size as the testimonial motif.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <span
      className={`relative inline-flex items-baseline font-site text-[27px] leading-none font-semibold tracking-[-0.045em] select-none ${className ?? ""}`}
      // The bubble is decorative; the accessible name comes from the wrapper.
      aria-hidden="true"
    >
      l
      <span className="relative">
        {/* The stem of the i, dotless — the bubble below is its dot. */}
        <span className="relative">ı</span>
        <svg
          viewBox="0 0 24 24"
          className="absolute -top-[0.62em] left-1/2 h-[0.52em] w-[0.52em] -translate-x-1/2 overflow-visible"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M12 1.6a10.4 10.4 0 1 1-6.7 18.35l-3.1 1.35a.5.5 0 0 1-.68-.63l1.15-3.2A10.4 10.4 0 0 1 12 1.6Z"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      a
    </span>
  );
}
```

- [ ] **Step 2: Typecheck and commit**

```bash
npm run typecheck
git add src/components/site/logo-mark.tsx
git commit -m "Add the Lia wordmark as an inline vector"
```

---

## Task 5: Layout primitives

The shared vocabulary every page composes from. All server components.

**Files:**
- Create: `src/components/site/section.tsx`
- Create: `src/components/site/speech-bubble.tsx`
- Create: `src/components/site/button.tsx`

**Interfaces:**
- Consumes: nothing
- Produces:
  - `Section({ children, tinted?, className?, id? })`
  - `Eyebrow({ children })`
  - `PageHeading({ children, className? })` — the `clamp(38px,5vw,64px)` display scale
  - `SectionHeading({ children, className? })` — the `clamp(26px,3.4vw,40px)` scale
  - `Lede({ children, className? })`
  - `SpeechBubble({ quote, attribution, tone, float?, className? })` where `tone: "blue" | "amber" | "plain"` and `float?: "a" | "b"`
  - `BubbleFilters()` — the shared SVG filter defs. Rendered once by `(site)/layout.tsx` in Task 6, so no page imports it
  - `PrimaryButton({ href, children, className? })`, `SecondaryButton({ href, children, className? })`

- [ ] **Step 1: Write the section primitives**

Create `src/components/site/section.tsx`:

```tsx
import type { ReactNode } from "react";

/**
 * Page rhythm.
 *
 * The gutter and vertical clamps come from the design reference and are the
 * single reason every marketing page lines up. Pages set content; they do not
 * set spacing.
 */

const SHELL = "mx-auto w-full max-w-[1200px] px-[clamp(24px,6vw,106px)]";

export function Section({
  children,
  tinted = false,
  className,
  id,
}: {
  children: ReactNode;
  /** The alternating pale fill, with hairlines top and bottom. */
  tinted?: boolean;
  className?: string;
  id?: string;
}) {
  const band = tinted
    ? "bg-site-tint border-y border-site-border"
    : "bg-white";

  return (
    <section id={id} className={band}>
      <div
        className={`${SHELL} py-[clamp(56px,8vw,100px)] ${className ?? ""}`}
      >
        {children}
      </div>
    </section>
  );
}

/** The dot-and-tracked-caps label that opens a section. */
export function Eyebrow({ children }: { children: ReactNode }) {
  return (
    <div className="mb-6 inline-flex items-center gap-2.5">
      <span className="size-1.5 rounded-full bg-site-blue-mark shadow-[0_0_0_4px_rgb(13_136_255_/_0.16)]" />
      <span className="text-[12.5px] font-semibold tracking-[0.16em] text-site-muted uppercase">
        {children}
      </span>
    </div>
  );
}

export function PageHeading({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <h1
      className={`text-[clamp(38px,5vw,64px)] leading-[1.04] font-bold tracking-[-0.022em] text-site-ink ${className ?? ""}`}
    >
      {children}
    </h1>
  );
}

export function SectionHeading({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <h2
      className={`text-[clamp(26px,3.4vw,40px)] leading-[1.12] font-bold tracking-[-0.018em] text-site-ink ${className ?? ""}`}
    >
      {children}
    </h2>
  );
}

export function Lede({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <p className={`text-[19px] leading-[1.58] text-site-body ${className ?? ""}`}>
      {children}
    </p>
  );
}
```

- [ ] **Step 2: Write the buttons**

Create `src/components/site/button.tsx`:

```tsx
import Link from "next/link";
import type { ReactNode } from "react";

/**
 * The two marketing buttons.
 *
 * The primary carries an ink label on the brand orange, not a white one. White
 * on #FF7A2E measures 2.60:1 — below AA and below even the 3:1 large-text
 * floor — and darkening the fill instead would replace the signature colour on
 * every page's main action. `tests/site-palette.test.ts` holds this in place.
 */

export function PrimaryButton({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center justify-center rounded-[10px] bg-site-orange px-5 py-3 text-[14px] font-semibold text-site-ink transition-colors hover:bg-site-orange-hover ${className ?? ""}`}
    >
      {children}
    </Link>
  );
}

export function SecondaryButton({
  href,
  children,
  className,
}: {
  href: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <Link
      href={href}
      className={`inline-flex items-center justify-center rounded-[10px] border border-site-blue-edge px-5 py-3 text-[14px] font-semibold text-site-blue transition-colors hover:bg-[#eff5ff] ${className ?? ""}`}
    >
      {children}
    </Link>
  );
}
```

- [ ] **Step 3: Write the speech bubble**

Create `src/components/site/speech-bubble.tsx`:

```tsx
/**
 * The testimonial motif: a quote in a hand-drawn bubble.
 *
 * The wobble is a turbulence displacement filter over a plain rounded path, so
 * one path definition yields an edge that never repeats exactly. The two filter
 * definitions live in `BubbleFilters`, which the site layout renders once per
 * document rather than each bubble carrying its own — a page shows up to four
 * of these, and inline `<defs>` in each would be four copies of one turbulence.
 *
 * These are decoration. They are marked `aria-hidden` and carry
 * `pointer-events-none`: the quotes are illustrative, not attributed
 * testimonials from named customers, and presenting them to a screen reader as
 * quoted evidence would overstate them.
 */

const TONES = {
  blue: {
    fill: "var(--color-site-blue-tint)",
    stroke: "var(--color-site-blue-mark)",
    quote: "text-site-blue-ink",
    meta: "text-site-blue-meta",
    filter: "url(#lia-rough-a)",
  },
  amber: {
    fill: "var(--color-site-amber-tint)",
    stroke: "var(--color-site-amber-edge)",
    quote: "text-site-amber-ink",
    meta: "text-site-amber-meta",
    filter: "url(#lia-rough-b)",
  },
  plain: {
    fill: "#ffffff",
    stroke: "var(--color-site-ink)",
    quote: "text-site-ink",
    meta: "text-site-muted",
    filter: "url(#lia-rough-b)",
  },
} as const;

export type BubbleTone = keyof typeof TONES;

/** Shared filter definitions. Render once per page that uses bubbles. */
export function BubbleFilters() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden="true">
      <defs>
        <filter id="lia-rough-a" x="-18%" y="-18%" width="136%" height="136%">
          <feTurbulence
            type="turbulence"
            baseFrequency="0.016"
            numOctaves="2"
            seed="7"
            result="noise"
          />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="4.5" />
        </filter>
        <filter id="lia-rough-b" x="-18%" y="-18%" width="136%" height="136%">
          <feTurbulence
            type="turbulence"
            baseFrequency="0.02"
            numOctaves="2"
            seed="3"
            result="noise"
          />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="5" />
        </filter>
      </defs>
    </svg>
  );
}

export function SpeechBubble({
  quote,
  attribution,
  tone = "blue",
  float,
  className,
}: {
  quote: string;
  attribution: string;
  tone?: BubbleTone;
  /** Which drift cycle, or none. Disabled under prefers-reduced-motion. */
  float?: "a" | "b";
  className?: string;
}) {
  const style = TONES[tone];
  const drift = float === "a" ? "site-float-a" : float === "b" ? "site-float-b" : "";

  return (
    <div
      className={`pointer-events-none relative text-left ${drift} ${className ?? ""}`}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 220 96"
        preserveAspectRatio="none"
        className="absolute inset-0 size-full overflow-visible"
      >
        <path
          filter={style.filter}
          d="M18,5 H202 a13,13 0 0 1 13,13 V60 a13,13 0 0 1 -13,13 H66 L46,92 L51,73 H18 a13,13 0 0 1 -13,-13 V18 a13,13 0 0 1 13,-13 Z"
          fill={style.fill}
          stroke={style.stroke}
          strokeWidth="2.6"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      <div className="relative px-5 pt-3.5 pb-6">
        <p className={`text-[12.5px] leading-[1.34] font-medium ${style.quote}`}>
          {quote}
        </p>
        <p className={`mt-1.5 text-[10px] font-semibold tracking-[0.02em] ${style.meta}`}>
          {attribution}
        </p>
      </div>
    </div>
  );
}
```

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add src/components/site/
git commit -m "Add marketing layout primitives and the speech bubble motif"
```

---

## Task 6: Navigation, footer, and the group layout

**Files:**
- Create: `src/components/site/site-nav.tsx`
- Create: `src/components/site/site-footer.tsx`
- Create: `src/app/(site)/layout.tsx`
- Create: `src/app/(site)/error.tsx`
- Delete: `src/app/page.tsx`

**Interfaces:**
- Consumes: `SITE_NAV`, `SITE_FOOTER` from Task 1; `LogoMark` from Task 4; `PrimaryButton` from Task 5
- Produces: `SiteNav()`, `SiteFooter()`

- [ ] **Step 1: Write the navigation**

Create `src/components/site/site-nav.tsx`:

```tsx
"use client";

import Link from "next/link";
import { useState } from "react";
import { Menu, X } from "lucide-react";
import { LogoMark } from "@/components/site/logo-mark";
import { SITE_NAV } from "@/lib/site/routes";

/**
 * The one navigation every public page renders.
 *
 * A client component solely for the mobile disclosure. The links themselves are
 * static and the sign-in link needs no session check: `/sign-in` already
 * forwards an authenticated visitor to `/overview` (see `src/middleware.ts`),
 * so the marketing site never reads a session and every page stays statically
 * renderable.
 */
export function SiteNav() {
  const [open, setOpen] = useState(false);

  return (
    <nav className="sticky top-0 z-40 border-b border-site-border bg-white/85 backdrop-blur-[12px] backdrop-saturate-[140%]">
      <div className="mx-auto flex w-full max-w-[1200px] items-center justify-between gap-6 px-[clamp(24px,6vw,106px)] py-3.5">
        <Link
          href="/"
          className="flex items-center text-site-ink"
          aria-label="Lia, home"
        >
          <LogoMark />
        </Link>

        <div className="hidden items-center gap-8 md:flex">
          <div className="flex items-center gap-7">
            {SITE_NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                className="text-[14.5px] font-medium text-site-body transition-colors hover:text-site-ink"
              >
                {item.label}
              </Link>
            ))}
            <Link
              href="/sign-in"
              className="text-[14.5px] font-medium text-site-body transition-colors hover:text-site-ink"
            >
              Sign in
            </Link>
          </div>
          <PrimaryNavCta />
        </div>

        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="inline-flex size-9 items-center justify-center rounded-lg border border-site-border text-site-ink md:hidden"
          aria-expanded={open}
          aria-controls="site-nav-mobile"
          aria-label={open ? "Close menu" : "Open menu"}
        >
          {open ? <X className="size-4" /> : <Menu className="size-4" />}
        </button>
      </div>

      {open ? (
        <div
          id="site-nav-mobile"
          className="border-t border-site-border bg-white px-[clamp(24px,6vw,106px)] py-4 md:hidden"
        >
          <div className="flex flex-col gap-4">
            {SITE_NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                onClick={() => setOpen(false)}
                className="text-[15px] font-medium text-site-body"
              >
                {item.label}
              </Link>
            ))}
            <Link
              href="/sign-in"
              onClick={() => setOpen(false)}
              className="text-[15px] font-medium text-site-body"
            >
              Sign in
            </Link>
            <PrimaryNavCta onNavigate={() => setOpen(false)} />
          </div>
        </div>
      ) : null}
    </nav>
  );
}

function PrimaryNavCta({ onNavigate }: { onNavigate?: () => void }) {
  return (
    <Link
      href="/#access"
      onClick={onNavigate}
      className="inline-flex items-center justify-center rounded-[9px] bg-site-orange px-5 py-2.5 text-[14px] font-semibold whitespace-nowrap text-site-ink transition-colors hover:bg-site-orange-hover"
    >
      Request early access
    </Link>
  );
}
```

- [ ] **Step 2: Write the footer**

Create `src/components/site/site-footer.tsx`:

```tsx
import Link from "next/link";
import { LogoMark } from "@/components/site/logo-mark";
import { SITE_FOOTER } from "@/lib/site/routes";

/**
 * Rendered from the route table, so a page added to the table appears here
 * without a second edit — and cannot appear here while missing from the
 * middleware allowlist.
 *
 * `data-surface="dark"` switches the focus ring to white, reusing the rule the
 * product already defines for its navy surfaces.
 */
export function SiteFooter() {
  return (
    <footer className="bg-site-ink text-white" data-surface="dark">
      <div className="mx-auto grid w-full max-w-[1200px] grid-cols-1 gap-10 px-[clamp(24px,6vw,106px)] pt-[clamp(56px,6vw,84px)] pb-9 sm:grid-cols-2 lg:grid-cols-[1.4fr_1fr_1fr_1fr] lg:gap-[clamp(40px,6vw,110px)]">
        <div>
          <div className="mb-4 text-[#f3efe6]">
            <LogoMark className="text-[34px]" />
          </div>
          <p className="mb-2 max-w-[260px] text-[18px] leading-[1.4] text-[#e6eaf0]">
            Public feedback, handled with care.
          </p>
          <p className="text-[13px] text-site-muted-dark">Lia.bond</p>
        </div>

        {SITE_FOOTER.map((column) => (
          <div key={column.heading}>
            <h2 className="mb-4 text-[12px] font-semibold tracking-[0.12em] text-site-muted-dark uppercase">
              {column.heading}
            </h2>
            <div className="flex flex-col gap-3">
              {column.links.map((link) => (
                <Link
                  key={link.href}
                  href={link.href}
                  className="text-[14px] text-[#e6eaf0] transition-colors hover:text-white"
                >
                  {link.label}
                </Link>
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="mx-auto flex w-full max-w-[1200px] flex-wrap items-center justify-between gap-4 border-t border-[#3a4454] px-[clamp(24px,6vw,106px)] pt-4.5 pb-7">
        <span className="text-[12.5px] text-site-muted-dark">
          © 2026 Lia Bond. All rights reserved.
        </span>
        <span className="text-[12.5px] text-site-muted-dark">
          Respond with care, clarity, and control.
        </span>
      </div>
    </footer>
  );
}
```

- [ ] **Step 3: Write the group layout**

Create `src/app/(site)/layout.tsx`:

```tsx
import type { Metadata, Viewport } from "next";
import { Geist } from "next/font/google";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteNav } from "@/components/site/site-nav";
import { BubbleFilters } from "@/components/site/speech-bubble";
import { appOrigin } from "@/lib/env";

/**
 * The public marketing shell.
 *
 * Declared here rather than in the root layout so Next preloads Geist only on
 * marketing routes; the product loads Inter the same way in `(app)/layout.tsx`.
 *
 * `font-site` alongside the variable is not redundant — `body` resolves its
 * font-family above this element, where `--font-geist` is undefined, and
 * descendants inherit that computed value. The utility re-declares the family
 * where the variable is in scope.
 */
const geist = Geist({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-geist",
});

export const metadata: Metadata = {
  metadataBase: new URL(appOrigin()),
  title: {
    default: "Lia — know what to say when your reputation is public",
    template: "%s · Lia",
  },
  description:
    "Lia monitors your reviews, forums, and press from one workspace, drafts replies in your voice, and holds the sensitive ones for a person to approve.",
  openGraph: {
    siteName: "Lia",
    type: "website",
    locale: "en_US",
  },
};

export const viewport: Viewport = {
  // Overrides the product's navy. The marketing site is white.
  themeColor: "#ffffff",
  width: "device-width",
  initialScale: 1,
};

export default function SiteLayout({ children }: { children: ReactNode }) {
  return (
    <div
      // `data-surface="site"` scopes the blue focus ring and selection colour
      // defined in globals.css, leaving the product's purple untouched.
      data-surface="site"
      className={`${geist.variable} font-site flex min-h-dvh flex-col bg-white text-[15px] leading-normal text-site-body`}
    >
      {/* Rendered once here rather than per page. Every page reaches the
          speech bubbles through `AccessSection` at minimum, and a page that
          used a bubble without these definitions in the document would
          reference a filter id that resolves to nothing. */}
      <BubbleFilters />
      <SiteNav />
      <main id="main" className="flex-1">
        {children}
      </main>
      <SiteFooter />
    </div>
  );
}
```

- [ ] **Step 4: Write the group error boundary**

Create `src/app/(site)/error.tsx`:

```tsx
"use client";

import { useEffect } from "react";
import { SecondaryButton } from "@/components/site/button";
import { Lede, Section, SectionHeading } from "@/components/site/section";

/**
 * The marketing site's error boundary.
 *
 * These pages are static and have almost nothing to fail, so this is a
 * genuinely rare screen. It stays on-brand and offers the one action that is
 * always safe — go back to the top of the site — rather than a reload loop.
 */
export default function SiteError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // The digest is what correlates this with the server log. The message
    // itself is never rendered: it can carry internals a visitor should not see.
    console.error("Marketing site error", error.digest);
  }, [error]);

  return (
    <Section>
      <div className="mx-auto max-w-[560px] text-center">
        <SectionHeading>Something went wrong on our end.</SectionHeading>
        <Lede className="mt-4">
          The page did not load. Trying again usually works; if it does not, the
          rest of the site is unaffected.
        </Lede>
        <div className="mt-8 flex flex-wrap justify-center gap-3">
          {/* Not a PrimaryButton: that renders a Link, and this needs a real
              button to call `reset`. The classes are the same by hand. */}
          <button
            type="button"
            onClick={reset}
            className="inline-flex items-center justify-center rounded-[10px] bg-site-orange px-5 py-3 text-[14px] font-semibold text-site-ink transition-colors hover:bg-site-orange-hover"
          >
            Try again
          </button>
          <SecondaryButton href="/">Back to home</SecondaryButton>
        </div>
      </div>
    </Section>
  );
}
```

- [ ] **Step 5: Delete the old root page**

`src/app/page.tsx` is a bare `redirect("/overview")`. It cannot coexist with `(site)/page.tsx` — both resolve to `/`.

```bash
git rm src/app/page.tsx
```

- [ ] **Step 6: Add a placeholder home page so the route resolves**

Create `src/app/(site)/page.tsx` as a stub; Task 10 writes the real one:

```tsx
export default function HomePage() {
  return <div className="p-10">Home</div>;
}
```

- [ ] **Step 7: Verify the shell renders**

Run: `npm run dev` and open `http://localhost:3000/`.

Expected: the sticky white navigation with the wordmark, the word "Home", and the dark footer. Tab through: focus rings are blue, not purple. Narrow the window below 768px: the hamburger appears and toggles the panel.

- [ ] **Step 8: Typecheck and commit**

```bash
npm run typecheck && npx vitest run
git add -A "src/app/(site)" src/components/site src/app/page.tsx
git commit -m "Add the marketing shell: nav, footer, layout, error boundary"
```

---

## Task 7: Early-access validation and composition

Pure module, no I/O. Everything about *what the message says* is decided here so it can be tested without a database or a mail provider — the same split `src/lib/support/help-request.ts` uses.

**Files:**
- Create: `src/lib/site/early-access.ts`
- Test: `tests/early-access.test.ts`

**Interfaces:**
- Produces: `earlyAccessSchema`, `EarlyAccessRequest`, `composeEarlyAccessNotification({ request, sentAt, origin }): { subject: string; text: string }`, `MAX_BUSINESS_NAME_LENGTH`

- [ ] **Step 1: Write the failing test**

Create `tests/early-access.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  composeEarlyAccessNotification,
  earlyAccessSchema,
} from "@/lib/site/early-access";

/**
 * Early-access validation and composition.
 *
 * This is a public, unauthenticated endpoint — the only one in the application
 * — so the schema is the entire trust boundary. Two properties carry the most
 * weight: the email is normalised before it ever reaches the unique index, and
 * nothing a stranger types can bend the shape of the notification that lands in
 * the support inbox.
 */

const VALID = {
  email: "sam@harborandvine.com",
  businessName: "Harbor & Vine",
  industry: "restaurants",
  sourcePath: "/for/restaurants",
  website: "",
};

function compose(input: unknown) {
  return composeEarlyAccessNotification({
    request: earlyAccessSchema.parse(input),
    sentAt: new Date("2026-08-04T09:30:00.000Z"),
    origin: "https://lia.bond",
  });
}

describe("earlyAccessSchema", () => {
  it("accepts a complete request", () => {
    expect(earlyAccessSchema.parse(VALID).email).toBe("sam@harborandvine.com");
  });

  it("lowercases and trims the address", () => {
    // The unique index is on lower(email); normalising here means the index
    // does the job it was built for rather than admitting three spellings.
    const parsed = earlyAccessSchema.parse({
      ...VALID,
      email: "  SAM@HarborAndVine.com  ",
    });
    expect(parsed.email).toBe("sam@harborandvine.com");
  });

  it("rejects an address that is not one", () => {
    expect(() => earlyAccessSchema.parse({ ...VALID, email: "sam@" })).toThrow();
  });

  it("requires an address", () => {
    expect(() => earlyAccessSchema.parse({ ...VALID, email: "" })).toThrow();
  });

  it("treats a filled honeypot as a bot", () => {
    // `website` is hidden from people and irresistible to form-fillers.
    expect(() =>
      earlyAccessSchema.parse({ ...VALID, website: "http://spam.example" }),
    ).toThrow();
  });

  it("accepts a request with no business name or industry", () => {
    const parsed = earlyAccessSchema.parse({
      email: "sam@harborandvine.com",
      website: "",
    });
    expect(parsed.businessName).toBeNull();
    expect(parsed.industry).toBeNull();
  });

  it("rejects an unknown industry rather than storing it", () => {
    expect(() =>
      earlyAccessSchema.parse({ ...VALID, industry: "dentists" }),
    ).toThrow();
  });

  it("refuses an overlong business name", () => {
    expect(() =>
      earlyAccessSchema.parse({ ...VALID, businessName: "x".repeat(201) }),
    ).toThrow();
  });

  it("keeps a stray source path from becoming an open field", () => {
    // Only paths, never absolute URLs — the value is echoed into the email.
    expect(() =>
      earlyAccessSchema.parse({ ...VALID, sourcePath: "https://evil.example" }),
    ).toThrow();
  });
});

describe("composeEarlyAccessNotification", () => {
  it("names the requester in the subject", () => {
    expect(compose(VALID).subject).toContain("sam@harborandvine.com");
  });

  it("reports the business, industry, and converting page", () => {
    const { text } = compose(VALID);
    expect(text).toContain("Harbor & Vine");
    expect(text).toContain("Restaurants");
    expect(text).toContain("/for/restaurants");
  });

  it("says so plainly when optional fields are absent", () => {
    const { text } = compose({ email: "sam@harborandvine.com", website: "" });
    expect(text).toContain("Not given");
  });

  it("cannot have mail headers injected through the address", () => {
    // A newline in the subject line is how a header injection starts.
    expect(() =>
      earlyAccessSchema.parse({
        ...VALID,
        email: "sam@harborandvine.com\nBcc: everyone@example.com",
      }),
    ).toThrow();
  });

  it("keeps the subject on one line whatever the input", () => {
    const { subject } = compose(VALID);
    expect(subject).not.toMatch(/[\r\n]/);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/early-access.test.ts`
Expected: FAIL — cannot resolve `@/lib/site/early-access`.

- [ ] **Step 3: Write the module**

Create `src/lib/site/early-access.ts`:

```ts
import { z } from "zod";
import { INDUSTRIES, type IndustrySlug } from "@/lib/site/routes";

/**
 * Early-access request validation and composition.
 *
 * Pure: no I/O, no session, no provider. The action supplies the transport;
 * everything about *what the message says* is decided here so it can be tested
 * without sending anything — the same split `@/lib/support/help-request` uses.
 *
 * The rule that shapes this module: it is the application's only public,
 * unauthenticated write. Every field is therefore either constrained to a known
 * vocabulary or bounded in length, and nothing is interpolated into the
 * notification without having passed through the schema first.
 */

export const MAX_BUSINESS_NAME_LENGTH = 200;

const INDUSTRY_SLUGS = INDUSTRIES.map((industry) => industry.slug) as [
  IndustrySlug,
  ...IndustrySlug[],
];

const INDUSTRY_LABELS = new Map<IndustrySlug, string>(
  INDUSTRIES.map((industry) => [industry.slug, industry.label]),
);

/** Empty strings arrive from unfilled inputs; they mean "absent", not "". */
const optionalText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((value) => value.trim())
    .transform((value) => (value.length === 0 ? null : value))
    .nullable()
    .default(null);

export const earlyAccessSchema = z.object({
  email: z
    .string()
    .trim()
    .toLowerCase()
    // `z.email()` rejects the embedded CR/LF that begins a header injection,
    // so the address needs no separate sanitising before it reaches the mailer.
    .pipe(z.email({ message: "Enter a valid email address." }))
    .pipe(z.string().max(320)),

  businessName: optionalText(MAX_BUSINESS_NAME_LENGTH),

  /**
   * Constrained to the vocabulary rather than stored free-form. The value is
   * echoed into an email and written to a column; an open string would be a
   * place for a stranger to put anything.
   */
  industry: z.enum(INDUSTRY_SLUGS).nullable().default(null),

  /**
   * Which page converted. A path, never an absolute URL — it is rendered into
   * the notification, and a full URL there is a link someone else chose.
   */
  sourcePath: z
    .string()
    .max(120)
    .regex(/^\/[\w\-/]*$/, "Not a site path.")
    .nullable()
    .default(null),

  /**
   * Honeypot. Hidden from people, filled by naive bots. A non-empty value fails
   * validation, and the visitor is told nothing about why — a bot that learns
   * which field betrayed it simply stops filling that one.
   */
  website: z
    .string()
    .max(200)
    .refine((value) => value.trim().length === 0, { message: "Rejected." }),
});

export type EarlyAccessRequest = z.infer<typeof earlyAccessSchema>;

export function composeEarlyAccessNotification({
  request,
  sentAt,
  origin,
}: {
  request: EarlyAccessRequest;
  sentAt: Date;
  origin: string;
}): { subject: string; text: string } {
  const industry = request.industry
    ? (INDUSTRY_LABELS.get(request.industry) ?? request.industry)
    : null;

  const lines = [
    "Someone asked for early access to Lia.",
    "",
    `Email:     ${request.email}`,
    `Business:  ${request.businessName ?? "Not given"}`,
    `Industry:  ${industry ?? "Not given"}`,
    `From page: ${request.sourcePath ? `${origin}${request.sourcePath}` : "Not given"}`,
    `Received:  ${sentAt.toISOString()}`,
    "",
    "Reply to the address above to start the conversation.",
  ];

  return {
    // Single line by construction: the address cannot contain CR or LF, having
    // passed `z.email()` above.
    subject: `Early access request — ${request.email}`,
    text: lines.join("\n"),
  };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/early-access.test.ts`
Expected: PASS, 14 tests.

- [ ] **Step 5: Commit**

```bash
git add src/lib/site/early-access.ts tests/early-access.test.ts
git commit -m "Add early-access validation and message composition"
```

---

## Task 8: The early_access_requests table

**Files:**
- Create: `supabase/migrations/20260806000100_early_access.sql`
- Create: `supabase/migrations/20260806000200_early_access_rls.sql`

- [ ] **Step 1: Write the table migration**

Create `supabase/migrations/20260806000100_early_access.sql`:

```sql
-- ---------------------------------------------------------------------------
-- Marketing site — early access requests
--
-- The one table in this schema that is not owned by an organization, because
-- the rows predate any organization existing. A lead is a stranger who typed an
-- address into a public form; there is no tenant to scope them to yet.
--
-- That makes it the only table written by an unauthenticated code path, so the
-- constraints here are the last line rather than a formality. Lengths are
-- bounded at the column, the address is unique case-insensitively, and the
-- companion RLS migration grants nobody any access at all — the server action
-- uses the service-role client, which is what keeps the write behind the
-- application's validation instead of exposed at the REST endpoint.
-- ---------------------------------------------------------------------------

create table public.early_access_requests (
  id uuid primary key default gen_random_uuid(),

  -- 320 is the practical maximum length of an address. The schema in
  -- `@/lib/site/early-access` lowercases before insert; the index below is on
  -- lower(email) anyway, so a row written by some other path still dedupes.
  email text not null check (length(email) between 3 and 320),

  business_name text check (business_name is null or length(business_name) between 1 and 200),

  -- Left as text rather than an enum. The marketing site's vertical list is a
  -- copy decision that changes with campaigns, and a migration per campaign is
  -- a bad trade for a column nothing joins on. The vocabulary is enforced in
  -- the Zod schema, which is the thing that actually runs on every write.
  industry text check (industry is null or length(industry) between 1 and 60),

  -- Which page converted. A path, never an absolute URL.
  source_path text check (source_path is null or source_path like '/%'),

  created_at timestamptz not null default now()
);

-- Case-insensitive, so Sam@ and sam@ are one lead rather than two.
create unique index early_access_requests_email_key
  on public.early_access_requests (lower(email));

-- The only query this table serves: most recent first.
create index early_access_requests_created_at_idx
  on public.early_access_requests (created_at desc);

comment on table public.early_access_requests is
  'Marketing site early-access signups. Written only by the service role via app/actions/early-access.ts.';
```

- [ ] **Step 2: Write the RLS migration**

Create `supabase/migrations/20260806000200_early_access_rls.sql`:

```sql
-- ---------------------------------------------------------------------------
-- Marketing site — row-level security for early access requests
--
-- Row-level security is enabled and **no policy is created**. That is the whole
-- design, and it is deliberate rather than an omission.
--
-- The obvious alternative — an anon INSERT policy so the public form can write
-- directly — would expose the table at Supabase's REST endpoint, where anyone
-- could insert without passing the honeypot, the length bounds, or the industry
-- vocabulary that `@/lib/site/early-access` enforces. The form would become the
-- polite way in and the endpoint the real one.
--
-- Instead the server action uses `createSupabaseServiceClient`, which bypasses
-- RLS by design. The validation therefore cannot be skipped, because the only
-- credential that can write this table never reaches a browser.
--
-- FORCE is set so that even the table owner is subject to the (empty) policy
-- set. Only the service role, which bypasses RLS entirely, gets through.
-- ---------------------------------------------------------------------------

alter table public.early_access_requests enable row level security;
alter table public.early_access_requests force row level security;
```

- [ ] **Step 3: Validate the SQL parses**

Run: `npm run db:validate`
Expected: both new files listed, no parse errors.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/20260806000100_early_access.sql supabase/migrations/20260806000200_early_access_rls.sql
git commit -m "Add the early_access_requests table with no-policy RLS"
```

---

## Task 9: The public server action

**Files:**
- Create: `src/app/actions/early-access.ts`

**Interfaces:**
- Consumes: `earlyAccessSchema`, `composeEarlyAccessNotification` (Task 7); `runAction`, `ActionResult` from `@/lib/actions/result`; `sendEmail` from `@/lib/email/send`; `createSupabaseServiceClient` from `@/lib/supabase/server`; `appOrigin`, `supportInboxAddress`, `isSupabaseConfigured`, `resolveEmailMode` from `@/lib/env`
- Produces: `submitEarlyAccessAction(input: unknown): Promise<ActionResult<EarlyAccessReceipt>>`, `interface EarlyAccessReceipt { recorded: boolean; notified: boolean }`

- [ ] **Step 1: Write the action**

Create `src/app/actions/early-access.ts`:

```ts
"use server";

import {
  composeEarlyAccessNotification,
  earlyAccessSchema,
  type EarlyAccessRequest,
} from "@/lib/site/early-access";
import { runAction, type ActionResult } from "@/lib/actions/result";
import { sendEmail } from "@/lib/email/send";
import {
  appOrigin,
  isSupabaseConfigured,
  resolveEmailMode,
  supportInboxAddress,
} from "@/lib/env";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * Early access requests.
 *
 * The application's only unauthenticated write, and the only action with no
 * `requireSession()` call — by definition, since the person submitting it has
 * no account. `runAction` is session-agnostic (the help action calls
 * `requireSession` inside its own body), so it is reusable here unchanged.
 *
 * Two things happen with one lead: it is recorded, and somebody is told. They
 * fail independently and are treated independently — see the note on the
 * return below.
 *
 * What this deliberately does not do is rate-limit. There is no rate-limit
 * store in this stack, and a per-process counter on serverless functions counts
 * one instance's traffic rather than an attacker's. The honeypot in the schema
 * stops naive bots; anything beyond that belongs at the platform edge, and is
 * recorded as a pre-launch item in the design document rather than
 * approximated here.
 */

export interface EarlyAccessReceipt {
  /** False in demo mode, or when the row already existed. */
  recorded: boolean;
  /** False when the server is in `LIA_EMAIL_MODE=log` or email is unconfigured. */
  notified: boolean;
}

export async function submitEarlyAccessAction(
  input: unknown,
): Promise<ActionResult<EarlyAccessReceipt>> {
  return runAction("site.early_access", async () => {
    const request = earlyAccessSchema.parse(input);

    const recorded = await record(request);
    const notified = await notify(request);

    // Capture beats notify. A lead that reached either the table or the inbox
    // is a lead we have, and telling the visitor otherwise would invite them to
    // submit again. Only losing both is a failure worth showing.
    if (!recorded && !notified) {
      throw new Error("early access request reached neither the table nor the inbox");
    }

    return { recorded, notified };
  });
}

async function record(request: EarlyAccessRequest): Promise<boolean> {
  // Demo mode: a fresh clone with an empty .env still gets a working form.
  if (!isSupabaseConfigured()) return false;

  try {
    const supabase = createSupabaseServiceClient();
    const { error } = await supabase.from("early_access_requests").insert({
      email: request.email,
      business_name: request.businessName,
      industry: request.industry,
      source_path: request.sourcePath,
    });

    // 23505 is unique_violation: this address is already on the list. That is a
    // success from the visitor's side and must stay indistinguishable from a
    // first submission — see the note in the form component about enumeration.
    if (error && error.code !== "23505") {
      console.error("early access insert failed", error.code);
      return false;
    }

    return true;
  } catch (error) {
    // A misconfigured service client must not cost us the notification below.
    console.error("early access insert threw", error);
    return false;
  }
}

async function notify(request: EarlyAccessRequest): Promise<boolean> {
  if (resolveEmailMode() === "unconfigured") return false;

  const { subject, text } = composeEarlyAccessNotification({
    request,
    sentAt: new Date(),
    origin: appOrigin(),
  });

  try {
    const delivery = await sendEmail({
      to: [supportInboxAddress()],
      // So that hitting reply reaches the person who asked.
      replyTo: [request.email],
      subject,
      text,
    });

    return delivery.mode === "live";
  } catch (error) {
    console.error("early access notification failed", error);
    return false;
  }
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: no errors. If `sendEmail`'s signature differs from the call above, read `src/lib/email/send.ts` and match it exactly rather than adapting the module.

- [ ] **Step 3: Commit**

```bash
git add src/app/actions/early-access.ts
git commit -m "Add the public early-access server action"
```

---

## Task 10: The access form

**Files:**
- Create: `src/components/site/access-form.tsx`

**Interfaces:**
- Consumes: `submitEarlyAccessAction` (Task 9)
- Produces: `AccessForm({ industry?, sourcePath, className? })`, `AccessSection({ industry?, sourcePath })`

- [ ] **Step 1: Write the form**

Create `src/components/site/access-form.tsx`:

```tsx
"use client";

import { useState } from "react";
import { submitEarlyAccessAction } from "@/app/actions/early-access";
import { SpeechBubble } from "@/components/site/speech-bubble";
import { Lede, SectionHeading } from "@/components/site/section";
import type { IndustrySlug } from "@/lib/site/routes";

/**
 * The one interactive element on the marketing site.
 *
 * The success message never distinguishes a new address from one already on the
 * list. It could — the action knows — but a form that says "you are already
 * registered" is an oracle a stranger can query for whether a given address
 * uses Lia. One sentence for both cases costs nothing and closes that.
 */
export function AccessForm({
  industry,
  sourcePath,
  className,
}: {
  industry?: IndustrySlug;
  /** Which page this instance sits on, recorded with the lead. */
  sourcePath: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "sending" | "sent">("idle");
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(formData: FormData) {
    setState("sending");
    setError(null);

    const result = await submitEarlyAccessAction({
      email: formData.get("email"),
      businessName: formData.get("businessName"),
      industry: industry ?? null,
      sourcePath,
      website: formData.get("website"),
    });

    if (result.ok) {
      setState("sent");
      return;
    }

    setState("idle");
    setError(result.error);
  }

  if (state === "sent") {
    return (
      <div
        className={`rounded-[14px] border border-site-blue-edge bg-[#eff5ff] px-6 py-5 text-center ${className ?? ""}`}
        // Announced because the form it replaces is gone by the time a screen
        // reader would reach it.
        role="status"
      >
        <p className="text-[15px] font-semibold text-site-ink">
          Thanks — you are on the list.
        </p>
        <p className="mt-1.5 text-[14px] text-site-body">
          We will be in touch about connecting your first location.
        </p>
      </div>
    );
  }

  return (
    <form action={onSubmit} className={className}>
      <div className="mx-auto flex max-w-[520px] flex-wrap gap-3">
        <label htmlFor="access-email" className="sr-only">
          Your work email
        </label>
        <input
          id="access-email"
          name="email"
          type="email"
          required
          autoComplete="email"
          placeholder="Your work email"
          disabled={state === "sending"}
          aria-describedby={error ? "access-error" : undefined}
          aria-invalid={error ? true : undefined}
          className="min-w-[220px] flex-1 rounded-[10px] border border-site-field px-4 py-3.5 text-[15px] text-site-ink outline-none placeholder:text-site-muted focus:border-site-blue disabled:opacity-60"
        />

        {/* Honeypot. Hidden from people, tempting to form-fillers. Not
            `display:none`, which some bots skip; off-screen and untabbable. */}
        <div className="absolute left-[-9999px]" aria-hidden="true">
          <label htmlFor="access-website">Website</label>
          <input
            id="access-website"
            name="website"
            type="text"
            tabIndex={-1}
            autoComplete="off"
            defaultValue=""
          />
        </div>

        <button
          type="submit"
          disabled={state === "sending"}
          className="rounded-[10px] bg-site-orange px-6 py-3.5 text-[15px] font-semibold whitespace-nowrap text-site-ink transition-colors hover:bg-site-orange-hover disabled:opacity-70"
        >
          {state === "sending" ? "Sending…" : "Request access"}
        </button>
      </div>

      {error ? (
        <p id="access-error" role="alert" className="mt-3 text-[13px] text-[#c0261a]">
          {error}
        </p>
      ) : null}

      <p className="mt-3.5 text-[12.5px] text-site-muted">
        No spam. We will only use this to talk about your reputation workflow.
      </p>
    </form>
  );
}

/**
 * The closing call to action, with the bubbles that frame it on every page.
 * `id="access"` is the target the navigation button and every in-page CTA
 * scroll to.
 */
export function AccessSection({
  industry,
  sourcePath,
}: {
  industry?: IndustrySlug;
  sourcePath: string;
}) {
  return (
    <section id="access" className="relative bg-white">
      <div className="relative mx-auto w-full max-w-[1200px] px-[clamp(24px,6vw,106px)] py-[clamp(64px,8vw,110px)]">
        <SpeechBubble
          quote="Live in an afternoon."
          attribution="New customer"
          tone="amber"
          className="absolute -top-7 left-[clamp(8px,4vw,54px)] z-10 hidden w-[186px] -rotate-[5deg] lg:block"
        />
        <SpeechBubble
          quote="Worth every penny."
          attribution="Owner"
          tone="plain"
          className="absolute -bottom-7 right-[clamp(8px,4vw,50px)] z-10 hidden w-[172px] rotate-[5deg] lg:block"
        />

        <div className="mx-auto max-w-[620px] text-center">
          <SectionHeading>
            Know what to say when your reputation is public.
          </SectionHeading>
          <Lede className="mt-4.5 mb-7">
            Tell us a little about your business and we will set you up with your
            Google reviews to start.
          </Lede>
          <AccessForm industry={industry} sourcePath={sourcePath} />
        </div>
      </div>
    </section>
  );
}
```

- [ ] **Step 2: Verify the form end to end in demo mode**

Run: `npm run dev` with no `NEXT_PUBLIC_SUPABASE_URL` and no `RESEND_API_KEY`.

Temporarily place `<AccessSection sourcePath="/" />` in `src/app/(site)/page.tsx`, then submit a valid address at `http://localhost:3000/`.

Expected: the success panel replaces the form, and the server console shows the composed message from `sendEmail`'s log mode. Submitting `not-an-email` shows the browser's own validation. Filling the off-screen honeypot via devtools produces the generic error, not a success.

- [ ] **Step 3: Typecheck and commit**

```bash
npm run typecheck
git add src/components/site/access-form.tsx
git commit -m "Add the early-access form and closing call to action"
```

---

## Task 11: Pricing page

The one page with verbatim reference copy. Two new primitives, both used again nowhere else — they live in the page's own directory rather than the shared library.

**Files:**
- Create: `src/components/site/pricing-tier.tsx`
- Create: `src/app/(site)/pricing/page.tsx`

**Interfaces:**
- Consumes: `Section`, `Eyebrow`, `PageHeading`, `Lede`, `SectionHeading`, `SpeechBubble` (Task 5); `AccessSection` (Task 10). The bubble filter defs come from the layout, so this page does not import them
- Produces: `PricingTier({ name, blurb, price, priceNote, ctaLabel, features, featured? })`

- [ ] **Step 1: Write the tier card**

Create `src/components/site/pricing-tier.tsx`:

```tsx
import Link from "next/link";
import { Check } from "lucide-react";

/**
 * A pricing card, light or featured.
 *
 * The featured variant inverts to the ink surface. Its muted text uses
 * `site-muted-dark` — the reference grey, which measures 2.93:1 on the pale
 * surface and 6.19:1 on this one, so it is correct here and only here.
 */
export function PricingTier({
  name,
  blurb,
  price,
  priceNote,
  ctaLabel,
  features,
  featured = false,
}: {
  name: string;
  blurb: string;
  price: string;
  priceNote: string;
  ctaLabel: string;
  features: readonly string[];
  featured?: boolean;
}) {
  return (
    <div
      className={
        featured
          ? "relative flex flex-col rounded-[18px] border border-site-ink bg-site-ink p-7 shadow-[0_30px_70px_-34px_rgb(11_15_24_/_0.55)]"
          : "flex flex-col rounded-[18px] border border-site-border bg-white p-7"
      }
      data-surface={featured ? "dark" : undefined}
    >
      {featured ? (
        <span className="absolute top-5.5 right-6 rounded-[20px] bg-site-orange px-2.5 py-1 text-[11px] font-semibold text-site-ink">
          Most popular
        </span>
      ) : null}

      <h3
        className={`mb-1.5 text-[14px] font-semibold ${featured ? "text-white" : "text-site-ink"}`}
      >
        {name}
      </h3>
      <p
        className={`mb-5.5 text-[13.5px] leading-[1.5] ${featured ? "text-site-muted-dark" : "text-site-muted"}`}
      >
        {blurb}
      </p>

      <p className="mb-1.5 flex items-baseline gap-1.5">
        <span
          className={`text-[42px] font-bold tracking-[-0.02em] ${featured ? "text-white" : "text-site-ink"}`}
        >
          {price}
        </span>
      </p>
      <p
        className={`mb-6 text-[12.5px] ${featured ? "text-site-muted-dark" : "text-site-muted"}`}
      >
        {priceNote}
      </p>

      <Link
        href="#access"
        className={
          featured
            ? "mb-6.5 rounded-[10px] bg-site-orange py-3.5 text-center text-[14px] font-semibold text-site-ink transition-colors hover:bg-site-orange-hover"
            : "mb-6.5 rounded-[10px] border border-site-blue-edge py-3 text-center text-[14px] font-semibold text-site-blue transition-colors hover:bg-[#eff5ff]"
        }
      >
        {ctaLabel}
      </Link>

      <ul className="flex flex-col gap-3.5">
        {features.map((feature) => (
          <li key={feature} className="flex items-start gap-2.5">
            <Check
              className={`mt-0.5 size-3.5 shrink-0 ${featured ? "text-site-orange" : "text-site-blue"}`}
              aria-hidden="true"
            />
            <span
              className={`text-[14px] leading-[1.5] ${featured ? "text-[#e6eaf0]" : "text-site-body"}`}
            >
              {feature}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
```

- [ ] **Step 2: Write the page**

Create `src/app/(site)/pricing/page.tsx`:

```tsx
import type { Metadata } from "next";
import { AccessSection } from "@/components/site/access-form";
import { PricingTier } from "@/components/site/pricing-tier";
import { SpeechBubble } from "@/components/site/speech-bubble";
import {
  Eyebrow,
  Lede,
  PageHeading,
  Section,
  SectionHeading,
} from "@/components/site/section";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Per location, billed monthly, no long contracts. Start with Google reviews and add platforms as you grow.",
};

const TIERS = [
  {
    name: "Single location",
    blurb: "For independent hotels, restaurants, and clinics.",
    price: "$149",
    priceNote: "per location, per month",
    ctaLabel: "Request early access",
    features: [
      "Google review monitoring",
      "AI-assisted response drafts",
      "Human review on sensitive replies",
      "Weekly reputation report",
    ],
  },
  {
    name: "Growth",
    blurb: "For multi-location brands and groups.",
    price: "$129",
    priceNote: "per location, per month · volume pricing",
    ctaLabel: "Request early access",
    featured: true,
    features: [
      "Everything in single location",
      "All review platforms connected",
      "Brand voice and escalation rules",
      "Monthly insights summary",
      "Priority support",
    ],
  },
  {
    name: "Brand",
    blurb: "For agencies and large multi-brand groups.",
    price: "Custom",
    priceNote: "tailored to your portfolio",
    ctaLabel: "Talk to us",
    features: [
      "Everything in growth",
      "Dedicated reputation strategist",
      "Custom workflows and approvals",
      "SSO and role-based access",
    ],
  },
] as const;

/**
 * The FAQ answers are load-bearing marketing claims, so each one is checked
 * against what the product actually does:
 *
 * - "nothing goes public until a person approves it" — `requiresApproval` on
 *   `ConnectorCapabilities`, and the approval-first rule in CLAUDE.md.
 * - The platform list is `PLATFORMS` in `src/domain/enums.ts`. The design
 *   reference also named Booking.com, which is not a platform this product
 *   models; it is dropped rather than promised.
 */
const FAQS = [
  {
    question: "Does Lia post replies automatically?",
    answer:
      "No. Lia drafts responses, but nothing goes public until a person approves it. Sensitive reviews are always held for review first.",
  },
  {
    question: "Which platforms do you support?",
    answer:
      "Google Business Profile is core, with Tripadvisor, Yelp, Trustpilot, and Facebook available. Reddit, news coverage, and supported article comments are monitored too. We add platforms on request.",
  },
  {
    question: "How long does setup take?",
    answer:
      "Most teams are live in an afternoon. We connect your profiles, import your brand voice, and tune escalation rules with you.",
  },
  {
    question: "Is there a contract?",
    answer:
      "No long commitment. Billing is monthly per location, and you can cancel any time without penalty.",
  },
] as const;

export default function PricingPage() {
  return (
    <>
      <header className="relative mx-auto w-full max-w-[1200px] px-[clamp(24px,6vw,106px)] pt-[clamp(48px,8vw,108px)] pb-[clamp(28px,4vw,48px)]">
        <div className="pointer-events-none absolute top-1/2 right-[clamp(10px,3vw,40px)] z-10 hidden -translate-y-1/2 flex-col items-end gap-4 lg:flex">
          <SpeechBubble
            quote="Every location sounds like us now."
            attribution="Multi-location owner"
            tone="blue"
            float="a"
            className="w-[188px]"
          />
          <SpeechBubble
            quote="Five stars, genuinely earned."
            attribution="Restaurant guest · Yelp"
            tone="amber"
            float="b"
            className="mr-6.5 w-[176px]"
          />
        </div>

        <Eyebrow>Pricing</Eyebrow>
        <PageHeading className="mb-6 max-w-[560px]">
          Pricing that fits how you run.
        </PageHeading>
        <Lede className="max-w-[560px]">
          Per location, billed monthly, no long contracts. Start with Google
          reviews and add platforms as you grow.
        </Lede>
      </header>

      <div className="mx-auto w-full max-w-[1200px] px-[clamp(24px,6vw,106px)] pt-[clamp(20px,3vw,32px)] pb-[clamp(40px,5vw,56px)]">
        <div className="grid grid-cols-1 items-stretch gap-6 lg:grid-cols-3">
          {TIERS.map((tier) => (
            <PricingTier key={tier.name} {...tier} />
          ))}
        </div>
        <p className="mt-6.5 text-center text-[13.5px] text-site-muted">
          Early-access pricing, locked in for your first year. Cancel anytime.
        </p>
      </div>

      <Section tinted>
        <div className="mx-auto max-w-[1000px]">
          <SectionHeading className="mb-[clamp(32px,4vw,48px)] text-center">
            Questions, answered.
          </SectionHeading>
          <div className="grid grid-cols-1 gap-[clamp(28px,4vw,56px)] md:grid-cols-2">
            {FAQS.map((faq) => (
              <div key={faq.question}>
                <h3 className="mb-2.5 text-[17px] font-semibold text-site-ink">
                  {faq.question}
                </h3>
                <p className="text-[15px] leading-[1.6] text-site-body">
                  {faq.answer}
                </p>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <AccessSection sourcePath="/pricing" />
    </>
  );
}
```

- [ ] **Step 3: Verify against the reference**

Run: `npm run dev`, open `http://localhost:3000/pricing`.

Check: three tiers with the middle one dark and badged; the two floating bubbles at the top right on a wide window and hidden below `lg`; the tinted FAQ band; the CTA with its two rotated bubbles. Compare against the reference screenshot. The one intended difference is the orange buttons' label colour — ink, not white.

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck && npx vitest run
git add src/components/site/pricing-tier.tsx "src/app/(site)/pricing"
git commit -m "Add the pricing page"
```

---

## Task 12: Home page

**Files:**
- Create: `src/lib/site/content/home.ts`
- Modify: `src/app/(site)/page.tsx` (replacing the Task 6 stub)

**Interfaces:**
- Consumes: everything from Tasks 5, 10
- Produces: `HOME_STAGES`, `HOME_JUDGMENT`

The `#judgment` section is the anchor the navigation's "Approach" item targets. It must carry that id.

- [ ] **Step 1: Write the content record**

Create `src/lib/site/content/home.ts`:

```ts
/**
 * Home page copy.
 *
 * The six stages are the product's own workflow, named the same way it names
 * them internally (`manifest.json`), so the marketing promise and the product
 * vocabulary do not drift apart.
 */

export interface Stage {
  name: string;
  description: string;
}

export const HOME_STAGES: readonly Stage[] = [
  {
    name: "Detect",
    description:
      "Reviews, Reddit threads, press, and supported article comments arrive in one place, matched to the right brand and location.",
  },
  {
    name: "Understand",
    description:
      "Every mention is read for sentiment, topic, relevance, and risk — so a slow Tuesday service and a food-safety claim are never the same task.",
  },
  {
    name: "Decide",
    description:
      "Lia recommends whether to respond at all. Not everything deserves a reply, and saying so is part of the job.",
  },
  {
    name: "Respond",
    description:
      "Drafts come back in your voice, shaped for the platform they are going to, ready for a person to approve.",
  },
  {
    name: "Escalate",
    description:
      "Anything sensitive routes to the people who should see it first, with the full thread and a clear reason attached.",
  },
  {
    name: "Learn",
    description:
      "Recurring complaints surface as patterns across locations, so the same problem stops arriving one review at a time.",
  },
] as const;

export const HOME_JUDGMENT = {
  eyebrow: "Our approach",
  heading: "The judgment is the product.",
  body: [
    "Drafting a reply is the easy part. Knowing which reviews deserve one, which need a manager before anything is published, and which are better left alone — that is the work, and it is where a generic assistant does damage.",
    "So Lia is approval-first by construction. Sensitive mentions are held, never auto-sent. Every connector declares what it can actually do, and the interface never offers to publish somewhere it cannot. When a platform has no reply surface, Lia says so rather than pretending.",
  ],
  points: [
    {
      title: "Nothing publishes itself",
      body: "Drafts wait for a person. Approval is the default, not a setting you remember to switch on.",
    },
    {
      title: "Capabilities are explicit",
      body: "Each platform declares whether Lia can read, draft, or publish. You are never shown a button that will not work.",
    },
    {
      title: "Everything is on the record",
      body: "Who drafted, who approved, what changed, and when. The audit trail is not an add-on.",
    },
  ],
} as const;
```

- [ ] **Step 2: Write the page**

Replace `src/app/(site)/page.tsx` entirely:

```tsx
import type { Metadata } from "next";
import { AccessSection } from "@/components/site/access-form";
import { PrimaryButton, SecondaryButton } from "@/components/site/button";
import { SpeechBubble } from "@/components/site/speech-bubble";
import {
  Eyebrow,
  Lede,
  PageHeading,
  Section,
  SectionHeading,
} from "@/components/site/section";
import { HOME_JUDGMENT, HOME_STAGES } from "@/lib/site/content/home";

export const metadata: Metadata = {
  // The layout's default title already reads as a home page title, so this
  // page opts out of the "%s · Lia" template rather than repeating the brand.
  title: {
    absolute: "Lia — know what to say when your reputation is public",
  },
};

export default function HomePage() {
  return (
    <>
      <header className="relative mx-auto w-full max-w-[1200px] px-[clamp(24px,6vw,106px)] pt-[clamp(48px,8vw,108px)] pb-[clamp(36px,5vw,64px)]">
        <div className="pointer-events-none absolute top-1/2 right-[clamp(10px,3vw,40px)] z-10 hidden -translate-y-1/2 flex-col items-end gap-4 lg:flex">
          <SpeechBubble
            quote="Every location sounds like us now."
            attribution="Multi-location owner"
            tone="blue"
            float="a"
            className="w-[188px]"
          />
          <SpeechBubble
            quote="Five stars, genuinely earned."
            attribution="Restaurant guest · Yelp"
            tone="amber"
            float="b"
            className="mr-6.5 w-[176px]"
          />
        </div>

        <Eyebrow>Reputation intelligence</Eyebrow>
        <PageHeading className="mb-6 max-w-[620px]">
          Know what people are saying. Respond when it matters.
        </PageHeading>
        <Lede className="mb-8 max-w-[560px]">
          Lia watches your reviews, forums, and press from one workspace, drafts
          replies in your voice, and holds the sensitive ones for a person to
          approve.
        </Lede>
        <div className="flex flex-wrap gap-3">
          <PrimaryButton href="#access">Request early access</PrimaryButton>
          <SecondaryButton href="/product">See how it works</SecondaryButton>
        </div>
      </header>

      <Section tinted>
        <Eyebrow>How it works</Eyebrow>
        <SectionHeading className="mb-[clamp(32px,4vw,52px)] max-w-[620px]">
          Six stages, from a stranger's post to a decision you can defend.
        </SectionHeading>
        <ol className="grid grid-cols-1 gap-x-[clamp(24px,4vw,56px)] gap-y-9 sm:grid-cols-2 lg:grid-cols-3">
          {HOME_STAGES.map((stage, index) => (
            <li key={stage.name}>
              <span className="mb-3 inline-flex size-7 items-center justify-center rounded-full bg-white text-[12.5px] font-semibold text-site-blue ring-1 ring-site-blue-edge">
                {index + 1}
              </span>
              <h3 className="mb-2 text-[17px] font-semibold text-site-ink">
                {stage.name}
              </h3>
              <p className="text-[15px] leading-[1.6] text-site-body">
                {stage.description}
              </p>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="judgment">
        <div className="grid grid-cols-1 gap-[clamp(32px,5vw,72px)] lg:grid-cols-[1fr_1fr]">
          <div>
            <Eyebrow>{HOME_JUDGMENT.eyebrow}</Eyebrow>
            <SectionHeading className="mb-6">
              {HOME_JUDGMENT.heading}
            </SectionHeading>
            {HOME_JUDGMENT.body.map((paragraph) => (
              <p
                key={paragraph.slice(0, 32)}
                className="mb-4 text-[16px] leading-[1.65] text-site-body"
              >
                {paragraph}
              </p>
            ))}
          </div>
          <div className="flex flex-col gap-5">
            {HOME_JUDGMENT.points.map((point) => (
              <div
                key={point.title}
                className="rounded-[18px] border border-site-border bg-white p-6"
              >
                <h3 className="mb-2 text-[16px] font-semibold text-site-ink">
                  {point.title}
                </h3>
                <p className="text-[14.5px] leading-[1.6] text-site-body">
                  {point.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <AccessSection sourcePath="/" />
    </>
  );
}
```

- [ ] **Step 3: Verify the anchor**

Run: `npm run dev`, open `http://localhost:3000/product` then click "Approach" in the navigation.

Expected: navigation to `/#judgment` and the page scrolls to the "The judgment is the product." section.

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck && npx vitest run
git add src/lib/site/content/home.ts "src/app/(site)/page.tsx"
git commit -m "Add the home page"
```

---

## Task 13: Platforms page

The page most constrained by CLAUDE.md rule 6. Every claim here comes from `ConnectorCapabilities` in `src/domain/entities/platform.ts` and the seeded connections in `src/lib/seed/dataset.ts`.

**Files:**
- Create: `src/lib/site/content/platforms.ts`
- Create: `src/app/(site)/platforms/page.tsx`

**Interfaces:**
- Produces: `PLATFORM_ROWS: readonly PlatformRow[]`

- [ ] **Step 1: Write the content record**

Create `src/lib/site/content/platforms.ts`:

```ts
/**
 * What Lia can actually do on each platform.
 *
 * Every value here is derived from `ConnectorCapabilities` in
 * `src/domain/entities/platform.ts` and the connections in
 * `src/lib/seed/dataset.ts` — not from marketing copy. CLAUDE.md rule 6:
 * never imply direct publishing where the source does not support it.
 *
 * `resolvePublishingMode` in the platform entity is the same rule expressed in
 * code: `canPublishResponses` means "direct", readable-but-not-publishable
 * means "manual", and neither means "unavailable".
 *
 * The design reference also advertised Booking.com. It is not in the `PLATFORMS`
 * vocabulary and is deliberately absent rather than promised.
 */

export type Publishing = "direct" | "manual" | "monitor";

export interface PlatformRow {
  name: string;
  /** What Lia does with it, in a sentence. */
  note: string;
  publishing: Publishing;
  available: boolean;
}

export const PUBLISHING_LABELS: Record<Publishing, string> = {
  direct: "Publish from Lia",
  manual: "Copy to publish",
  monitor: "Monitoring only",
};

export const PUBLISHING_NOTES: Record<Publishing, string> = {
  direct: "Approved replies post straight to the platform.",
  manual:
    "Lia drafts the reply and hands it to you to post, because the platform offers no reply API.",
  monitor:
    "There is nothing to reply to. Lia reads these to tell you what is being said.",
};

export const PLATFORM_ROWS: readonly PlatformRow[] = [
  {
    name: "Google Business Profile",
    note: "Reviews across every location, with replies posted from Lia once approved.",
    publishing: "direct",
    available: true,
  },
  {
    name: "Reddit",
    note: "Threads and comments that name your brand, with replies from your own account.",
    publishing: "direct",
    available: true,
  },
  {
    name: "Yelp",
    note: "Reviews are read through a partner agreement; replies are drafted for you to post.",
    publishing: "manual",
    available: true,
  },
  {
    name: "Tripadvisor",
    note: "Reviews and traveller ratings, with drafted replies for manual posting.",
    publishing: "manual",
    available: true,
  },
  {
    name: "Trustpilot",
    note: "Reviews and ratings, with drafted replies for manual posting.",
    publishing: "manual",
    available: true,
  },
  {
    name: "Facebook",
    note: "Page reviews and recommendations, with drafted replies for manual posting.",
    publishing: "manual",
    available: true,
  },
  {
    name: "News and media",
    note: "Local and national coverage, food and trade publications, and blogs.",
    publishing: "monitor",
    available: true,
  },
  {
    name: "Article comments",
    note: "Supported comment systems on articles that cover you.",
    publishing: "monitor",
    available: true,
  },
] as const;
```

- [ ] **Step 2: Write the page**

Create `src/app/(site)/platforms/page.tsx`:

```tsx
import type { Metadata } from "next";
import { AccessSection } from "@/components/site/access-form";
import {
  Eyebrow,
  Lede,
  PageHeading,
  Section,
  SectionHeading,
} from "@/components/site/section";
import {
  PLATFORM_ROWS,
  PUBLISHING_LABELS,
  PUBLISHING_NOTES,
  type Publishing,
} from "@/lib/site/content/platforms";

export const metadata: Metadata = {
  title: "Platforms",
  description:
    "Where Lia reads, where it can publish for you, and where it hands you a draft to post yourself.",
};

const BADGE: Record<Publishing, string> = {
  direct: "bg-[#e9f8f0] text-[#0f6b45] ring-[#bfe6d3]",
  manual: "bg-site-blue-tint text-site-blue-ink ring-site-blue-edge",
  monitor: "bg-site-tint text-site-muted ring-site-border",
};

export default function PlatformsPage() {
  return (
    <>
      <header className="mx-auto w-full max-w-[1200px] px-[clamp(24px,6vw,106px)] pt-[clamp(48px,8vw,108px)] pb-[clamp(28px,4vw,48px)]">
        <Eyebrow>Platforms</Eyebrow>
        <PageHeading className="mb-6 max-w-[620px]">
          Every source, and exactly what we can do with it.
        </PageHeading>
        <Lede className="max-w-[620px]">
          Some platforms let software post a reply. Most do not. Lia tells you
          which is which up front rather than showing you a button that quietly
          fails.
        </Lede>
      </header>

      <div className="mx-auto w-full max-w-[1200px] px-[clamp(24px,6vw,106px)] pb-[clamp(40px,5vw,56px)]">
        <div className="overflow-x-auto rounded-[18px] border border-site-border">
          <table className="w-full min-w-[640px] border-collapse text-left">
            <caption className="sr-only">
              Supported platforms and how responses reach them
            </caption>
            <thead>
              <tr className="border-b border-site-border bg-site-tint">
                <th
                  scope="col"
                  className="px-6 py-4 text-[12px] font-semibold tracking-[0.08em] text-site-muted uppercase"
                >
                  Platform
                </th>
                <th
                  scope="col"
                  className="px-6 py-4 text-[12px] font-semibold tracking-[0.08em] text-site-muted uppercase"
                >
                  What Lia does
                </th>
                <th
                  scope="col"
                  className="px-6 py-4 text-[12px] font-semibold tracking-[0.08em] text-site-muted uppercase"
                >
                  Responses
                </th>
              </tr>
            </thead>
            <tbody>
              {PLATFORM_ROWS.map((row) => (
                <tr
                  key={row.name}
                  className="border-b border-site-border last:border-0"
                >
                  <th
                    scope="row"
                    className="px-6 py-5 align-top text-[15px] font-semibold text-site-ink"
                  >
                    {row.name}
                  </th>
                  <td className="max-w-[420px] px-6 py-5 align-top text-[14.5px] leading-[1.6] text-site-body">
                    {row.note}
                  </td>
                  <td className="px-6 py-5 align-top">
                    <span
                      className={`inline-block rounded-full px-3 py-1 text-[12.5px] font-semibold whitespace-nowrap ring-1 ${BADGE[row.publishing]}`}
                    >
                      {PUBLISHING_LABELS[row.publishing]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Section tinted>
        <SectionHeading className="mb-[clamp(28px,4vw,44px)] max-w-[620px]">
          What those three answers mean.
        </SectionHeading>
        <dl className="grid grid-cols-1 gap-7 md:grid-cols-3">
          {(["direct", "manual", "monitor"] as const).map((mode) => (
            <div key={mode}>
              <dt className="mb-2 text-[16px] font-semibold text-site-ink">
                {PUBLISHING_LABELS[mode]}
              </dt>
              <dd className="text-[14.5px] leading-[1.6] text-site-body">
                {PUBLISHING_NOTES[mode]}
              </dd>
            </div>
          ))}
        </dl>
      </Section>

      <AccessSection sourcePath="/platforms" />
    </>
  );
}
```

- [ ] **Step 3: Verify the table scrolls rather than the page**

Run: `npm run dev`, open `http://localhost:3000/platforms`, narrow the window to 380px.

Expected: the table scrolls horizontally inside its rounded container; the page body does not scroll sideways.

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck && npx vitest run
git add src/lib/site/content/platforms.ts "src/app/(site)/platforms"
git commit -m "Add the platforms page with capability-accurate claims"
```

---

## Task 14: Product page

**Files:**
- Create: `src/app/(site)/product/page.tsx`

**Interfaces:**
- Consumes: `HOME_STAGES` from `@/lib/site/content/home` (Task 12)

- [ ] **Step 1: Write the page**

Create `src/app/(site)/product/page.tsx`:

```tsx
import type { Metadata } from "next";
import { AccessSection } from "@/components/site/access-form";
import { SecondaryButton } from "@/components/site/button";
import {
  Eyebrow,
  Lede,
  PageHeading,
  Section,
  SectionHeading,
} from "@/components/site/section";
import { HOME_STAGES } from "@/lib/site/content/home";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "From a stranger's post to an approved reply: detection, analysis, a recommendation, a draft in your voice, and an audit trail.",
};

/**
 * The six stages again, at length. The short forms on the home page and these
 * long forms share `HOME_STAGES` for their names and ordering, so the two pages
 * cannot describe a different product.
 */
const DETAIL: Record<string, readonly string[]> = {
  Detect: [
    "Connect your Google Business Profile and Lia starts pulling reviews for every location on the account.",
    "Add Reddit, news monitoring, and the review platforms you care about. Each mention is matched to the right brand and the right location before anyone sees it.",
  ],
  Understand: [
    "Every mention is read for sentiment, topic, relevance, risk, and urgency.",
    "That is what separates a complaint about a slow Tuesday service from an allegation about food safety — and what stops the second one sitting in a queue behind forty of the first.",
  ],
  Decide: [
    "Lia recommends whether to respond at all, and why.",
    "Replying to everything is its own kind of noise. A recommendation you can disagree with is more useful than a draft you did not ask for.",
  ],
  Respond: [
    "Drafts come back in your brand voice, tuned by the settings you control, and shaped for the platform they are going to.",
    "A Google review reply and a Reddit comment are not the same register, and Lia does not pretend otherwise.",
  ],
  Escalate: [
    "Sensitive mentions route to the people who should see them first, carrying the full thread and a plain statement of why they were flagged.",
    "Nothing is published while it is escalated. Approval is the default state, not a setting somebody has to remember.",
  ],
  Learn: [
    "The same complaint arriving at four locations is a pattern, not four reviews.",
    "Lia surfaces recurring topics across your group so the operational fix reaches the person who can make it.",
  ],
};

export default function ProductPage() {
  return (
    <>
      <header className="mx-auto w-full max-w-[1200px] px-[clamp(24px,6vw,106px)] pt-[clamp(48px,8vw,108px)] pb-[clamp(28px,4vw,48px)]">
        <Eyebrow>How it works</Eyebrow>
        <PageHeading className="mb-6 max-w-[620px]">
          From a stranger&rsquo;s post to a reply you can stand behind.
        </PageHeading>
        <Lede className="mb-8 max-w-[600px]">
          Six stages. You can stop at any of them — Lia is built to be
          overruled, and the audit trail records who did.
        </Lede>
        <SecondaryButton href="/platforms">
          See which platforms are supported
        </SecondaryButton>
      </header>

      {HOME_STAGES.map((stage, index) => (
        <Section key={stage.name} tinted={index % 2 === 1}>
          <div className="grid grid-cols-1 gap-[clamp(24px,4vw,64px)] lg:grid-cols-[220px_1fr]">
            <div>
              <span className="mb-3 inline-flex size-8 items-center justify-center rounded-full bg-white text-[13px] font-semibold text-site-blue ring-1 ring-site-blue-edge">
                {index + 1}
              </span>
              <SectionHeading className="text-[clamp(22px,2.4vw,30px)]!">
                {stage.name}
              </SectionHeading>
            </div>
            <div className="max-w-[640px]">
              <p className="mb-4 text-[17px] leading-[1.6] font-medium text-site-ink">
                {stage.description}
              </p>
              {DETAIL[stage.name]?.map((paragraph) => (
                <p
                  key={paragraph.slice(0, 32)}
                  className="mb-3.5 text-[15.5px] leading-[1.65] text-site-body"
                >
                  {paragraph}
                </p>
              ))}
            </div>
          </div>
        </Section>
      ))}

      <AccessSection sourcePath="/product" />
    </>
  );
}
```

- [ ] **Step 2: Typecheck and commit**

```bash
npm run typecheck && npx vitest run
git add "src/app/(site)/product"
git commit -m "Add the product page"
```

---

## Task 15: The four vertical pages

One dynamic route, four typed content records. `generateStaticParams` prerenders exactly the four; anything else 404s.

**Files:**
- Create: `src/lib/site/content/industries.ts`
- Create: `src/app/(site)/for/[industry]/page.tsx`

**Interfaces:**
- Consumes: `INDUSTRIES`, `IndustrySlug` (Task 1)
- Produces: `INDUSTRY_CONTENT: Record<IndustrySlug, IndustryContent>`

- [ ] **Step 1: Write the content records**

Create `src/lib/site/content/industries.ts`:

```ts
import type { IndustrySlug } from "@/lib/site/routes";

/**
 * Per-industry copy for `/for/[industry]`.
 *
 * The four pages differ only in language, so they share one template and this
 * record supplies everything variable. Adding a fifth vertical means an entry
 * here, an entry in `INDUSTRIES`, and nothing else.
 */

export interface IndustryContent {
  /** Sentence-case page heading. */
  heading: string;
  lede: string;
  /** Three pressures specific to the vertical. */
  pressures: readonly { title: string; body: string }[];
  /** One illustrative quote for the hero bubble. */
  quote: { text: string; attribution: string };
  metaDescription: string;
}

export const INDUSTRY_CONTENT: Record<IndustrySlug, IndustryContent> = {
  hotels: {
    heading: "Every stay ends in a review somebody else reads.",
    lede: "Hotel reputation is decided across Google, Tripadvisor, and a dozen booking sites at once — usually while your front desk is busy with the guests already in the building.",
    pressures: [
      {
        title: "One bad night travels",
        body: "A single review about a room, a rate, or a late check-in outranks a hundred quiet good stays. Lia flags the ones with reach before they settle into your rating.",
      },
      {
        title: "Every property sounds different",
        body: "Regional managers write in their own register and it shows. A shared brand voice keeps the replies recognisably yours without scripting them.",
      },
      {
        title: "Some complaints are not reviews",
        body: "Accessibility, safety, and discrimination claims need a named person, not a template. Those route to someone before anything is published.",
      },
    ],
    quote: {
      text: "Every property sounds like us now.",
      attribution: "Group operations director",
    },
    metaDescription:
      "Reputation monitoring and reply drafting for hotels and hotel groups, across Google, Tripadvisor, and the review sites guests actually read.",
  },
  restaurants: {
    heading: "The dining room closes. The reviews do not.",
    lede: "Service ends and the posting starts — Google, Yelp, Reddit threads, and the local food press, all at once, usually after the manager has gone home.",
    pressures: [
      {
        title: "Volume beats attention",
        body: "A busy group can take hundreds of reviews a week. Lia reads all of them and tells you which twelve are worth your evening.",
      },
      {
        title: "Food safety is not a review",
        body: "An illness claim is a legal and operational event. It is held, escalated, and never answered by an automated draft.",
      },
      {
        title: "The same complaint, four locations",
        body: "When wait times spike across a region, that is an operations problem wearing a reviews costume. Lia surfaces the pattern.",
      },
    ],
    quote: {
      text: "Five stars, genuinely earned.",
      attribution: "Restaurant guest · Yelp",
    },
    metaDescription:
      "Reputation monitoring and reply drafting for restaurants and restaurant groups, across Google, Yelp, Reddit, and local press.",
  },
  "salons-and-barbershops": {
    heading: "Your chair is booked on your reviews.",
    lede: "Most new clients read three reviews before they book, and almost all of them are about one stylist rather than the shop.",
    pressures: [
      {
        title: "Reviews name individuals",
        body: "A complaint about one stylist reads as a complaint about the shop. Replies need to answer the guest without publicly disciplining staff.",
      },
      {
        title: "Small teams, no comms person",
        body: "Nobody on the floor has an afternoon for drafting. Lia writes the reply; you approve it between clients.",
      },
      {
        title: "Results are subjective",
        body: "A colour that did not land is a genuine disappointment and not necessarily a mistake. That distinction belongs in the reply.",
      },
    ],
    quote: {
      text: "Replies go out the same day now.",
      attribution: "Salon owner",
    },
    metaDescription:
      "Reputation monitoring and reply drafting for salons and barbershops, built for small teams without a communications person.",
  },
  "med-spas": {
    heading: "Regulated care, reviewed in public.",
    lede: "Clients discuss outcomes, pricing, and side effects in the open — and your reply is subject to rules that do not apply to a restaurant.",
    pressures: [
      {
        title: "Privacy limits what you can say",
        body: "Confirming that someone was a client at all can be a disclosure. Lia drafts replies that respond without acknowledging treatment.",
      },
      {
        title: "Outcome claims carry risk",
        body: "A reply promising a result is a claim someone can hold you to. Sensitive threads escalate to a named reviewer before anything publishes.",
      },
      {
        title: "Trust is the whole funnel",
        body: "Prospective clients read how you handle criticism more closely than they read the praise. Consistency matters more than speed.",
      },
    ],
    quote: {
      text: "Careful replies, without the wait.",
      attribution: "Practice manager",
    },
    metaDescription:
      "Reputation monitoring and reply drafting for med spas, with privacy-aware drafts and escalation before anything is published.",
  },
};
```

- [ ] **Step 2: Write the template**

Create `src/app/(site)/for/[industry]/page.tsx`:

```tsx
import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccessSection } from "@/components/site/access-form";
import { PrimaryButton, SecondaryButton } from "@/components/site/button";
import { SpeechBubble } from "@/components/site/speech-bubble";
import {
  Eyebrow,
  Lede,
  PageHeading,
  Section,
  SectionHeading,
} from "@/components/site/section";
import { HOME_STAGES } from "@/lib/site/content/home";
import { INDUSTRY_CONTENT } from "@/lib/site/content/industries";
import { INDUSTRIES, type IndustrySlug } from "@/lib/site/routes";

/**
 * The four vertical pages.
 *
 * One template, because they differ only in copy. `generateStaticParams`
 * prerenders exactly the four in `INDUSTRIES`; `resolve` below 404s anything
 * else, so `/for/dentists` is a genuine miss rather than an empty template.
 */

interface Params {
  params: Promise<{ industry: string }>;
}

export function generateStaticParams() {
  return INDUSTRIES.map((industry) => ({ industry: industry.slug }));
}

function resolve(slug: string): IndustrySlug {
  const match = INDUSTRIES.find((industry) => industry.slug === slug);
  if (!match) notFound();
  return match.slug;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { industry } = await params;
  const slug = resolve(industry);
  const content = INDUSTRY_CONTENT[slug];
  const label = INDUSTRIES.find((entry) => entry.slug === slug)!.label;

  return {
    title: `Lia for ${label.toLowerCase()}`,
    description: content.metaDescription,
  };
}

export default async function IndustryPage({ params }: Params) {
  const { industry } = await params;
  const slug = resolve(industry);
  const content = INDUSTRY_CONTENT[slug];
  const label = INDUSTRIES.find((entry) => entry.slug === slug)!.label;

  return (
    <>
      <header className="relative mx-auto w-full max-w-[1200px] px-[clamp(24px,6vw,106px)] pt-[clamp(48px,8vw,108px)] pb-[clamp(28px,4vw,48px)]">
        <SpeechBubble
          quote={content.quote.text}
          attribution={content.quote.attribution}
          tone="blue"
          float="a"
          className="pointer-events-none absolute top-1/2 right-[clamp(10px,3vw,40px)] hidden w-[196px] -translate-y-1/2 lg:block"
        />

        <Eyebrow>Lia for {label.toLowerCase()}</Eyebrow>
        <PageHeading className="mb-6 max-w-[620px]">
          {content.heading}
        </PageHeading>
        <Lede className="mb-8 max-w-[580px]">{content.lede}</Lede>
        <div className="flex flex-wrap gap-3">
          <PrimaryButton href="#access">Request early access</PrimaryButton>
          <SecondaryButton href="/pricing">See pricing</SecondaryButton>
        </div>
      </header>

      <Section tinted>
        <SectionHeading className="mb-[clamp(28px,4vw,48px)] max-w-[560px]">
          What makes this different from any other inbox.
        </SectionHeading>
        <div className="grid grid-cols-1 gap-7 md:grid-cols-3">
          {content.pressures.map((pressure) => (
            <div
              key={pressure.title}
              className="rounded-[18px] border border-site-border bg-white p-6"
            >
              <h3 className="mb-2.5 text-[16px] font-semibold text-site-ink">
                {pressure.title}
              </h3>
              <p className="text-[14.5px] leading-[1.6] text-site-body">
                {pressure.body}
              </p>
            </div>
          ))}
        </div>
      </Section>

      <Section>
        <SectionHeading className="mb-[clamp(28px,4vw,44px)] max-w-[560px]">
          The same six stages, whatever you run.
        </SectionHeading>
        <ol className="grid grid-cols-1 gap-x-[clamp(24px,4vw,56px)] gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          {HOME_STAGES.map((stage, index) => (
            <li key={stage.name}>
              <span className="mb-2.5 inline-flex size-7 items-center justify-center rounded-full bg-site-tint text-[12.5px] font-semibold text-site-blue ring-1 ring-site-blue-edge">
                {index + 1}
              </span>
              <h3 className="mb-1.5 text-[16px] font-semibold text-site-ink">
                {stage.name}
              </h3>
              <p className="text-[14.5px] leading-[1.6] text-site-body">
                {stage.description}
              </p>
            </li>
          ))}
        </ol>
      </Section>

      <AccessSection industry={slug} sourcePath={`/for/${slug}`} />
    </>
  );
}
```

- [ ] **Step 2b: Verify the 404 and the industry stamp**

Run: `npm run dev`.

- `http://localhost:3000/for/restaurants` renders.
- `http://localhost:3000/for/dentists` returns 404.
- Submit the form on `/for/hotels`; confirm the server log's composed message contains `Industry:  Hotels` and `/for/hotels`.

- [ ] **Step 3: Typecheck and commit**

```bash
npm run typecheck && npx vitest run
git add src/lib/site/content/industries.ts "src/app/(site)/for"
git commit -m "Add the four vertical pages from one template"
```

---

## Task 16: Contact, privacy, and terms

The legal copy here is **placeholder written to fill the footer's links**, not reviewed language. The design document records legal review as a pre-launch blocker; this task does not discharge it.

**Files:**
- Create: `src/components/site/prose.tsx`
- Create: `src/app/(site)/contact/page.tsx`
- Create: `src/app/(site)/privacy/page.tsx`
- Create: `src/app/(site)/terms/page.tsx`

**Interfaces:**
- Produces: `LegalPage({ eyebrow, title, updated, intro, sections })`, `interface LegalSection { heading: string; paragraphs: readonly string[] }`

- [ ] **Step 1: Write the legal page shell**

Create `src/components/site/prose.tsx`:

```tsx
import { Eyebrow, PageHeading } from "@/components/site/section";

export interface LegalSection {
  heading: string;
  paragraphs: readonly string[];
}

/**
 * The shared shell for privacy and terms.
 *
 * A narrow measure and no illustration: these pages are read, not scanned, and
 * the speech bubbles that carry the rest of the site would be flippant here.
 */
export function LegalPage({
  eyebrow,
  title,
  updated,
  intro,
  sections,
}: {
  eyebrow: string;
  title: string;
  /** ISO date, rendered as written. */
  updated: string;
  intro: string;
  sections: readonly LegalSection[];
}) {
  return (
    <div className="mx-auto w-full max-w-[1200px] px-[clamp(24px,6vw,106px)] pt-[clamp(48px,8vw,96px)] pb-[clamp(56px,8vw,110px)]">
      <div className="max-w-[720px]">
        <Eyebrow>{eyebrow}</Eyebrow>
        <PageHeading className="mb-5 text-[clamp(32px,4vw,48px)]!">
          {title}
        </PageHeading>
        <p className="mb-8 text-[13px] text-site-muted">
          Last updated {updated}
        </p>
        <p className="mb-10 text-[17px] leading-[1.65] text-site-body">
          {intro}
        </p>

        {sections.map((section) => (
          <section key={section.heading} className="mb-9">
            <h2 className="mb-3 text-[19px] font-semibold text-site-ink">
              {section.heading}
            </h2>
            {section.paragraphs.map((paragraph) => (
              <p
                key={paragraph.slice(0, 32)}
                className="mb-3.5 text-[15.5px] leading-[1.68] text-site-body"
              >
                {paragraph}
              </p>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 2: Write the contact page**

Create `src/app/(site)/contact/page.tsx`:

```tsx
import type { Metadata } from "next";
import { AccessSection } from "@/components/site/access-form";
import {
  Eyebrow,
  Lede,
  PageHeading,
  Section,
} from "@/components/site/section";

export const metadata: Metadata = {
  title: "Contact",
  description: "How to reach Lia about early access, support, or press.",
};

const CHANNELS = [
  {
    heading: "Early access",
    body: "Use the form below. We reply to every request, usually within a working day, and we will tell you plainly if you are not a fit yet.",
  },
  {
    heading: "Existing customers",
    body: "Use the help form inside the app — it arrives with your organization and role attached, which saves a round trip.",
  },
  {
    heading: "Press and partnerships",
    body: "Send the form below with a line about what you are working on and we will route it to the right person.",
  },
] as const;

export default function ContactPage() {
  return (
    <>
      <header className="mx-auto w-full max-w-[1200px] px-[clamp(24px,6vw,106px)] pt-[clamp(48px,8vw,108px)] pb-[clamp(28px,4vw,48px)]">
        <Eyebrow>Contact</Eyebrow>
        <PageHeading className="mb-6 max-w-[560px]">
          Talk to a person about it.
        </PageHeading>
        <Lede className="max-w-[560px]">
          Lia is a small team. Whichever route you take below reaches someone who
          works on the product.
        </Lede>
      </header>

      <Section tinted>
        <div className="grid grid-cols-1 gap-7 md:grid-cols-3">
          {CHANNELS.map((channel) => (
            <div
              key={channel.heading}
              className="rounded-[18px] border border-site-border bg-white p-6"
            >
              <h2 className="mb-2.5 text-[16px] font-semibold text-site-ink">
                {channel.heading}
              </h2>
              <p className="text-[14.5px] leading-[1.6] text-site-body">
                {channel.body}
              </p>
            </div>
          ))}
        </div>
      </Section>

      <AccessSection sourcePath="/contact" />
    </>
  );
}
```

- [ ] **Step 3: Write the privacy page**

Create `src/app/(site)/privacy/page.tsx`:

```tsx
import type { Metadata } from "next";
import { LegalPage } from "@/components/site/prose";

export const metadata: Metadata = {
  title: "Privacy",
  description: "What Lia collects, why, and what we do not do with it.",
};

/**
 * PLACEHOLDER COPY. Written to describe the system honestly and to fill the
 * footer's link — not reviewed by a lawyer. The design document lists legal
 * review as a pre-launch blocker.
 */
export default function PrivacyPage() {
  return (
    <LegalPage
      eyebrow="Legal"
      title="Privacy"
      updated="4 August 2026"
      intro="This page describes what Lia collects from visitors to this website and from customers using the product. It is written to be read rather than to be survived."
      sections={[
        {
          heading: "What this website collects",
          paragraphs: [
            "If you submit the early-access form, we store the email address you enter, plus the business name, industry, and page you submitted from when those are provided. That is the entire record.",
            "We use it to contact you about early access. We do not sell it, and we do not add it to a marketing list you did not ask for.",
          ],
        },
        {
          heading: "What the product collects",
          paragraphs: [
            "Lia reads public content — reviews, posts, comments, and articles — from the platforms a customer connects, using credentials that customer grants and can revoke.",
            "Customer account data covers the people in an organization, their roles, and what they did in the product. Actions that change customer data are recorded in an audit trail.",
            "Platform credentials are encrypted and stored separately from the records that reference them. They are never returned to a browser.",
          ],
        },
        {
          heading: "What we do not do",
          paragraphs: [
            "We do not publish anything on a customer's behalf without a person approving it.",
            "We do not use one customer's content to train models for another.",
            "We do not sell personal data.",
          ],
        },
        {
          heading: "Retention and deletion",
          paragraphs: [
            "Early-access records are kept until you ask us to delete them, or until we close the early-access programme.",
            "Customer data is retained for the life of the account. On request we delete it, subject to records we are legally required to keep.",
          ],
        },
        {
          heading: "Getting in touch",
          paragraphs: [
            "To ask what we hold about you, or to have it deleted, use the contact page. We will confirm what we did.",
          ],
        },
      ]}
    />
  );
}
```

- [ ] **Step 4: Write the terms page**

Create `src/app/(site)/terms/page.tsx`:

```tsx
import type { Metadata } from "next";
import { LegalPage } from "@/components/site/prose";

export const metadata: Metadata = {
  title: "Terms",
  description: "The terms that apply to using Lia.",
};

/**
 * PLACEHOLDER COPY. See the note in the privacy page. Legal review is a
 * pre-launch blocker recorded in the design document.
 */
export default function TermsPage() {
  return (
    <LegalPage
      eyebrow="Legal"
      title="Terms"
      updated="4 August 2026"
      intro="These terms apply to the Lia website and to the Lia product during early access. They will be replaced with a reviewed agreement before general availability."
      sections={[
        {
          heading: "Early access",
          paragraphs: [
            "During early access, Lia is provided as-is while we are still building it. Features may change, and we will tell you when they do in a way that affects you.",
            "Early-access pricing is held for the first year of a paid subscription that begins during the programme.",
          ],
        },
        {
          heading: "Your content and your accounts",
          paragraphs: [
            "You keep ownership of everything you connect and everything you publish. You grant Lia permission to read and process it in order to provide the service.",
            "You are responsible for having the authority to connect the platform accounts you connect, and for what is published from them after approval.",
          ],
        },
        {
          heading: "Approval and responsibility",
          paragraphs: [
            "Lia drafts responses. A person on your side approves them. Because publication follows a human decision, responsibility for what is published rests with the person who approved it.",
            "Lia is not legal, medical, or crisis-communications advice, and drafts should not be treated as any of those.",
          ],
        },
        {
          heading: "Billing",
          paragraphs: [
            "Paid plans are billed monthly per location. You can cancel at any time, effective at the end of the current billing period.",
          ],
        },
        {
          heading: "Ending the agreement",
          paragraphs: [
            "You can stop using Lia at any time and ask us to delete your data. We can end an account for non-payment or for use that breaks these terms, and we will tell you why.",
          ],
        },
      ]}
    />
  );
}
```

- [ ] **Step 5: Typecheck and commit**

```bash
npm run typecheck && npx vitest run
git add src/components/site/prose.tsx "src/app/(site)/contact" "src/app/(site)/privacy" "src/app/(site)/terms"
git commit -m "Add contact and placeholder legal pages"
```

---

## Task 17: Robots and sitemap

Both are served from paths the middleware matcher covers, which is why Task 1 added them to `isSitePath`. Without that, a crawler fetching either gets redirected to `/sign-in`.

**Files:**
- Create: `src/app/robots.ts`
- Create: `src/app/sitemap.ts`

- [ ] **Step 1: Write the sitemap**

Create `src/app/sitemap.ts`:

```ts
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
```

- [ ] **Step 2: Write robots**

Create `src/app/robots.ts`:

```ts
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
```

- [ ] **Step 3: Verify both are reachable without a session**

Run: `npm run dev` with Supabase configured and no session cookie.

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/robots.txt
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:3000/sitemap.xml
curl -s http://localhost:3000/sitemap.xml | head -20
```

Expected: `200` for both — **not** `307`. The sitemap lists eleven `<url>` entries with the home page as `http://localhost:3000` and no trailing-slash duplicate.

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck
git add src/app/robots.ts src/app/sitemap.ts
git commit -m "Add robots and sitemap generated from the route table"
```

---

## Task 18: Split the 404

Next resolves `notFound()` to the nearest boundary; URLs matching no route at all fall to the root one. After this project most such URLs are marketing typos and dead inbound links, so the root 404 becomes site-branded and the product keeps its own.

**Files:**
- Create: `src/app/(app)/not-found.tsx`
- Modify: `src/app/not-found.tsx`

- [ ] **Step 1: Move the product 404 down**

Create `src/app/(app)/not-found.tsx` with the current contents of `src/app/not-found.tsx`:

```tsx
import Link from "next/link";
import { Compass } from "lucide-react";
import { EmptyState } from "@/components/ui/empty-state";

/**
 * The product's 404.
 *
 * Reached when `notFound()` is raised inside a product route — a mention id
 * that no longer resolves, a location removed from the organization. The root
 * `not-found.tsx` now belongs to the marketing site, which is where an
 * unmatched URL lands; this one keeps the offer that makes sense to somebody
 * already signed in.
 */
export default function AppNotFound() {
  return (
    <main className="flex min-h-dvh items-center justify-center px-5">
      <div className="lia-card w-full max-w-md">
        <EmptyState
          icon={Compass}
          title="We couldn't find that page"
          description="The link may be out of date, or the item may have been dismissed or reassigned."
          action={
            <Link
              href="/overview"
              className="inline-flex h-9 items-center rounded-lg bg-purple-600 px-3 text-[13px] font-medium text-white hover:bg-purple-500"
            >
              Back to overview
            </Link>
          }
        />
      </div>
    </main>
  );
}
```

- [ ] **Step 2: Rebrand the root 404**

Replace `src/app/not-found.tsx` entirely:

```tsx
import { Geist } from "next/font/google";
import { PrimaryButton, SecondaryButton } from "@/components/site/button";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteNav } from "@/components/site/site-nav";
import { SpeechBubble, BubbleFilters } from "@/components/site/speech-bubble";
import { Lede, PageHeading } from "@/components/site/section";

/**
 * The 404 for any URL matching no route at all.
 *
 * Site-branded rather than product-branded, because `/` is now the marketing
 * homepage and an unmatched URL is far more likely to be a mistyped marketing
 * link or a dead result from search than a product route. `notFound()` raised
 * inside the product resolves to `(app)/not-found.tsx` instead.
 *
 * A root not-found cannot inherit a route group's layout, so the navigation,
 * footer, and font are rendered here directly rather than by `(site)/layout`.
 */
const geist = Geist({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-geist",
});

export default function NotFound() {
  return (
    <div
      data-surface="site"
      className={`${geist.variable} font-site flex min-h-dvh flex-col bg-white text-[15px] text-site-body`}
    >
      <BubbleFilters />
      <SiteNav />
      <main id="main" className="flex-1">
        <div className="relative mx-auto w-full max-w-[1200px] px-[clamp(24px,6vw,106px)] py-[clamp(64px,10vw,140px)]">
          <SpeechBubble
            quote="Nothing to see here."
            attribution="This page"
            tone="amber"
            float="b"
            className="pointer-events-none absolute top-[clamp(24px,6vw,80px)] right-[clamp(10px,4vw,60px)] hidden w-[176px] lg:block"
          />
          <div className="max-w-[560px]">
            <p className="mb-5 text-[13px] font-semibold tracking-[0.16em] text-site-muted uppercase">
              404
            </p>
            <PageHeading className="mb-5 text-[clamp(32px,4.4vw,52px)]!">
              That page does not exist.
            </PageHeading>
            <Lede className="mb-8">
              The link may be out of date, or the address may have a typo in it.
              Everything else is where you left it.
            </Lede>
            <div className="flex flex-wrap gap-3">
              <PrimaryButton href="/">Back to home</PrimaryButton>
              <SecondaryButton href="/product">See how Lia works</SecondaryButton>
            </div>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
```

- [ ] **Step 3: Verify both 404s**

Run: `npm run dev`.

- `http://localhost:3000/nope` — the site 404, with the marketing navigation and dark footer.
- `http://localhost:3000/for/dentists` — the same site 404 (the vertical route calls `notFound()` and the nearest boundary above it is the root one, since `(site)` has no `not-found.tsx`).
- Signed in, visit a product route that raises `notFound()` — the purple "Back to overview" card.

- [ ] **Step 4: Typecheck and commit**

```bash
npm run typecheck && npx vitest run
git add src/app/not-found.tsx "src/app/(app)/not-found.tsx"
git commit -m "Split the 404 between the marketing site and the product"
```

---

## Task 19: Full verification

- [ ] **Step 1: Run the whole gate**

Run: `npm run verify`

This is lint, typecheck, the full vitest suite, and a production build. Expected: clean. A build failure here most often means a client component imported something carrying `server-only`.

- [ ] **Step 2: Confirm the pages are static**

In the build output, all eleven marketing routes should be marked as prerendered static content — `○` or `●`, not `ƒ`. A dynamic marketing page means something read a session, a cookie, or headers; find it and remove the read.

- [ ] **Step 3: Walk the site against the checklist**

Run `npm run dev` and confirm each:

- [ ] `/`, `/product`, `/platforms`, `/pricing` all render with nav and footer
- [ ] All four `/for/*` pages render; `/for/dentists` 404s
- [ ] `/contact`, `/privacy`, `/terms` render
- [ ] Every footer link resolves; no 404 from the footer
- [ ] "Approach" scrolls to the judgment section on `/`
- [ ] Keyboard: tab through a page — focus rings are blue and always visible
- [ ] The skip link appears on first tab and jumps to `#main`
- [ ] At 380px wide, no page scrolls horizontally; the platforms table scrolls inside its own container
- [ ] With "reduce motion" enabled in the OS, the bubbles hold still
- [ ] The form succeeds on `/` and on `/for/hotels`, and the logged message carries the right `sourcePath` and industry

- [ ] **Step 4: Confirm the product is untouched**

Sign in and visit `/overview`, `/mentions`, and `/settings`. Expected: identical to before this project — Inter, navy sidebar, purple focus rings.

- [ ] **Step 5: Commit anything outstanding**

```bash
git status
git add -A && git commit -m "Marketing site: final verification pass"
```

---

## Self-review notes

**Spec coverage.** Every section of the design document maps to a task: routing and the auth gate (1), fonts (3), tokens and contrast (2), primitives (4, 5), nav/footer/layout (6), the form's pure module (7), migrations (8), the action (9), the form UI (10), the eleven pages (11–16), crawl surface (17), the 404 split (18).

**Deliberately not built, per the spec:** application-level rate limiting (M11 — platform layer, pre-launch), reconciling `CLAUDE.md`'s restaurant-first brief with the four verticals, and an OpenGraph image. All three are on the design document's pre-launch checklist.

**One thing this plan decides that the spec left open:** the reference FAQ advertises Booking.com, which is not in the `PLATFORMS` vocabulary. Task 11 drops it. CLAUDE.md rule 6 governs, and a platform promised on a pricing page that the product does not model is exactly the claim that rule exists to prevent.
