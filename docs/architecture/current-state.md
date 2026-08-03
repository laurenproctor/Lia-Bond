# Current state

Factual snapshot of the Lia codebase after workflow 03 (Google Business Profile
review synchronisation). Update this document whenever a workflow changes the
stack, the tenancy model, or the data flow.

## Stack

| Concern | Choice | Version |
| --- | --- | --- |
| Framework | Next.js, App Router | 16.2.12 |
| UI runtime | React | 19.2.8 |
| Language | TypeScript, `strict` + `noUncheckedIndexedAccess` | 5.7 |
| Styling | Tailwind CSS 4, tokens declared with `@theme` | 4.3 |
| Icons | lucide-react | 0.468 |
| Charts | recharts | 3.10 |
| Validation | zod | 4.4 |
| Credential encryption | `node:crypto`, AES-256-GCM | stdlib |
| SQL validation | libpg-query (parse only) | 17.x |
| Database (target) | Supabase / PostgreSQL | — |
| Database client | `@supabase/supabase-js`, `@supabase/ssr` | 2.x / 0.12 |
| Tests | vitest (node environment) | 4.x |
| Auth provider | **none yet** — see "Authentication" below | — |
| State management | none; server components plus local `useState` | — |

## Directories

| Path | Contents |
| --- | --- |
| `src/app/` | App Router routes. All product screens live in the `(app)` route group. |
| `src/app/actions/` | Server actions. The only write path in the application. |
| `src/components/` | Presentational components. **Never** query the database. |
| `src/domain/` | Zod schemas, inferred types, and lifecycle enums. No I/O. |
| `src/integrations/` | Platform connector boundary. All Google API behaviour lives behind it. |
| `src/lib/integrations/` | OAuth state, credential handling, discovery, mapping, health. |
| `src/lib/crypto/` | AES-256-GCM credential vault. Server-only. |
| `src/lib/auth/` | Session resolution and the central permission matrix. |
| `src/lib/tenancy/` | Active-organization resolution and membership verification. |
| `src/lib/data/` | Repository interfaces plus the demo and Supabase adapters. |
| `src/lib/audit/` | Append-only audit event recording. |
| `src/lib/seed/` | Deterministic demo dataset — the single source of seed truth. |
| `src/lib/view-models/` | Maps domain records onto the props existing components expect. |
| `supabase/migrations/` | Ordered SQL migrations. |
| `supabase/seed.sql` | **Generated** from `src/lib/seed/dataset.ts`. Do not hand-edit. |
| `scripts/` | Repository tooling: the seed-SQL generator and the migration parser. |
| `tests/` | Vitest suites. |

## Routes

All screens render inside one shell (`src/app/(app)/layout.tsx`).

| Route | Purpose | Data source |
| --- | --- | --- |
| `/` | Redirect to `/overview` | — |
| `/overview` | Reputation health and urgent work | repositories |
| `/mentions` | Unified inbox across every source | repositories |
| `/reviews` → `/reviews/google/[id]` | Google review workspace | repositories |
| `/reddit` → `/reddit/[id]` | Reddit conversation workspace | repositories |
| `/media` → `/media/[id]` | News and media workspace | repositories |
| `/responses` | Response library | repositories |
| `/escalations` | Escalation centre | repositories |
| `/insights` | Cross-channel analytics | repositories + typed fixture |
| `/locations` | Portfolio and per-location settings | repositories |
| `/rules` | Automation rules | repositories |
| `/integrations` | Platform connections and capabilities | repositories |
| `/integrations/google-business-profile` | Google connection detail, health, disconnect | repositories |
| `/integrations/google-business-profile/setup` | Location selection and mapping | repositories + Google API |
| `/api/integrations/google-business-profile/connect` | Starts OAuth (POST only) | — |
| `/api/integrations/google-business-profile/callback` | OAuth callback | — |
| `/api/integrations/google-business-profile/reviews/sync` | Manual review sync (POST only) | repositories + Google API |
| `/brand-voice` | Voice configuration | typed fixture (no table yet) |
| `/settings` | Organization administration | repositories + typed fixture |

## Data flow

```text
server component / server action
  └─ getOrganizationContext()        ← verifies active membership, returns org + role
       └─ getDataSource()            ← picks the adapter for this deployment
            ├─ demo adapter          in-memory, deterministic seed dataset
            └─ supabase adapter      PostgREST under the caller's JWT (RLS applies)
  └─ view-models/*                   ← maps domain records to component props
       └─ components/*               ← presentational only
```

Every repository method takes an `OrganizationScope`. There is no way to ask a
repository for rows without naming an organization, so a missing tenant filter is
a type error rather than a data leak.

Writes additionally pass through `assertPermission()` and then
`recordAuditEvent()`. Both live outside the components.

### Integrations

```text
route handler / server action
  └─ authorize(permission)              ← central matrix, no inline role checks
       └─ src/lib/integrations/*        ← orchestration, audit, health
            ├─ registry → PlatformConnector
            │    └─ google-business-profile/client.ts   ← the only network I/O
            ├─ credentials.ts           ← the only module that unseals a token
            └─ src/lib/data/*           ← scoped repositories
```

Nothing above `src/integrations/` handles an HTTP status code from a provider,
and nothing below it knows what an organization is. Provider failures are
normalised into `IntegrationError` codes chosen around what the user must do
next, not around what the provider said.

## Tenancy

Enforced at three layers:

1. **Type layer** — every organization-owned repository method requires an
   `OrganizationScope`. `listAll()`-style methods do not exist.
2. **Application layer** — `getOrganizationContext()` re-reads the membership row
   on every request. A client-supplied organization id is never trusted; the
   cookie holds an id that is validated against `memberships` before use.
3. **Database layer** — row-level security is enabled on every organization-owned
   table. Policies call `public.is_organization_member(organization_id)`, which
   checks for an `active` membership belonging to `auth.uid()`. No policy grants
   access on the basis of authentication alone.

The active organization is stored in the `lia_active_organization` cookie
(`httpOnly`, `sameSite=lax`). The organization slug is deliberately **not** in the
URL: `CLAUDE.md` fixes the route list (`/overview`, `/mentions`, …), and prefixing
every route with an organization segment would contradict it. The cookie is
treated as an untrusted hint and re-verified server-side on every resolve.

## Authentication

No auth provider is wired up yet. `src/lib/auth/session.ts` exposes
`getSession()` with two implementations behind one signature:

- **Supabase** — used when `NEXT_PUBLIC_SUPABASE_URL` and
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` are set. Reads the Supabase auth session.
- **Demo** — the default. Returns a seeded user, selectable through the
  `lia_demo_user` cookie so role behaviour can be exercised locally.

Membership verification, permission checks, and audit writes run identically in
both modes, so introducing a real provider is a change to one file rather than a
change to every call site.

## Technical constraints

- `CLAUDE.md` fixes the route list, the visual direction, and sentence casing.
- Server components by default; client components only where interactivity needs them.
- No page component over roughly 300 lines.
- Platform capabilities must stay explicit. The UI must never imply direct
  publishing where a connector cannot publish — and, since workflow 02, must
  never let a successful OAuth handshake imply that reviews are being read.
  `src/lib/integrations/capabilities.ts` states each capability separately, and
  "Review sync: Not configured" must not change until the feature is real.
- OAuth tokens never reach a client component, a repository DTO, an audit event,
  a log line, or a redirect URL. `src/lib/integrations/credentials.ts` is the
  only module that decrypts one.
- A synchronisation writes only source-owned fields. Lia's workflow state —
  status, sentiment, risk, assignment, drafts, approvals, escalations — is not
  reachable from `IngestMentionInput`, so an ingest cannot overwrite it even by
  accident. `SOURCE_OWNED_MENTION_FIELDS` is the single declaration of the line.
- Review text and reviewer names never appear in an audit event, a sync-run
  error message, a log line, or an API response.
- Relative times in demo mode are measured against a fixed reference instant
  (`REFERENCE_NOW`) so server and client renders agree and fixtures stay stable.

## Decisions made in workflow 01

| # | Decision | Reason |
| --- | --- | --- |
| D1 | Supabase/PostgreSQL as the database target | `README.md` and `prompts/04-add-supabase.md` both specify it. |
| D2 | Two adapters behind one repository interface | `prompts/04` asks for "a fallback demo mode". It also lets the app and its tests run with no database provisioned. |
| D3 | `supabase/seed.sql` is generated from `src/lib/seed/dataset.ts` | One source of truth; the demo adapter and the SQL seed cannot drift apart. |
| D4 | Organization held in a verified cookie, not a URL segment | Least disruptive change that does not contradict the fixed route list. |
| D5 | Session abstraction now, provider later | Keeps membership and permission logic real and testable before auth lands. |
| D6 | UUIDv4 primary keys, `timestamptz` stored in UTC | Matches Supabase conventions and avoids key collisions across environments. |
| D7 | Lifecycle states are Postgres `enum` types | Rejects invalid states at the database boundary, not only in TypeScript. |
| D8 | Raw platform payloads live in `mentions.raw_payload` (`jsonb`) | Normalized columns stay clean while the original response is preserved. |

## Decisions made in workflow 02

| # | Decision | Reason |
| --- | --- | --- |
| D9 | Connector boundary (`PlatformConnector`), not a plugin framework | One implementation plus a mock ships today. Extension points for connectors that do not exist would be guessing at their requirements. What the interface does provide is the shape a second connector must satisfy — the part that is expensive to retrofit. |
| D10 | `CredentialSession` carries a write-back callback | A refresh mid-call persists immediately. Returning "and also please save this" would mean every request refreshes again, burning quota and risking a dropped token rotation. |
| D11 | OAuth state stored as a SHA-256 hash | Read access to `oauth_states` must not be enough to forge a callback, for the same reason a password hash is stored rather than a password. |
| D12 | State consumed by one conditional `UPDATE` | Two concurrent callbacks would both pass a separate `SELECT`. The `WHERE` clause is the lock. |
| D13 | Credentials in a separate service-role-only table, never on a DTO | `platformConnectionSchema.parse()` strips unknown keys, so a credential column that ever leaked onto a row is dropped rather than serialised to a client component. |
| D14 | AES-256-GCM with the key in the environment | Authenticated encryption so tampering fails rather than decrypting to something attacker-influenced; key outside Postgres so a database dump alone decrypts nothing. |
| D15 | One connection row per platform per organization | Every `platform_profiles` row references the connection id. Reauthorizing into a second row would orphan every mapping the user made. |
| D16 | No `/[organizationSlug]` route prefix for the setup screen | Contradicts D4 and the fixed route list in `CLAUDE.md`. The organization is bound into the OAuth state and re-verified on the callback instead. |
| D17 | No transaction around a mapping batch | The repository interface is adapter-agnostic: the demo adapter has no transaction and PostgREST exposes none. Each decision is independent and idempotent, and failures return per row. Recorded as a real trade-off in the integration doc. |
| D18 | New connections declare **no** review capability | OAuth succeeding proves authentication and discovery work. Review sync does not exist, and a capability set claiming otherwise would drive the UI to offer publishing that is not there. |
| D19 | No `integration.view` permission | The matrix gates writes. Reading is governed by active membership and the RLS select policies. A permission every role held would add a name without adding a check. |
| D20 | Mock mode refused at environment parse in production | A deployment quietly serving fabricated Google accounts is worse than one that fails to boot. |

## Decisions made in workflow 03

| # | Decision | Reason |
| --- | --- | --- |
| D21 | Google reviews extend `public.mentions`; no `google_reviews` table | The canonical model already exists, already has `google_review` as a source type, and already carries the unique constraint that makes ingest idempotent. A parallel table would fork the inbox, insights, escalations, and the response pipeline — and would need merging back at exactly the moment there was real data to lose. The cost is eight platform-neutral columns. |
| D22 | A separate `mentions.ingest()` rather than reusing `create()` | The two want opposite things on conflict. `create` writes the whole record; an ingest must write only what the source owns. Splitting them makes the guarantee structural: `IngestMentionInput` has no field for status, sentiment, risk, or `receivedAt`, so a re-import cannot move an escalated review back to "new". |
| D23 | Full refetch every sync; no incremental cursor | Google orders by `updateTime desc`, so a "stop at the first one we have" rule skips an older review whose *edit* pushed it up the list — the review most worth noticing, because somebody changed their mind in public. The upsert makes refetching consequence-free, so correctness costs bandwidth rather than a cursor that can silently lose data. `platform_profiles.sync_cursor` stays unused. |
| D24 | The lock is a partial unique index, not an application check | An application check is two statements with a race between them. And an in-memory lock would not help at all: Lia runs on serverless functions, so two concurrent requests are routinely two processes. |
| D25 | Stale `running` runs are reclaimed after 30 minutes | A function killed mid-sync leaves its row holding the lock. Without a reclaim window, one crash blocks a location's syncs permanently and the only remedy is editing the database. |
| D26 | `platform_sync_runs` is a table, not a log line | "Last synced two days ago" is half an answer; the other half is what has happened since. A sync that failed silently looks exactly like a location with no new reviews, and only recorded attempts distinguish them. |
| D27 | Sync runs are readable by any active member | Telling "no new reviews" from "the import is broken" is not a privileged question. An analyst looking at a quiet week needs it. Writing is narrower, matching `integration.sync_reviews`. |
| D28 | `raw_payload` left empty for Google reviews | D8 preserved raw payloads so normalisation changes lose nothing. Here the normalised columns already carry everything, and a verbatim copy would put a reviewer's display name and photo URL in a second, unmanaged place — more personal data in more places for no capability gained. |
| D29 | The owner reply is stored as source state, not as a `response_draft` | It is what Google already shows, published by somebody outside Lia. Modelling it as a draft would put a response in the library that Lia neither wrote nor approved, and would corrupt every "responses published" figure. |
| D30 | Reviews retry; discovery does not | A sync is background-shaped, where waiting out a 429 is right. Discovery runs inside a page render where a person is waiting, and three backoffs would hang the page for seven seconds before failing anyway. |
| D31 | Per-location sync buttons, no "sync everything" | Each location is a separate Google request against a shared quota. Forty restaurants behind one spinner is illegible and uninterruptible; bulk is the scheduler's job. |

## Known gaps after workflow 03

Carried over from workflow 01:

- **Migrations have never been executed.** This environment has libpq client
  tools only — no PostgreSQL server binary — and the Docker daemon is not
  running, so `supabase start` cannot run. The SQL is validated by parse only,
  now repeatably via `npm run db:validate`.
- The Supabase adapter is written against the schema but is **unverified against
  a live database** for the same reason. This now includes the credential and
  OAuth-state repositories, and the two Postgres functions they call.
- There is no real authentication provider, so `auth.uid()` is never populated in
  practice yet.
- Brand voice has no table; the screen still reads a typed fixture.
- Insights aggregates are computed in the repository layer over the full mention
  set. They will need SQL aggregates or a materialized view at real volume.

New in workflow 02:

- **The real Google OAuth flow has never been run.** No Google Cloud project was
  available. Every Google interaction in the test suite is stubbed, and the
  HTTP route handlers are covered by type-checking and the production build
  rather than by a live request.
- Location matching cannot use a phone number: `locations` has no phone column.
  It is the strongest signal available and the first weight to add when it exists.
- Connection health is checked manually only. There is no job system to hang a
  recurring check on, and adding one to run network calls on a timer is not a
  small change.
- New locations inherit the organization's default timezone. Google's location
  resource carries none, and inferring one from an address would be wrong for
  exactly the multi-city groups Lia serves.
- One connection per platform per organization: a group whose listings are split
  across two unrelated Google accounts cannot connect both.
- `accounts.list` runs on every render of the setup screen. No caching — fine at
  this scale, a quota consideration later.

New in workflow 03:

- **The v4 reviews endpoint has never been called against real Google**, for the
  same reason as the OAuth flow. Pagination, retry, and error classification are
  covered against a stubbed `fetch`.
- **No scheduler.** `syncGoogleReviews()` takes a `trigger` and accepts
  `scheduled`, and is deliberately callable without a request context, but
  nothing calls it on a timer. Reviews are as fresh as the last manual sync.
- **No Pub/Sub subscription**, so there is no push path for new reviews.
- Every sync refetches a location's full history. Correct and idempotent; more
  bandwidth than an incremental strategy would use. See D23.
- Deleted Google reviews are never removed from Lia. Google simply stops
  returning them, and a mention with a draft and an escalation attached is not
  something to delete because a page came back shorter.
- Sync runs accumulate without a retention policy. One row per location per
  sync; a sweep will be wanted once a scheduler exists.
- `latestForProfiles` reads up to 500 recent runs and folds them in the
  application. Fine for a handful of locations with short histories; it becomes
  a `distinct on` view before it becomes a different call site.
- Google review ids are assumed globally unique, which is what
  `mentions_unique_external` relies on for the Google source type. If two
  locations under one connection ever returned the same `reviewId`, the row
  would move between them rather than duplicating — no data loss, but the
  location attribution would follow whichever synced last.
