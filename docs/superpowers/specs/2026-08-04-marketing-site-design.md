# Marketing site

Design document. Written 2026-08-04, before implementation.

## Summary

Build the public Lia.bond marketing site as a `(site)` route group inside this
repository, owning `/` and ten more public routes. Eleven pages, a shared set of
marketing primitives, a working early-access form that both persists and
notifies, and the crawl surface a public site needs.

The visual reference is a Claude Design artifact — the Pricing page of a
multi-page site — reproduced faithfully except where its palette fails WCAG AA.
Those exceptions are enumerated and justified below.

**This does not touch the product.** No screen under `(app)` changes behaviour.
The three edits outside `(site)` are the middleware allowlist, the root layout's
font handling, and moving the existing 404 down into `(app)`.

## What the reference actually is

The artifact bundles a single page — Pricing — whose navigation and footer link
to eight sibling pages that were not in the bundle. So the reference supplies:

- The complete design language: type, colour, spacing, radii, motion
- Verbatim copy for the pricing tiers, the FAQ, the closing CTA, and the footer
- The information architecture for the whole site, via its own link targets

Home, Product, and Platforms have no reference rendering. Their copy is written
fresh, drawn from `docs/product-spec.md` so the marketing claims match what the
product actually does — in particular the capability model, which is the honest
basis for the "nothing publishes without approval" promise the reference makes.

### Design language, extracted

| Property | Value |
| --- | --- |
| Typeface | Geist, weights 300–700 |
| Page shell | 1200px max width, `clamp(50px,6vw,106px)` gutters |
| Display headings | `clamp(38px,5vw,64px)`, weight 700, `-0.022em` |
| Section headings | `clamp(26px,3.4vw,40px)`, weight 700, `-0.018em` |
| Body | 15–19px, line-height 1.55–1.6 |
| Card radius | 18px; buttons 10px; pills 20px |
| Section rhythm | `clamp(60px,8vw,100px)` vertical |
| Signature motif | Hand-drawn SVG speech bubbles, `feTurbulence` + `feDisplacementMap`, 5.8–6.5s float |

## Decisions taken

| # | Decision | Reason |
| --- | --- | --- |
| M1 | Marketing lives in this repo as a `(site)` route group | One deploy, one toolchain, and the CTA can hand off to the real `/sign-up`. A second Next.js app would duplicate config to isolate a brand that a route-group layout already isolates. |
| M2 | Eleven pages, including Contact, Privacy, Terms | Every link the reference's own footer contains. A footer with dead legal links is worse than one with drafted ones. |
| M3 | Multi-vertical positioning: hotels, restaurants, salons & barbershops, med spas | Follows the reference verbatim. Diverges from `CLAUDE.md`, which is restaurant-first. See "The positioning divergence". |
| M4 | The four vertical pages are one dynamic route driven by typed content records | They differ only in copy. Four near-identical page files would each exceed the 300-line guideline for no gain. |
| M5 | Early-access form both persists and notifies | Inbox alone loses leads to archiving; a table alone means nobody notices a signup. |
| M6 | The table is written by the service-role client, with RLS enabled and **no policies** | An anonymous-insert policy exposes the table at Supabase's REST endpoint, where a writer bypasses the action's validation entirely. |
| M7 | The wordmark is rebuilt as inline SVG taking `currentColor` | The reference nav logo is a blue-neon mark on a solid black tile — a black square on a white nav — and the two PNGs total 1.6MB. |
| M8 | Five palette values darkened to clear WCAG AA | Documented per-value below. `CLAUDE.md` lists accessibility as an engineering standard. |
| M9 | The primary CTA keeps `#FF7A2E` and switches its label from white to ink | White on `#FF7A2E` is 2.60:1. Preserving the brand orange and darkening the label reaches 7.37:1; darkening the fill instead would shift the signature colour on every page. |
| M10 | A single `src/lib/site/routes.ts` feeds nav, footer, sitemap, and the middleware allowlist | The middleware gates every unlisted path. A route table in two places means a new page silently lands behind the auth gate. |
| M11 | No application-level rate limiting on the public form | The stack has no rate-limit store. A per-process counter on serverless is theatre. Platform-level (Vercel BotID or a WAF rule) is the correct layer; recorded as a pre-launch item, not built here. |
| M12 | Signed-in visitors still see the marketing site at `/` | Redirecting them makes the public site unreachable for customers. `/sign-in` already forwards authenticated users to `/overview`, so the nav link needs no session check — which keeps every page statically renderable. |

## The positioning divergence

`CLAUDE.md` opens with "a polished, production-oriented SaaS application for
**restaurant groups**", and `docs/product-spec.md` positions Lia as "the
reputation intelligence and response system built for restaurants."

The reference site sells to four verticals and its pricing copy reads "For
independent hotels, restaurants, and clinics."

This design follows the reference (M3). That is a deliberate, sanctioned choice,
not an oversight. Two consequences worth stating plainly:

1. The product docs and the marketing site now describe different audiences.
   This document is the record of why. `CLAUDE.md` is **not** edited here —
   changing the engineering brief to match a marketing decision would overreach
   what was asked for.
2. The app's mock data, sample mentions, and interface copy are restaurant-shaped.
   A visitor arriving from `/for/med-spas` and signing up meets a product that
   talks about covers and service recovery. Marketing is ahead of the product;
   that gap is real and belongs on someone's roadmap.

## Routing and layout

### Structure

```text
src/app/(site)/
  layout.tsx                 SiteNav + SiteFooter, Geist, site metadata/viewport
  error.tsx                  group error boundary
  page.tsx                   /
  product/page.tsx           /product
  platforms/page.tsx         /platforms
  pricing/page.tsx           /pricing
  for/[industry]/page.tsx    /for/{hotels,restaurants,salons-and-barbershops,med-spas}
  contact/page.tsx           /contact
  privacy/page.tsx           /privacy
  terms/page.tsx             /terms

src/app/robots.ts
src/app/sitemap.ts
src/app/not-found.tsx        rebranded to the site
src/app/(app)/not-found.tsx  new: the existing app-styled 404, moved down
```

`src/app/page.tsx` — today a bare `redirect("/overview")` — is deleted. It
cannot coexist with `(site)/page.tsx`; both resolve to `/`.

The vertical route uses `generateStaticParams` over the four industry slugs and
`notFound()` for anything else, so `/for/dentists` 404s rather than rendering an
empty template.

**"Approach" is not a route.** The reference navigation points it at a home-page
anchor (`Lia Home.dc.html#judgment`), and this design keeps that: the nav and
footer both link to `/#judgment`, a section on the homepage about how Lia
decides what to escalate. The route table marks it as an anchor entry so the
sitemap does not emit it as a separate URL and the middleware does not treat it
as a distinct path. Eleven routes, twelve navigation targets.

### The auth gate

`src/middleware.ts` redirects any path not in `PUBLIC_PATHS` to `/sign-in`.
`isPublic("/")` is false today, so **the marketing homepage would bounce every
anonymous visitor to the sign-in screen.** This is the single highest-risk
interaction in the change.

The fix adds `isSitePath()` alongside the existing `isPublic()`, reading the
route table from M10. Two functions rather than one extended list, because they
answer different questions: `isPublic` means "this is an auth screen that must
stay reachable", `isSitePath` means "this is public marketing". The existing
comments in that file explain the first category carefully; merging the second
into it would muddy a good explanation.

`tests/site-routes.test.ts` asserts every table entry passes `isSitePath`, which
is what stops this bug from recurring when page twelve is added.

### Fonts

The root layout currently sets `inter.variable` on `<html>`. It stops doing so.
Each group layout imports its own font module and applies the variable to its
own wrapper element: `(app)` keeps Inter, `(site)` gets Geist. Because the import
lives in the group layout, Next only preloads each face on routes that use it —
product users never download Geist, and site visitors never download Inter. CSS
custom properties inherit, so `--font-sans` resolves correctly within each tree.

`(site)/layout.tsx` exports its own `viewport` (`themeColor: "#FFFFFF"`,
overriding the app's navy) and `metadata` with a site-specific title template
and an OpenGraph block.

## Design tokens

Marketing tokens join the existing `@theme` block in `src/app/globals.css` under
a `site-` prefix. Tailwind 4's `@theme` is global; prefixing is what keeps
`bg-site-ink` and `bg-navy-950` from colliding. No second stylesheet.

```css
--color-site-ink:      #0B0F18;   /* headings, dark surfaces      */
--color-site-body:     #3A4454;   /* body copy                    */
--color-site-muted:    #697386;   /* corrected, was #8A93A3       */
--color-site-muted-on-dark: #8A93A3;  /* 6.19:1 on ink — unchanged */
--color-site-border:   #E6EAF0;   /* decorative card borders      */
--color-site-field:    #8296B4;   /* corrected, form-control borders */
--color-site-tint:     #F6F9FD;   /* alternating section fill     */
--color-site-orange:   #FF7A2E;   /* brand accent                 */
--color-site-orange-hover: #E8651C;
--color-site-blue:     #0074E5;   /* corrected, was #0D88FF       */
--color-site-blue-mark: #0D88FF;  /* non-text: strokes, dot       */
--color-site-blue-tint: #EAF3FF;
--color-site-blue-edge: #A8D0FF;
--color-site-amber-tint: #FFF3EA;
--color-site-amber-edge: #C0521A;
```

### Contrast corrections

Measured against WCAG 2.1 AA — 4.5:1 for text, 3:1 for interactive boundaries
(1.4.11). Every replacement is a same-hue darkening, so the site still reads as
the reference.

| Role | Reference | Ships as | Before | After |
| --- | --- | --- | --- | --- |
| Muted / metadata | `#8A93A3` | `#697386` | 2.93 on tint | 4.52 |
| Accent blue, text and ✓ | `#0D88FF` | `#0074E5` | 3.51 | 4.54 |
| Form-control border | `#E6EAF0` | `#8296B4` | 1.21 | 3.01 |
| Bubble metadata, blue | `#5E83A6` | `#507292` | 3.56 | 4.51 |
| Bubble metadata, amber | `#B97A52` | `#9C633F` | 3.23 | 4.51 |
| **Primary CTA label** | white on `#FF7A2E` | **ink on `#FF7A2E`** | **2.60** | **7.37** |

Two values survive unchanged for a reason. `#8A93A3` is 6.19:1 on the ink
background, so footer headings and the dark pricing card keep it. `#E6EAF0`
remains the decorative card border — 1.4.11 governs interactive boundaries, not
ornament — and only form controls take `#8296B4`.

The CTA correction (M9) is the visible one. `#FF7A2E` stays exactly as
specified everywhere it appears, including the "Most popular" pill; only the
label colour changes. The alternative — white text on a darkened `#C0521A`
fill — reaches 4.71:1 but replaces the signature orange on every page's primary
action.

`tests/site-palette.test.ts` recomputes these ratios from the shipped token
values and asserts the thresholds, so a future tweak to the orange cannot
quietly regress the CTA to 2.60:1.

## Components

`src/components/site/`, server components unless noted.

| Component | Notes |
| --- | --- |
| `LogoMark` | Inline SVG wordmark — "lia" with the speech-bubble dot over the i — taking `currentColor`. Ink on the white nav, cream on the dark footer. |
| `SiteNav` | Sticky, `rgba(255,255,255,.85)` with `saturate(140%) blur(12px)`. Product · Platforms · Pricing · Approach · Sign in · CTA. **Client** only for the mobile disclosure. |
| `SiteFooter` | Dark `#0B0F18`, four columns, rendered from the route table. |
| `SpeechBubble` | The testimonial motif. Blue and amber variants, optional float. |
| `Eyebrow` | Dot + uppercase `0.16em` tracked label. |
| `SectionHeading` | Display and section scales with the reference's `clamp()` values. |
| `PricingTier` | Light and dark variants, optional "Most popular" pill. |
| `FeatureGrid`, `FaqGrid`, `CtaBand` | Layout blocks reused across pages. |
| `AccessForm` | **Client.** The only genuinely interactive piece. |
| `VerticalPage` | Template for the four industry pages, driven by a typed content record. |

Page files compose these and stay well under the 300-line guideline.

### Motion

The two float keyframes and the roughen filters come from the reference. The
`feTurbulence`/`feDisplacementMap` pair is declared once per page in a hidden
`<svg><defs>`, referenced by every bubble, rather than duplicated per instance.

All float animation sits inside `@media (prefers-reduced-motion: reduce)`
guards that disable it. The bubbles are decorative; nothing is communicated by
their movement.

## The early-access form

### Schema

Two migrations, following the repo's paired convention:

- `20260806000100_early_access.sql`
- `20260806000200_early_access_rls.sql`

```sql
create table early_access_requests (
  id            uuid primary key default gen_random_uuid(),
  email         text not null,
  business_name text,
  industry      text,
  source_path   text,
  created_at    timestamptz not null default now()
);
create unique index early_access_requests_email_key
  on early_access_requests (lower(email));
```

`industry` is set when the form is submitted from a vertical page; `source_path`
records which page converted. Both are nullable — the homepage form has neither.

RLS is enabled with **no policies at all** (M6). The anon key cannot read or
write the table. The server action uses the service-role client.

### Flow

`AccessForm` → `submitEarlyAccessAction` → `runAction("site.early_access", …)`.

`runAction` is session-agnostic — the help action calls `requireSession()` inside
its own body — so it is reusable for an unauthenticated endpoint without change.

1. `earlyAccessSchema.parse()`. Lives in `src/lib/site/early-access.ts`, a pure
   module mirroring `src/lib/support/help-request.ts`: validation and message
   composition, no I/O, so it is testable without a database or a mail provider.
2. Plain insert; a unique-violation (`23505`, meaning the address is already on
   the list) is caught and treated the same as a fresh success — see
   "Failure policy" below.
3. `sendEmail()` to `SUPPORT_INBOX_EMAIL`, reusing the existing Resend path.

### Failure policy: capture beats notify

| Insert | Email | Result |
| --- | --- | --- |
| ok | ok | success |
| ok | fails | **success** — the lead is safe |
| fails | ok | **success** — the inbox is a record |
| fails | fails | error, generic sentence |

In demo mode (no Supabase configured) persistence is skipped, and
`LIA_EMAIL_MODE=log` prints the lead. The form works end-to-end on a fresh clone
with an empty `.env`.

A resubmitted address always returns success and never says "you are already on
the list" — that answer turns the form into an email-enumeration oracle.

### Abuse

A honeypot field stops naive bots: `website` is hidden off-screen and
untabbable, and any non-empty value fails validation with a generic error that
tells the bot nothing about which field betrayed it. That is the extent of it —
there is no minimum time-to-submit check or any other application-level
throttle, and this document does not claim the endpoint is rate-limited (M11).
Before launch, a platform-level control — Vercel BotID, or a WAF rate-limit
rule scoped to the action's route — should be added. That is recorded in
"Pre-launch" below rather than approximated in application code.

## Crawl surface

**`src/app/sitemap.ts`** is generated from the route table. Each record carries
`priority` (home 1.0; product, platforms, pricing 0.8; verticals 0.7; legal 0.3)
and an explicit `lastModified` date. Build time is deliberately not used: it
claims every page changed on every deploy, which is noise a crawler learns to
ignore. Origin comes from `appOrigin()`.

**`src/app/robots.ts`** allows the marketing routes and disallows the product
surface — `/overview`, `/mentions`, `/reviews`, `/reddit`, `/media`,
`/responses`, `/escalations`, `/insights`, `/locations`, `/rules`,
`/integrations`, `/brand-voice`, `/settings`, `/help` — plus `/api/`, `/auth/`,
`/invite/` and the four auth screens. Those are gated already, so this is not a
security control; it keeps sign-in pages out of the index and stops crawlers
spending budget on redirects. It points at `${appOrigin()}/sitemap.xml`.

## The 404 pages

Next resolves `notFound()` to the nearest boundary in the segment hierarchy, and
URLs matching no route at all fall through to the **root** boundary. After this
change most such URLs are marketing typos and dead inbound links, so the two
cases split:

- **`src/app/not-found.tsx`** — rebranded to the site. A root not-found cannot
  inherit a route group's layout, so it renders `SiteNav` and `SiteFooter`
  directly: wordmark, one line of copy, links to Product · Platforms · Pricing,
  the access CTA, and a single speech bubble for continuity.
- **`src/app/(app)/not-found.tsx`** — new, holding the existing `EmptyState` and
  "Back to overview" button verbatim. This catches `notFound()` raised inside
  the product, such as a mention id that does not resolve, where "back to
  overview" is the right offer and marketing chrome would be absurd.

## Error and loading states

`(site)/error.tsx` gives the group a boundary in site branding.

There is no `(site)/loading.tsx`. These pages are statically rendered and never
suspend; a loading file would be unreachable code. `CLAUDE.md` asks for
route-level loading and error states, and this is the honest reading of that
requirement for static content.

## Testing

Vitest, modelled on `tests/help-request.test.ts`.

| File | Covers |
| --- | --- |
| `tests/early-access.test.ts` | Schema accepts and rejects; trimming and lowercasing; honeypot rejection; composed notification bodies cannot inject mail headers through the email field |
| `tests/site-routes.test.ts` | Every route-table entry passes `isSitePath`; nav and footer link sets are subsets of the table. Guards the middleware-gating bug class directly |
| `tests/site-palette.test.ts` | Recomputes contrast from shipped token values, asserts AA thresholds |

`npm run verify` (lint, typecheck, test, build) is the gate.

## Out of scope

- Any change to product screens under `(app)`
- Response generation, or any claim the site makes about it beyond what
  `docs/product-spec.md` already supports
- Analytics, cookie consent, or A/B testing
- A CMS. Copy is typed content records; if marketing needs to edit without a
  deploy, that is a separate project
- Reconciling `CLAUDE.md`'s restaurant-first brief with the site's four verticals

## Pre-launch checklist

Items this design deliberately does not build, which must be handled before the
site is public:

1. **Rate limiting** on the early-access action, at the platform layer (M11)
2. **Legal review** of the drafted Privacy and Terms copy. It is placeholder
   written to fill the footer's links, not reviewed language
3. **`APP_URL`** set in production, or `sitemap.ts` and `robots.ts` emit
   `http://localhost:3000`
4. **`SUPPORT_INBOX_EMAIL` and `RESEND_API_KEY`** set, or lead notifications
   silently log instead of sending
5. **OpenGraph image** — the metadata block references one that must be designed
