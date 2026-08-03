# Claude Code Instructions — Lia

## Objective

Build Lia as a polished, production-oriented SaaS application for restaurant groups. The app monitors reviews, Reddit, news coverage, and supported article comments; generates brand-aware responses; routes sensitive issues; and produces cross-channel reputation intelligence.

## Working method

1. Read all files under `docs/` before modifying code.
2. Use the visual references under `public/reference-screens/`.
3. Preserve one consistent shell across all routes.
4. Implement reusable primitives before duplicating UI.
5. Use realistic mock data until integrations are implemented.
6. Keep platform capabilities explicit. Never imply direct publishing where the source does not support it.
7. Make high-risk actions approval-first.
8. Use sentence case throughout the interface.

## Visual direction

- Dark navy left navigation
- White and very light gray content surfaces
- Purple primary accent
- Green success, amber warning, red risk
- Thin borders, restrained shadows, rounded cards
- Dense but readable B2B SaaS layout
- Desktop-first, responsive down to tablet
- Avoid ornamental gradients except subtle accent treatments

## Engineering standards

- TypeScript strict mode
- Server components by default
- Client components only where interactivity requires them
- Reusable typed mock data
- Accessible labels and keyboard states
- No inline secrets
- No `any` unless justified in a comment
- No monolithic page components over roughly 300 lines
- Route-level loading and error states

## Core routes

- `/overview`
- `/mentions`
- `/reviews/google/[id]`
- `/reddit/[id]`
- `/media/[id]`
- `/responses`
- `/escalations`
- `/insights`
- `/locations`
- `/rules`
- `/integrations`
- `/brand-voice`
- `/settings`

## Required shared components

- App shell and sidebar
- Organization/location switcher
- Page header
- KPI card
- Filter bar
- Status badge
- Source badge
- Mention list item
- Detail panel
- Response composer
- Timeline
- Empty state
- Error state
- Confirmation dialog
- Data table
- Chart container
