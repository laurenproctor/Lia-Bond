# Lia

Lia is a multi-location reputation intelligence and response platform for
restaurants. It monitors reviews, Reddit discussions, news coverage, and article
comments; analyzes sentiment and reputational risk; drafts brand-aware
responses; routes sensitive issues for approval; and publishes where platform
integrations permit.

**Core promise:** know what people are saying, respond when it matters.

## Stack

| Concern | Choice |
| --- | --- |
| Framework | Next.js 16, App Router, React 19 |
| Language | TypeScript, strict |
| Styling | Tailwind CSS 4 |
| Validation | Zod 4 |
| Database | Supabase / PostgreSQL |
| Tests | Vitest |
| Auth | not yet wired — see "Authentication" |

## Quick start

```bash
npm install
npm run dev          # http://localhost:3000
```

With no environment configured, Lia runs on a deterministic demo dataset and the
sidebar shows a **Demo data** badge. Everything works — including the mutations
and the audit trail — but nothing is persisted beyond the process.

## Commands

| Command | What it does |
| --- | --- |
| `npm run dev` | Development server |
| `npm run build` | Production build |
| `npm run start` | Serve the production build |
| `npm run lint` | ESLint |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run test` | Vitest suites |
| `npm run test:watch` | Vitest in watch mode |
| `npm run verify` | lint → typecheck → test → build |
| `npm run db:seed:generate` | Regenerate `supabase/seed.sql` from the typed dataset |
| `npm run db:validate` | Parse every migration with the real PostgreSQL grammar |
| `npm run db:migrate` | Apply pending migrations |
| `npm run db:reset` | Drop, re-migrate, and re-seed the local database |
| `npm run db:verify-rls` | Reset, then run the row-level security assertions |

## Environment

Copy `.env.example` to `.env.local`. Nothing is required for local development.

| Variable | Scope | Purpose |
| --- | --- | --- |
| `NEXT_PUBLIC_SUPABASE_URL` | public | Supabase project URL. Setting this and the anon key switches the app onto the database. |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | public | Anon key. Only grants what row-level security allows. |
| `SUPABASE_SERVICE_ROLE_KEY` | **server only** | Bypasses row-level security. Required by the Google integration: OAuth state and encrypted credentials live in tables with zero policies. Never `NEXT_PUBLIC_`, never imported into a client component. |
| `LIA_DATA_SOURCE` | server | `demo` or `supabase`. Pins the adapter; otherwise the credentials decide. |
| `APP_URL` | server | Public origin of this deployment. Defaults to `http://localhost:3000`. |
| `TOKEN_ENCRYPTION_KEY` | **server only** | 32 bytes. Encrypts OAuth tokens before storage with AES-256-GCM. `openssl rand -base64 32`. |
| `TOKEN_ENCRYPTION_KEY_ID` | server | Names the active key so ciphertext survives a rotation. |
| `GOOGLE_CLIENT_ID` | **server only** | Google OAuth client. |
| `GOOGLE_CLIENT_SECRET` | **server only** | Google OAuth client secret. Never `NEXT_PUBLIC_`. |
| `GOOGLE_OAUTH_REDIRECT_URI` | server | Must match a URI registered on the OAuth client exactly. Read from configuration, never from a request parameter. |
| `GOOGLE_INTEGRATION_MODE` | server | `live` or `mock`. Unset decides from the credentials. `mock` is refused in production. |

Shape is validated at startup; presence is validated at first use, so the app
still builds and runs without a Google project configured.

Never commit real credentials. `.env*` is gitignored.

## Google Business Profile

Lia's first production integration: OAuth, account and location discovery,
location mapping, connection health, reauthorization, disconnect — and review
synchronisation.

Reviews for each mapped location are imported into `public.mentions`, the same
table every other source normalises into, so they appear in the unified inbox
with no Google-only workspace. Running a sync twice creates no duplicates, and
never overwrites a status, draft, approval, or escalation somebody has since put
on a review.

**It does not publish anything, and it does not watch Google.** Lia posts no
reply — the owner reply it stores is what Google already shows — and there is no
scheduler or Pub/Sub subscription, so a location is only as current as its last
sync. Every screen says so rather than letting a green badge imply otherwise.

Run a sync from `/integrations/google-business-profile` → **Connected
locations**, or over HTTP:

```bash
curl -X POST http://localhost:3000/api/integrations/google-business-profile/reviews/sync \
  -H 'content-type: application/json' \
  -d '{"channelId":"<platform_profiles.id>"}'
```

Review sync needs **no new environment variables and no new OAuth scope** — it
runs on the `business.manage` grant the connection already holds.

Try it without a Google Cloud project:

```bash
# .env.local
GOOGLE_INTEGRATION_MODE=mock
TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)
```

The mock redirects back through Lia's own callback, so the whole flow — state
validation, code exchange, encrypted storage, discovery, mapping, review import,
disconnect — runs for real. Only the network call to Google is absent. Its
review fixtures are deliberately awkward: a rating with no words, an anonymous
reviewer, and one that already carries an owner reply. Mock mode fails at
startup when `NODE_ENV=production`.

Full detail, including the Google Cloud Console setup and the scope rationale:
[`docs/integrations/google-business-profile.md`](docs/integrations/google-business-profile.md).

## Local database setup

Requires Docker (for `supabase start`) and the Supabase CLI.

```bash
supabase start                 # local Postgres, API, and Studio
npm run db:reset               # migrations + supabase/seed.sql
npm run db:verify-rls          # assert tenant isolation
```

Then put the printed URL and anon key into `.env.local` and restart `npm run dev`.

> **Status:** the migrations in this repository have never been executed. The
> environment used to build the foundation had libpq client tools only — no
> PostgreSQL server binary — and no running Docker daemon. The SQL is validated
> by parsing it with the real PostgreSQL grammar (`libpg_query`), not by running
> it. Run `npm run db:reset` and `npm run db:verify-rls` before trusting it.

## Seed data

`src/lib/seed/dataset.ts` is the single source of seed truth. It is typed,
deterministic (ids derive from stable labels; timestamps anchor to a fixed
instant), and validated against the domain schemas by the test suite.

`supabase/seed.sql` is **generated** from it:

```bash
npm run db:seed:generate
```

Do not hand-edit the SQL. Every insert is `on conflict (id) do nothing`, so
re-seeding is safe.

The dataset contains two organizations. The second one is small and dull on
purpose — it is what makes cross-tenant isolation testable.

## How tenancy is enforced

Every business record belongs to exactly one organization, enforced at three
layers.

**Type layer.** Every organization-owned repository method takes an
`OrganizationScope`. There is no `listAll()`. Forgetting the tenant filter is a
compile error, not a data leak.

**Application layer.** `getOrganizationContext()` re-reads the membership row on
every request. The active organization lives in an httpOnly cookie, which is
treated as an untrusted hint: if the caller does not hold an *active* membership
in the organization it names, the value is discarded and the first organization
they genuinely belong to is used instead. A forged cookie buys nothing.

The organization slug is deliberately **not** in the URL. `CLAUDE.md` fixes the
route list (`/overview`, `/mentions`, …), and prefixing every route with an
organization segment would contradict it.

**Database layer.** Row-level security is enabled on every organization-owned
table. Policies call `public.is_organization_member(organization_id)`, which
checks for an active membership belonging to `auth.uid()`. No policy grants
access on the basis of being authenticated. OAuth material lives in
`platform_connection_secrets`, which has RLS enabled and **zero policies** — only
the service role can reach it.

## Authentication

No provider is wired up yet. `src/lib/auth/session.ts` exposes `getSession()`
with two implementations behind one signature: Supabase auth when configured,
and a demo session otherwise (selectable through the `lia_demo_user` cookie so
each role can be exercised locally). Membership verification, permission checks,
and audit writes are identical in both, so introducing a real provider is a
change to one file rather than to every call site.

## How audit events are generated

Every mutation follows the same four steps, and none of them is optional:

1. `mutationContext()` — identity plus verified membership.
2. `assertPermission()` / `assertPermissionForLocation()` — the central matrix in
   `src/lib/auth/permissions.ts`. No role check is written inline in a component
   or an action body.
3. The repository call, which enforces legal state transitions.
4. `recordAuditEvent()` — actor, organization, entity, and a `diff()` of only the
   fields that changed.

Audited events: `mention.status_changed`, `response.assigned`,
`response.approved`, `response.rejected`, `escalation.assigned`,
`escalation.status_changed`, `automation_rule.enabled`,
`automation_rule.disabled`, `location.manager_changed`,
`integration.oauth_started`, `integration.oauth_completed`,
`integration.connected`, `integration.reauthorization_started`,
`integration.reauthorized`, `integration.health_checked`,
`integration.health_degraded`, `integration.profile_connected`,
`integration.profile_mapped`, `location.created_from_integration`,
`integration.disconnected`, `integration.credentials_revoked`,
`integration.credentials_revocation_failed`.

Integration events never carry tokens, authorization codes, OAuth state values,
or provider error payloads. What they record is scopes, account identity, and
state transitions.

The trail is append-only. There is no update path in the application layer, and
the migration revokes `UPDATE` and `DELETE` on `audit_events` from the
authenticated role.

## Roles

| Role | Can do |
| --- | --- |
| Owner, Admin | Everything, including connecting and disconnecting integrations |
| Communications lead | Mentions, response assignment, escalations, automation, integration location mappings |
| Location manager | Mentions and escalations **for locations they manage** |
| Approver | Approve or reject responses |
| Analyst, Read-only | Read only |

Writing a draft and approving it are separate jobs: a communications lead can
assign a response but cannot sign it off.

## Adding a platform connector

Google Business Profile is the reference implementation
(`src/integrations/google-business-profile/`). A second connector implements
`PlatformConnector` from `src/integrations/connector.ts` and is resolved by
`src/integrations/registry.ts`; nothing above that boundary branches on which
platform it received.

1. Add the platform to `PLATFORMS` in `src/domain/enums.ts` and to the `platform`
   enum in a new migration.
2. Add its source types to `MENTION_SOURCE_TYPES` and map them in
   `SOURCE_TYPE_PLATFORM` (`src/domain/entities/mention.ts`).
3. Give it a glyph in `src/components/ui/source-badge.tsx` and labels in
   `src/lib/labels.ts`.
4. Create a `PlatformConnection` with an honest `ConnectorCapabilities` object.
   The UI reads capabilities to decide whether to offer publishing — never
   claim `canPublishResponses` a platform does not grant.
5. Normalize incoming records into `CreateMentionInput` and call
   `mentions.create()`. It upserts on
   `(platform_connection_id, source_type, external_id)`, so re-syncing updates
   rather than duplicating.
6. Keep the raw API response in `rawPayload`. Normalization loses detail;
   `rawPayload` is how it is recovered.

## Project layout

| Path | Contents |
| --- | --- |
| `src/app/` | Routes. Product screens live in the `(app)` group. |
| `src/app/actions/` | Server actions — the only write path. |
| `src/components/` | Presentational only. Never queries the database. |
| `src/domain/` | Zod schemas, types, lifecycle enums. No I/O. |
| `src/integrations/` | Platform connector boundary. All Google API behaviour lives here. |
| `src/lib/integrations/` | OAuth state, credentials, discovery, mapping, health. |
| `src/lib/crypto/` | Credential encryption. Server-only. |
| `src/lib/auth/` | Session and the permission matrix. |
| `src/lib/tenancy/` | Active-organization resolution. |
| `src/lib/data/` | Repository interfaces, demo and Supabase adapters. |
| `src/lib/audit/` | Append-only audit recording. |
| `src/lib/seed/` | The deterministic dataset. |
| `src/lib/view-models/` | Domain records → component props. |
| `supabase/` | Migrations, generated seed, RLS verification. |
| `tests/` | Vitest suites. |
| `docs/` | Product spec, data model, screens, architecture. |

## Documentation

- `docs/architecture/current-state.md` — stack, data flow, decisions, known gaps
- `docs/integrations/google-business-profile.md` — OAuth, scopes, encryption, mapping, disconnect
- `docs/product-spec.md` — positioning, capability model, automation philosophy
- `docs/data-model.md` — entity reference
- `docs/screens.md` — route and module inventory
- `docs/design-system.md` — tokens, spacing, component rules

## Product principle

Every screen answers one operational question:

> What does the restaurant need to know or do next?

Organized around: **detect → understand → decide → respond → escalate → learn**
