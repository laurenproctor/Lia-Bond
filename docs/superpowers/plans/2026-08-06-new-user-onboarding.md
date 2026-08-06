# Plan — new-user onboarding

Branch: `feature/new-user-onboarding`

Baseline on `master` before any edit: `npm ci` clean, `npm run lint` clean,
`npm run typecheck` clean, `npm run test` 47 files / 798 tests passing,
`npm run build` succeeded, `npm run db:validate` 25 files parsed.

## Shape

Five wizard steps plus a separate Workspace Ready screen, in an authenticated
route group outside the product shell. Progress lives in one
organization-scoped row so it survives refresh, sign-out, and device change.

## 1. Data model

`supabase/migrations/20260808000100_organization_onboarding.sql`

- enums `onboarding_status`, `onboarding_step`
- table `organization_onboarding`, PK `organization_id`, one row per org
- `set_updated_at` trigger
- `provision_organization` rewritten to insert the onboarding row in the same
  function body — same transaction as the organization and the owner membership
- backfill: every existing organization gets a `completed` row
- audit vocabulary extended with eleven `onboarding.*` events, attributed to
  `entity_type = 'organization'` (no new entity enum value needed)

`supabase/migrations/20260808000200_organization_onboarding_rls.sql`

- RLS on; select for any active member (route guards read it); insert/update
  for owner and admin only; no delete

## 2. Domain

- `src/domain/enums.ts` — `ONBOARDING_STATUSES`, `ONBOARDING_STEPS`, eleven new
  audit event types
- `src/domain/entities/onboarding.ts` — row schema, `ORGANIZATION_SIZES`,
  `INDUSTRY_OPTIONS`, step metadata table, and the pure progress functions
  (`stepState`, `firstIncompleteStep`, `isStepReachable`, `resumePath`)
- `src/domain/entities/oauth-state.ts` — allow `/onboarding/locations` and
  `/onboarding/connect-sources` as OAuth return paths

## 3. Repository

- `OnboardingRepository` on `LiaDataSource`: `get`, `create`, and one method per
  step transition, plus `completeOnboarding` and `markReadyViewed`
- `OrganizationRepository.update` for step 1 (slug is never writable)
- Supabase and demo adapters, plus `toOrganizationOnboarding` mapper
- seed: onboarding rows for both seeded organizations, `completed`

## 4. Server layer

- `src/lib/auth/permissions.ts` — `onboarding.manage` (owner, admin)
- `src/lib/onboarding/context.ts` — `getOnboardingState`, `requireOnboardingStep`
  (server-side guard; redirects, never renders a future step)
- `src/lib/onboarding/service.ts` — transitions + audit, one place
- `src/lib/onboarding/preview.ts` — deterministic brand-voice preview, no model
- `src/lib/onboarding/quick-win.ts` — the five-way quick-win resolution from real
  repository data
- `src/app/actions/onboarding.ts` — thin actions

## 5. Routing

- `signUpAction` → `/onboarding/organization`; pending organization name carried
  in signup metadata for the email-confirmation path, provisioned in
  `/auth/callback`
- `signInAction` and `/auth/callback` resolve the onboarding destination
- `(app)/layout.tsx` redirects owners/admins of an incomplete organization
  before rendering the sidebar
- `middleware.ts` gains `/onboarding` as a product path

## 6. UI

`src/app/onboarding/{layout,organization,connect-sources,locations,brand-voice,team,ready}`
and `src/components/onboarding/*`, on the marketing-site tokens
(`site-ink`, `site-orange`, `site-blue`, `font-site`). No purple, no sidebar.
The ready screen renders no progress strip.

## 7. Review import

There is no job runner for review sync — `vercel.ts` schedules only the news
poll and the analysis sweep. So imports are **not** enqueued at step 3. The
ready screen offers a real "Start importing reviews" action that calls the
existing `syncGoogleReviews` service, and the import panel renders only from
real `platform_sync_runs` rows.

## 8. Tests

New suites under `tests/`: onboarding progress, guard, repositories, actions,
signup routing, brand-voice preview, quick-win resolution, and the ready
screen's honesty rules.
