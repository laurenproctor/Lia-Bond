# About page — design

**Date:** 2026-08-12
**Status:** Approved
**Scope:** One new marketing route, `/about`, built from provided copy.

## Goal

Add an About page to the public marketing site using the copy Lauren provided
(the "Better technology should make relationships more human, not less"
essay). The page tells the company story: philosophy, what Lia does, the
human layer, feedback-as-intelligence, who it's for, principles, Storyworlding,
the founder, and the ambition.

## Decisions (confirmed with Lauren)

- **Page style:** marketing sections — the site's `Section` primitives with
  alternating tinted bands, a principles grid, and `ClosingCta`. Matches
  `/product` and `/platforms`.
- **Navigation:** footer + sitemap only. "About" goes at the top of the
  footer's Company column and into `SITE_ROUTES`. Top nav stays at its
  current four items.
- **Copy fidelity:** light adaptation. Substance and section order preserved;
  typography normalized (curly quotes, em dashes), sentence case, standalone
  one-line paragraphs merged where the layout already carries the emphasis,
  bolded thesis lines rendered as styled emphasis where it reads better.

## Architecture

Two new files, two edited files. No new components; the page composes
existing primitives.

### New: `src/lib/site/content/about.ts`

Typed copy module, matching the pattern of `home.ts` / `platforms.ts`.
Exports:

- `ABOUT_CAPABILITIES: readonly string[]` — the eight "What Lia does" items.
- `ABOUT_PRINCIPLES: readonly { name: string; body: string }[]` — the six
  principles (name + one- or two-sentence body).
- Prose paragraphs live in the page component itself where they are single-use
  running text; only list-shaped content that renders through `.map()` goes in
  the content module. If the page approaches the ~300-line component cap,
  prose blocks move into `about.ts` as typed paragraph arrays as well.

### New: `src/app/(site)/about/page.tsx`

Server component. Exports `metadata` (title "About", description drawn from
the thesis). Structure:

1. **Header** (shell padding, like `/product`'s header): `Eyebrow` "About",
   `PageHeading` "Better technology should make relationships more human,
   not less.", `Lede` ("Lia is an AI-powered customer intelligence and
   response platform…"), then the "customers are constantly telling
   businesses what they think / the problem is no longer a lack of feedback"
   paragraphs.
2. **Tinted `Section`** — "Technology can scale communication. Judgment is
   what makes it meaningful." Prose.
3. **White `Section`** — "What Lia does": intro line, the eight capabilities
   as a two-column `ul` grid (single column on mobile), closing lines ("The
   objective is not to automate every conversation…").
4. **Tinted `Section`** — "The human layer", with the central question
   ("Where does human judgment become more valuable because technology has
   become more capable?") set as an emphasized pull-line, and "Discernment
   is." as the close.
5. **White `Section`** — "Customer feedback is more than reputation
   management", followed in the same band by "Built for organizations with
   reputations worth protecting" as a second block (own `SectionHeading`).
6. **Tinted `Section`** — "Our principles": six principles as a `dl` grid,
   3×2 on desktop, same pattern as the platforms publishing legend.
7. **White `Section`** — "A Storyworlding company" + "Founded by Lauren
   Proctor" as two blocks.
8. **Tinted `Section`** — "What we are building toward", ending on "That is
   the company we are building."
9. `ClosingCta`.

Prose measure capped around 640px inside sections, matching `/product`.
Body text uses the site's existing type scale (`text-[15.5px]
leading-[1.65] text-site-body`, headings via `SectionHeading`).

### Edited: `src/lib/site/routes.ts`

- `SITE_ROUTES`: add `{ path: "/about", priority: 0.6, lastModified:
  "2026-08-12" }`.
- `SITE_FOOTER`: add `{ label: "About", href: "/about" }` at the top of the
  Company column.
- `SITE_NAV`: untouched.

Sitemap and footer pick the page up from the route table; no middleware
change is needed (marketing routes are not gated).

## Error handling / loading

None specific: static server-rendered page with no data fetching. The
`(site)` group's existing `error.tsx` covers it.

## Testing

- `npm run build` (includes route typegen + typecheck) passes.
- Lint passes.
- Manual check: `/about` renders in the site shell, footer shows the link,
  `/sitemap.xml` includes `/about`.

## Out of scope

- Top-nav changes.
- Photography/illustration or founder headshot.
- Any product-app (`(app)`) changes.
