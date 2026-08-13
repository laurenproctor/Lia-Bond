# Current state

Factual snapshot of the Lia codebase after workflow 06, with brand voice
configuration, news monitoring, and the public marketing site integrated onto
one line of history. Update this document whenever a workflow changes the
stack, the tenancy model, or the data flow.

Those three streams were built in parallel on branches that never saw each
other. What that cost, and the one defect that existed only in the union, is
recorded under "Decisions made integrating the branches".

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
| SQL validation | libpg-query (parse), plus migrations applied to a live project | 17.x |
| Database (target) | Supabase / PostgreSQL | — |
| Database client | `@supabase/supabase-js`, `@supabase/ssr` | 2.x / 0.12 |
| Tests | vitest (node environment) | 4.x |
| Auth provider | Supabase Auth, email + password | — |
| State management | none; server components plus local `useState` | — |

## Directories

| Path | Contents |
| --- | --- |
| `src/app/` | App Router routes. Product screens live in the `(app)` route group; the public marketing site lives in `(site)`. |
| `src/app/actions/` | Server actions. The only write path in the application. |
| `src/lib/site/` | The marketing route table, and the content each public page renders. One source for the nav, the footer, the sitemap, and `robots.txt`. |
| `src/lib/support/` | Help requests: validation, message composition, and delivery mode. |
| `src/lib/brand-voice/` | Brand voice save service, form seed, summary derivation, and the deterministic preview both the settings screen and onboarding step 4 render. |
| `src/lib/onboarding/` | First-run setup: route guards, step transitions and their audit trail, quick-win resolution, import status, and the post-authentication destination. The brand-voice preview used to live here; it moved to `src/lib/brand-voice/` once `/brand-voice` rendered it too. |
| `src/components/` | Presentational components. **Never** query the database. |
| `src/domain/` | Zod schemas, inferred types, and lifecycle enums. No I/O. |
| `src/integrations/` | Platform connector boundary. All Google API behaviour lives behind it. |
| `src/ai/` | Model boundary. All Anthropic API behaviour lives behind it. |
| `src/news/` | News provider boundary (`NewsMonitor`). All GNews API behaviour lives behind it, plus the mock used in tests and demo mode. Deliberately not a `PlatformConnector` — see D78. |
| `src/lib/analysis/` | Analysis orchestration: prompt, schema, heuristic, run service. |
| `src/lib/monitoring/` | News orchestration: the relevance gate, the poll service, budget enforcement, implicit connection creation, query CRUD. |
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
| `scripts/` | Repository tooling: seed-SQL generator, migration parser, auth-user provisioning. |
| `tests/` | Vitest suites. |

## Routes

Product screens render inside one shell (`src/app/(app)/layout.tsx`). The
marketing site has its own shell (`src/app/(site)/layout.tsx`) and shares
nothing with it but the root layout's font.

| Route | Purpose | Data source |
| --- | --- | --- |
| `/` | The marketing home page. **No longer redirects to `/overview`** — see D91. | `src/lib/site/content` |
| `/overview` | Reputation health and urgent work | repositories |
| `/mentions` | Unified inbox across every source, plus a server-rendered detail pane selected via `?mention=` (a missing or stale id falls back to the first item) | repositories |
| `/reviews` → `/reviews/google/[id]` | Google review workspace | repositories |
| `/reddit` → `/reddit/[id]` | Reddit conversation workspace | repositories |
| `/media` → `/media/[id]` | News and media workspace | repositories |
| `/responses` | Response library, plus a server-rendered detail pane selected via `?selected=` that embeds the existing response composer — approve, reject, and save draft all work; approving a dirty composer carries its text into the same write as the decision; publish remains disabled | repositories |
| `/escalations` | Escalation centre, plus a server-rendered, read-only detail pane selected via `?selected=` showing the case's audit trail from `audit_events` | repositories |
| `/insights` | Cross-channel analytics | repositories + typed fixture |
| `/locations` | Portfolio and per-location settings | repositories |
| `/rules` | Automation rules | repositories |
| `/integrations` | Platform connections and capabilities | repositories |
| `/integrations/google-business-profile` | Google connection detail, health, disconnect | repositories |
| `/integrations/google-business-profile/setup` | Location selection and mapping | repositories + Google API |
| `/integrations/news-media` | Monitoring query management (create, edit, enable/disable, delete), poll history, rejected candidates | repositories |
| `/api/integrations/google-business-profile/connect` | Starts OAuth (POST only) | — |
| `/api/integrations/google-business-profile/callback` | OAuth callback | — |
| `/api/integrations/google-business-profile/reviews/sync` | Manual review sync (POST only) | repositories + Google API |
| `/api/cron/news-poll` | Scheduled poll sweep across every tenant (GET and POST, `CRON_SECRET`-guarded, bypasses the session gate — see Authentication) | repositories + GNews API |
| `/api/cron/analyze-mentions` | Scheduled analysis sweep across every tenant (GET and POST, `CRON_SECRET`-guarded, bypasses the session gate — see Authentication) | repositories + Anthropic API |
| `/sign-in` | Email and password sign-in. **Outside the app shell** — see D46. | Supabase Auth |
| `/sign-up` | Creates an account **and** the organization it owns. Outside the app shell. | Supabase Auth + `provision_organization` |
| `/invite/[token]` | Accept an invitation. Public — the invitee has no account yet. | `invitation_preview` / `accept_invitation` |
| `/forgot-password` | Requests a reset link. Outside the app shell. | Supabase Auth |
| `/reset-password` | Sets a new password using the recovery session. Outside the app shell. | Supabase Auth |
| `/auth/callback` | Where an emailed auth link lands; establishes the session | Supabase Auth |
| `/onboarding/organization` | Setup step 1 — enrich the organization created at signup. Outside the app shell. | repositories |
| `/onboarding/connect-sources` | Setup step 2 — three sources: Google (prerequisite), News & Media (optional, real monitoring queries), Reddit (not operational, honestly labelled) | repositories |
| `/onboarding/locations` | Setup step 3 — map Google listings, or add a location by hand | repositories + Google API |
| `/onboarding/brand-voice` | Setup step 4 — the existing five-axis voice | repositories |
| `/onboarding/team` | Setup step 5 — issue copyable invitation links | repositories |
| `/onboarding/ready` | Workspace Ready. **Not step 6** — no progress strip. | repositories |
| `/brand-voice` | Voice configuration | repositories |
| `/settings` | Organization administration | repositories + typed fixture |
| `/help` | In-app help requests | repositories + Resend |
| `/product`, `/platforms`, `/pricing`, `/contact` | Marketing pages. Public, statically rendered. | `src/lib/site/content` |
| `/for/[industry]` | Four vertical pages from one template, prerendered from `INDUSTRIES` | `src/lib/site/content` |
| `/privacy`, `/terms` | Placeholder legal pages | `src/lib/site/content` |
| `/robots.txt`, `/sitemap.xml` | Generated from the route table, so a new page cannot be forgotten in either | `src/lib/site/routes` |

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

Workflow 06 added two named, deliberate exceptions to "`listAll()`-style
methods do not exist": `MonitoringQueryRepository.listDue` and
`OrganizationRepository.listWithUnanalyzedMentions`. Both exist because cron
holds no membership and cannot construct a scope any other way — there is no
`getOrganizationContext()` to call with no request session behind it. Both are
service-role only, both return identifiers rather than a full cross-tenant
read (due query rows; organization ids), and neither is reachable from a
request path. The per-row `OrganizationScope` the cron routes then build from
each id is what carries tenancy from there — see D88 and Authentication.

The active organization is stored in the `lia_active_organization` cookie
(`httpOnly`, `sameSite=lax`). The organization slug is deliberately **not** in the
URL: `CLAUDE.md` fixes the route list (`/overview`, `/mentions`, …), and prefixing
every route with an organization segment would contradict it. The cookie is
treated as an untrusted hint and re-verified server-side on every resolve.

## Authentication

Supabase Auth, email and password. `src/lib/auth/session.ts` exposes
`getSession()` with two implementations behind one signature:

- **Supabase** — used when `NEXT_PUBLIC_SUPABASE_URL` and
  `NEXT_PUBLIC_SUPABASE_ANON_KEY` are set. Reads the verified Supabase session.
- **Demo** — the fallback. Returns a seeded user, selectable through the
  `lia_demo_user` cookie so role behaviour can be exercised with no database.

That split was designed before a provider existed, and it held: wiring one was a
change to `middleware.ts`, a sign-in route, and a sign-out action — `getSession()`
itself did not change, and neither did any call site.

```text
request
  └─ middleware.ts               ← refreshes the token, redirects if signed out
       └─ getSession()           ← the verified user, or null
            └─ getOrganizationContext()
                 └─ repositories ← queries run as that user; RLS applies
```

**Middleware does two things a page cannot.** A server component cannot set a
cookie, so a refreshed access token could not survive the request without it —
`createSupabaseServerClient` swallows the write for exactly that reason. And it
turns an unauthenticated request into a redirect rather than a 500.

It is **not** a security boundary. It runs on a browser-supplied cookie. The
enforcement is row-level security in Postgres, where `auth.uid()` comes from the
verified JWT — a forged cookie yields a session that can read nothing. Deleting
the middleware would make the app unpleasant, not insecure.

**`auth.users.id` must equal `public.users.id`.** Every policy resolves through
`auth.uid() = memberships.user_id`, and `memberships.user_id` references
`public.users.id`. An account created with a fresh id authenticates perfectly and
then sees nothing at all. `npm run auth:seed` creates the seeded logins with
their exact UUIDs for this reason.

**`/api/cron` is the one route family that bypasses this gate on purpose.**
`middleware.ts`'s `SESSIONLESS_PATHS` lists it explicitly, because Vercel Cron
invokes these routes with no browser session at all — gating them here would
redirect every scheduled invocation to `/sign-in` before the handler's own
check ever ran. Authorization is a shared secret (`CRON_SECRET`) instead,
checked inside each handler by `isAuthorizedCronRequest()` and compared with
`timingSafeEqual` against a fixed-length digest of both sides, so a partial
match cannot leak the secret's length through timing. It is the only path in
the app authenticated by a secret rather than by session or RLS.

### Sign-up and provisioning

A new account and a new organization are created together, and the ordering is
load-bearing:

```text
signUpAction
  └─ supabase.auth.signUp()          ← creates auth.users
       └─ trigger on_auth_user_created
            └─ public.users          ← the row every RLS policy resolves through
  └─ organizations.provision()       ← RPC: organization + owner membership
                                       + organization_onboarding, one transaction
  └─ redirect("/onboarding/organization")
```

**Provisioning now creates three rows, not two.** `provision_organization` was
extended in `20260808000100_organization_onboarding.sql` to insert the
`organization_onboarding` row in the same function body, so an organization can
never exist without somewhere to record its setup progress. A trigger was
considered and rejected: it would also fire for the seed and for the backfill,
both of which must land as `completed` rather than at step one.

**A new owner lands on `/onboarding/organization`, not `/overview`.** At that
moment the organization is a name and nothing else, and a dashboard of zeroes
teaches somebody the product is empty rather than that it is unconfigured. Full
detail in `docs/onboarding.md`.

**Email confirmation carries the organization name in signup metadata.**
`signUp` returns no session when confirmation is required, so there is no
`auth.uid()` for provisioning to act as. `lia_pending_organization` holds the
name until the link is clicked, and `provisionPendingOrganization()` reads it
back from `/auth/callback` and from `signInAction`. The key is a hint, never an
authorization: user metadata is writable by its own account, and provisioning
runs only for an account that belongs to **no** organization at all — so the
worst it can produce is the empty workspace the sign-up form already offers.

That same membership check is what keeps an invitee from ever getting an
organization of their own, whichever route they arrive through.

**Provisioning is a `SECURITY DEFINER` function, not a loosened policy.**
`public.organizations` has no INSERT policy and `memberships_insert_admins`
requires already being an admin, so a brand-new user satisfies neither. Relaxing
either would mean the ability to create an organization *for yourself* became
the ability to insert a membership row for anyone. The function takes the user
from `auth.uid()`, never from an argument, and writes the role `owner`
literally — so it cannot mint a membership of any other shape.

The two steps cannot be one, and step 1 cannot be rolled back from application
code. A crash between them leaves an account with no organization, which is
recoverable. The reverse order would leave an organization with no owner, which
is not recoverable by anyone.

**The profile trigger closes the invariant that used to be upheld by hand.**
`auth.users.id = public.users.id` was previously guaranteed only by
`npm run auth:seed`; any account created another way authenticated perfectly and
then saw nothing. It now holds by construction.

### First-run setup

Two guards, pointing in opposite directions, which is what keeps them from
looping:

```text
/onboarding/*  ── requireOnboardingStep(step) ──▶ completed org?  → /overview
                                                  step unreachable? → resume step

(app)/layout   ── redirectIfOnboarding() ───────▶ incomplete org, owner/admin?
                                                  → resume step, before the sidebar renders
```

A finished organization satisfies the first and is untouched by the second; an
unfinished one is the reverse.

Progress lives in `organization_onboarding`, one row per organization, primary
keyed on `organization_id`. `current_step` is **advisory** — the guard
recomputes the resume point from the per-outcome timestamps, so a stale or
tampered value cannot unlock a step whose prerequisites were never met. A
missing row is treated as *completed*, so a pre-existing organization is never
trapped in a wizard for a workspace it has been using for months; the migration
backfills every one that existed, and `supabase/seed.sql` carries rows for both
seeded tenants because the backfill runs before the seed loads.

`onboarding.manage` is owner-and-admin only — narrower than
`can_write_in_organization`, because finishing setup decides what everybody in
the organization sees on sign-in. The RLS policies on the table restate that
rather than trusting the application.

Step 2 (`/onboarding/connect-sources`) is a three-source screen: Google
Business Profile (the prerequisite, real OAuth, returns to step 2 and the
callback settles the source step for onboarding-originated grants), News &
Media (optional configuration written through the **existing**
monitoring-query service — `saveOnboardingNewsQuery` edits the wizard's own
query, identified by the persisted `monitoring_queries.origin` column with
the oldest org-wide brand query as the pre-column fallback), and Reddit.
After step 3 maps or creates locations, `ensureOnboardingLocationQueries`
creates at most one `origin = 'onboarding'` location query per newly covered
location — only when an enabled onboarding brand query shows the person
opted into News monitoring, and never writing a row that already exists, so
retries are idempotent and user edits are never overwritten.

The News card asks for a **market and a local anchor**: a country from
`MONITORING_COUNTRIES` (`src/lib/geo/countries.ts` — the 30 codes GNews
accepts, so the picker cannot promise a filter the provider will ignore), plus
an optional postal code that auto-fills a city and region. Country is the only
one of these a poll uses today; `monitoring_queries.postal_code`,
`locality_city`, and `locality_region` are stored and read by nothing, waiting
on the provider upgrade that can search regionally (D71). They are captured now
because an organization-wide brand watch has no location row to derive a
neighbourhood from, and nobody will come back to a settings screen to add one
later. `ensureOnboardingLocationQueries` takes a location query's locality from
**that location's own persisted address**, not from the brand query, so head
office's postal code is never stamped on a restaurant three states away.

Auto-fill goes through `lookupPostalCodeAction` →
`src/lib/geo/postal-lookup.ts`, the single HTTP boundary to Zippopotam — free,
unauthenticated, adding no environment variable and no per-poll cost, and with
no SLA, which is why nothing depends on it: the city and region are ordinary
editable fields, a failed lookup says so and leaves them for the person, and a
country with no lookup coverage (Ireland, Hong Kong, Singapore) is still a
country the picker offers. `fetch` is injected exactly as `searchGNews` takes
it, so `tests/postal-lookup.test.ts` covers every provider failure without
touching the network. The shared behaviour — debounce, stale-response
suppression, clearing the locality when the country changes — lives in
`src/components/monitoring/use-postal-lookup.ts` and is used by both the
onboarding configurator and the News & Media query editor; the markup is not
shared, because the two screens are on different design systems.

**Reddit monitoring is not implemented.** `reddit` exists as platform-enum
vocabulary, seed/demo fixture data, and a presentation route
(`/reddit/[id]`); there is no Reddit connector, monitor, persistence, or
polling service, and `getConnector("reddit")` throws. The step-2 card
therefore renders *Available after setup* with a disabled control and no
counts — the interface reflects actual repository capability, and this
paragraph is the record of the gap. Building the ingestion provider is future
work (`docs/implementation-plan.md`, phase 5).

Full detail, including the quick-win hierarchy and what the flow deliberately
does not claim, is in `docs/onboarding.md`.

### Invitations

```text
/settings ── inviteMemberAction ──▶ token generated, SHA-256 stored
                                          │
                                          ▼
                            copyable link, shown once
                                          │
/invite/[token] ── invitation_preview ────┘
     ├─ signed out        → create account at the invited address, then join
     ├─ signed in, match  → one button
     └─ signed in, other  → sign out first
```

Only the SHA-256 hash reaches the database, exactly as `oauth_states` holds a
hash rather than a state value (D11). Two things make a copyable link safe to
send over any channel:

- the token is 32 random bytes, so it cannot be guessed; and
- **acceptance requires the signed-in account to own the invited address.**

The second is the load-bearing one. Without it a link pasted into the wrong chat
is a standing grant of whatever role it carries. It is enforced inside
`accept_invitation` rather than in the server action, because a check in
application code protects only the path that runs it.

Owner is not an invitable role. Ownership is transferred between people who
already share an organization, never granted through a link.

### Member management

| Guardrail | Where | Why |
| --- | --- | --- |
| You cannot change your own role or status | Server action | An admin demoting themselves loses the permission needed to undo it. The most common way anyone locks themselves out of an admin panel. |
| The last active owner cannot be demoted, suspended, or removed | Constraint trigger **and** both adapters | An organization with no owner has nobody who can promote anyone. Unrecoverable through the interface. |
| Only owners may create or unmake owners | Server action | `organization.manage_members` is held by owners and admins alike. Without this an admin could promote themselves, making the distinction decorative. |

The last-owner trigger is `DEFERRABLE INITIALLY DEFERRED`, so it runs at commit
rather than per row. Handing ownership over is legitimately two statements —
promote the new owner, demote the old — and a per-row check would reject
whichever order it was written in.

Suspension is the reversible option and the right one for somebody on leave: RLS
ignores any membership that is not `active`, so access stops immediately while
the record and its history stay intact. Removal deletes the membership, not the
account — audit rows reference `users`, so removing somebody never erases what
they did.

### Password recovery

```text
/forgot-password  ── requestPasswordResetAction ──▶ Supabase sends the email
                                                          │
/auth/callback  ◀── the emailed link ─────────────────────┘
     └─ establishes the session, redirects to `next`
          └─ /reset-password ── updatePasswordAction ──▶ /overview
```

The callback is a **route handler, not a page**, for the same reason refresh
lives in middleware: a server component cannot set a cookie, so the session
would be established and immediately lost.

It accepts two link shapes, because which one arrives is decided by how the
link was requested:

| Parameter | Produced by | Bound to the requesting browser |
| --- | --- | --- |
| `code` | `resetPasswordForEmail` — the `@supabase/ssr` client sends a PKCE challenge | Yes. Fails if the email is opened on another device. |
| `token_hash` + `type` | An admin-generated link, or the email template set to `{{ .TokenHash }}` | No. Works across devices. |

A third shape cannot be served at all: an implicit-flow link carries its tokens
in the URL **fragment**, which browsers never send to a server. A link landing
on the callback with neither parameter is that case, and the fix is the email
template rather than the handler.

**The seeded logins cannot use this flow.** Their addresses are `@example.com`
and receive nothing. `npm run auth:seed` is their recovery path — re-running it
resets every seeded password, which is why it is idempotent.

Requesting a reset reports success whether or not the address exists. "No
account with that email" is a free account-enumeration oracle on an endpoint
reachable without a session, so provider errors are logged and swallowed too.

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
- No model provider message reaches a user, a log, or a stored row. Stricter
  than the provider rule for Google, and for a specific reason: a model error
  can echo the prompt, and the prompt contains a review and a reviewer's name.
- An analysis writes only `sentiment`, `risk_level`, `relevance_score`, and a
  final status the database itself derives from the mention's current state —
  never a status the caller names. Source-owned columns are not reachable from
  `ApplyAnalysisOccurrenceInput` (the G1 occurrence-lifecycle successor to the
  now-deleted `MentionAnalysisOutcome`: see D160, D161), the mirror of the rule
  that keeps a sync out of Lia's workflow state.
- A synchronisation writes only source-owned fields. Lia's workflow state —
  status, sentiment, risk, assignment, drafts, approvals, escalations — is not
  reachable from `IngestMentionInput`, so an ingest cannot overwrite it even by
  accident. `SOURCE_OWNED_MENTION_FIELDS` is the single declaration of the line.
- Review text and reviewer names never appear in an audit event, a sync-run
  error message, a log line, or an API response.
- Composer edits persist through `saveFinalText`, but only while a draft is
  still `draft` or `awaiting_approval` — the same statuses `response.decide`
  already required, so text and decision leave the editable state together.
  `response.edit` (owner, admin, communications lead, approver) gates who may
  call it, and approving a dirty composer carries its text into the same
  write as the decision rather than a separate save. No event carries the
  text itself: `response.edited` records `finalTextLength` before and after,
  never the prose.
- Relative times in demo mode are measured against a fixed reference instant
  (`REFERENCE_NOW`) so server and client renders agree and fixtures stay stable.
- The relevance gate (`src/lib/monitoring/gate.ts`) never writes
  `mentions.relevance_score` (D83). That column belongs to the analysis layer,
  which supersedes any provisional value within minutes; the gate's own score
  is persisted only on rejections, where it is the thing being tuned.
- No news provider message reaches a user, a log, or a stored row — the same
  discipline the Anthropic client keeps, applied to GNews. `errorMessage` on a
  `news_poll_runs` row and the `console.error` calls in both cron routes are
  Lia-authored strings; the provider's own response body or a driver error is
  never interpolated into them.
- Cron carries its own tenancy discipline; row-level security is not its
  backstop there (D88). Both scheduled routes call `getServiceDataSource()` —
  a service-role client with no user session — and build an
  `OrganizationScope` from each row's own `organization_id`, never from
  anything ambient, since `getOrganizationContext()` has no request session to
  resolve.

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

## Decisions made in workflow 04

| # | Decision | Reason |
| --- | --- | --- |
| D32 | Analysis before drafting | Every imported review read as `risk_level: low`, so the guards that say high-risk content must always be escalated were inert. Shipping drafting first would have landed customer-facing text generation in the same pass as its own safety inputs. |
| D33 | Real Anthropic SDK plus a deterministic mock, chosen by env | The `GOOGLE_INTEGRATION_MODE` pattern, unchanged. Tests and local development run with no key; production refuses the mock at environment parse. |
| D34 | Brand voice stays a typed fixture | Analysis does not read it. Promoting it now would ship a table nothing queries; it becomes real in workflow 05, where it drives generation. **Superseded by D60.** |
| D35 | `AiProvider` has one method | Same reasoning as D9. There is one thing Lia asks a model to do today, and extension points for a second caller that does not exist would be guessing at its requirements. |
| D36 | One call per mention returning one combined analysis | `mention_analyses` is one row carrying all five results — the schema already said this. The fields are interdependent, so five calls would each re-read the review and still merge into one row. |
| D37 | Analysis is its own run, with a partial unique index as the lock | Mirrors `platform_sync_runs`. An application check is two statements with a race between them, and serverless means two requests are routinely two processes. |
| D38 | High and critical risk auto-create an open, unassigned escalation | Keeps the product spec's promise. Reversible by dismissal, and an unowned item in the escalations centre is exactly the "somebody must look at this" signal. |
| D39 | An analysis may not write source state | The mirror of D22. `MentionAnalysisOutcome` had fields for four columns and nothing else, so the guarantee was structural rather than a rule a call site must remember. **Superseded in shape, not in force, by D160/D161:** `MentionAnalysisOutcome` no longer exists; its successor, `ApplyAnalysisOccurrenceInput` (the parameter list of `apply_analysis_occurrence`), carries the same four columns and nothing else — no `content`, `rating`, `author_name`, `published_at`, or any `source_*` field. The guarantee is now structural in a second dimension too: the type has no `status` field and no `due_at` field, because the final mention status and the escalation's due date are no longer caller-supplied at all — the database derives the status from current state (D161) and `raise_escalation` is called with `due_at := null` from every entry point. An analysis cannot write source state, and, as of G1, it cannot dictate the workflow outcome either; both are absent from the type rather than merely unused by convention. |
| D40 | Rating-only reviews are analysed deterministically, with no model call | A rating with no text has nothing to classify. The saving is incidental — the real reason is that asking a model to explain a wordless review invites it to invent a reason, and an invented reason stored as an analysis would be quoted back by a later drafting workflow. |
| D41 | Reviewer display names are sent to the model | The user's explicit decision. Recorded because it sends personal data to a third party for a classification task that does not require it. |
| D42 | The `mention_analyses` insert is the per-item commit point | No transaction is available (D17). Ordering escalation → mention update → analysis insert means a crash costs a repeated call, never a silently un-analysed mention. Analysis-first would leave a record that looks analysed, never gets its risk level, and is never selected again. **Superseded by D160/D161.** This reasoning optimised an ordering of three independent writes because no transaction was available at the repository layer; the G1 occurrence lifecycle removes the choice instead. `record_analysis_occurrence` is now the sole commit point for the classification itself (insert-or-load on the event key), and `apply_analysis_occurrence` applies the escalation, the mention transition, and the completion stamp as one Postgres transaction — there is no longer an ordering of three separate writes to reason about, and no window in which an escalation exists without its mention transition or vice versa. `analyzeOne`'s doc comment in `src/lib/analysis/analyze.ts` states the replacement crash matrix in full. |
| D43 | `effort` left at the API default | Judging whether a mildly-worded review describes a safety incident is the call the guardrails rest on. Sweeping down needs labelled data, not a guess made before the feature has run. |
| D44 | Synchronous Messages API, not Batches | Batches are half the price and can take an hour. Wrong for a button somebody is waiting on; the right home for a future overnight run. |
| D45 | A run's first model call goes alone | The system prompt is cached, and no request can read an entry another is still writing. Firing the batch at once would pay full price for every mention. |

## Decisions made wiring authentication

| # | Decision | Reason |
| --- | --- | --- |
| D46 | `/sign-in` added outside the fixed route list | `CLAUDE.md` fixes the routes, and D16 refused an `/[organizationSlug]` prefix on that basis. This is a considered exception rather than drift: every route on that list is a product screen for a signed-in user, and all of them are unreachable without somewhere to sign in. It sits outside the `(app)` group, so it renders with no sidebar, switcher, or user menu — each of which needs the session it exists to establish. |
| D47 | Email and password, not Google OAuth | The seeded users have `@example.com` addresses, so under Google OAuth none of them could ever sign in and the seven-role matrix would be untestable. Email and password creates all seven with matching UUIDs. Everything built here is provider-agnostic, so adding Google later is a dashboard toggle plus a button. |
| D48 | Sign-in-with-Google stays separate from the Google Business Profile grant | Different lifetimes and different blast radius. The GBP grant is org-level standing authority over listings; sign-in is per-user identity. Sharing a credential would mean disconnecting Google logs everyone out, and reauthorizing a listing silently re-authenticates a person. |
| D49 | `next` is validated as a relative path, not against a closed route list | `ALLOWED_REDIRECT_PATHS` names three integration screens — reusing it would discard where somebody was going whenever they signed in from anywhere else. An open redirect requires reaching another origin, so rejecting anything that can express one is sufficient and does not over-restrict. |
| D50 | Sign-out is a form posting to a server action, not an `onClick` | It clears an httpOnly cookie, which only the server can do. It also works before hydration — being unable to sign out because a bundle is still loading is a bad failure for the one control somebody reaches for when they are worried. |
| D51 | Reset requests report success unconditionally | "No account with that email" is a free account-enumeration oracle, and the endpoint is reachable without a session. Provider errors are logged and swallowed for the same reason: a rate-limit message tells the caller the address was worth rate-limiting. |
| D52 | The callback accepts `token_hash` as well as `code` | Found by walking a real link rather than by reading the docs: an admin-generated link carries no PKCE verifier, so it arrives as a fragment or a token hash and the `code`-only handler rejected it as invalid. Supporting both also makes request-on-laptop, open-on-phone work, which PKCE alone cannot. |
| D53 | The password policy is length-only, and lives in `src/lib/auth/password.ts` | Composition rules reliably produce `Passw0rd!`. The module exists because a `"use server"` file can only export async functions, so the action cannot own the constant the form must state — two copies would drift into a form promising one rule while the server applied another. |

## Decisions made building sign-up and multi-user

| # | Decision | Reason |
| --- | --- | --- |
| D54 | Self-serve sign-up creates an organization; invitees join an existing one | Two separate paths because they are two different intentions. Sign-up asking for an organization name and invitation not asking is what stops somebody expecting to join a colleague from silently creating a second, empty group and wondering where their team went. |
| D55 | An invitation is a copyable link, not an email Lia sends | Supabase's built-in SMTP on a new project is rate-limited to a handful of messages an hour and may deliver only to project members. An email-only invitation would fail silently and look like a bug in Lia. The link is testable today and the delivery mechanism can be added without changing the model. |
| D56 | Acceptance matches the signed-in account against the invited address | This is what makes D55 safe. A copyable link with no identity check is a standing grant of whatever role it carries to anyone who ever sees it — a forwarded chat message, a screenshot, a shared inbox. Enforced in `accept_invitation` rather than the action, so it holds for every future caller. |
| D57 | Owner is not an invitable role | A link that mints an owner is the most valuable thing an attacker could intercept, and the gain is nil: ownership is handed over between people who already share an organization, where both parties are known. |
| D58 | Provisioning and acceptance are `SECURITY DEFINER` functions rather than relaxed policies | Both need to write rows the caller has no membership to authorise, and both need two rows to land together. A policy permissive enough to allow either would allow far more — inserting a membership for an arbitrary user. The functions read `auth.uid()` themselves, so a caller can only ever act as themselves. |
| D59 | Invitations use the wall clock in demo mode, unlike every other record | Found by a test. `expiresAt` is computed by the action from `Date.now()`, and the demo adapter checked it against the frozen `REFERENCE_NOW` — two different clocks. The seed instant recedes further into the past every day, so a demo invitation would never expire. Seeded rows keep the frozen clock; nothing about an invitation is seeded. |

## Decisions made building brand voice configuration

| # | Decision | Reason |
| --- | --- | --- |
| D60 | Brand voice becomes a table now, superseding D34 | The screen already claims to be configuration and discards every edit. D34 correctly refused schema with no reader, but the cost it was weighed against — a dead screen — turned out to be the larger one. Generation still does not ship here. |
| D61 | Organization-wide, one profile per organization | Matches the fixture, matches the screen, and keeps resolution trivial. A per-location override is a later `location_id` column and a resolution rule, neither of which this shape blocks. |
| D62 | Named `smallint` axis columns, not `jsonb` | D7 established that invalid states are rejected at the database boundary. The five axes are a fixed taxonomy, not user data, so a `check (between 0 and 100)` per column is available where `jsonb` would accept anything. A sixth axis becomes a migration — correct, because it also changes the summary logic and the future prompt. |
| D63 | `version` increments only on a real change | `response_drafts.brand_voice_version` has existed since the initial schema and is written null. Bumping per save makes a draft's provenance answerable. Bumping on a no-op save would invalidate the provenance of every existing draft because somebody clicked Save twice. |
| D64 | Absence of a row means defaults, not an error | Existing organizations were provisioned without one. A pure `DEFAULT_BRAND_VOICE` constant avoids both a backfill migration and a change to `provision_organization` — the first save inserts. |
| D65 | A new `brand_voice.update` permission, not a reused one | Reusing `response.decide` would conflate approving one response with setting the policy for all of them. Held by owner, admin, and communications lead, matching `automation_rule.toggle`: both change what the product says without a person in the loop, and the communications lead owns response policy. |
| D66 | The voice summary is derived, never stored | Its stated purpose is "so anyone can check them". A stored summary that disagrees with the sliders defeats it entirely, and drift is a matter of when. A pure function cannot drift. |
| D67 | Channel scope is read from connected integrations, read-only | `CLAUDE.md` requires platform capabilities stay explicit and forbids implying publishing where a source does not support it. An editable list lets somebody tick a platform Lia has no connector for, which is the exact implication the rule exists to prevent. |
| D68 | A phrase in both lists is rejected at the schema | It reaches generation as an unresolvable instruction. Cheaper to refuse at the boundary than to define a precedence rule nobody will remember. |
| D69 | "Preview responses" is removed rather than disabled | It cannot work — there is no generation — and a dead control on a screen about what Lia says is the same category of dishonesty D18 refused for capabilities. |

## Decisions made adding brand voice autosave

| # | Decision | Reason |
| --- | --- | --- |
| D70 | Autosave replaces explicit save; Save and Discard are removed | With changes persisting themselves there is nothing to discard, and a Save button that is never the thing that saves is a lie about how the screen works. The cost is audit volume, taken knowingly. |
| D71 | Save on interaction end, then 800 ms idle | A drag is one decision, not forty `onChange` events. Committing on release matches what the control means; the idle window coalesces a burst of separate edits into one request. |
| D72 | Exactly one request in flight; a change during a save is sent when it lands | This is the client half of the concurrent-save race recorded below. Autosave is precisely what would start triggering it regularly, so the client must not race itself. The lock is held across the drain loop rather than released between sends. |
| D73 | No automatic retry | Autosave surfaces validation failures — a phrase in both lists — as you type rather than on submit. Automatic retry would loop on them forever. Retry is a button. |
| D74 | The status rules live in a pure module, not in the hook | `vitest.config.mts` runs `environment: "node"` and the repo has no testing-library dependency. Testing a hook would mean adding jsdom and a dependency; extracting the rules tests what is worth testing without changing the project's test setup. |
| D75 | Nothing renders until the first save | Showing "Saved" on arrival claims something that never happened. |
| D76 | `pending` is removed from the controls' `disabled` | Left in, every autosave would freeze the form mid-edit — the quickest way to make the feature feel broken. Serialisation happens in the hook instead. |
| D77 | The status renders as the form's first row, not inside `PageHeader` | `PageHeader` is server-rendered by the page while the state lives in the client form — the same cross-component problem that put Save in a sticky bar originally. A context provider for one string is not worth the indirection. |

## Decisions made aligning `/brand-voice` with onboarding step 4

The two screens were already backed by one row — same repository, same
`brandVoiceFormSeed`, same `saveBrandVoice`, pinned by
`tests/brand-voice-onboarding-alignment.test.ts`. What had drifted was what they
*showed*.

| # | Decision | Reason |
| --- | --- | --- |
| D174 | The preview module moves to `src/lib/brand-voice/`, and both screens render it | It was pure and took an `UpdateBrandVoiceInput`; nothing about it was ever onboarding-specific. Filing it under the wizard is what let the settings screen ship a placeholder instead — the screen somebody returns to was strictly less capable than the one they saw once. |
| D175 | Response drafting having shipped does not make the deterministic preview redundant | The placeholder promised "a real mention answered in this voice… available once response drafting arrives", and drafting did arrive, which made the sentence false. Calling the model would still be wrong here: a real draft cannot follow a slider, costs a request per frame of a drag, and is blank exactly when `LIA_AI_MODE` is unset. A real draft is a better *sample* and a worse *control*. |
| D176 | The preview is rendered by `VoiceForm`, not passed in as a server `ReactNode` | It is derived entirely from live form state. `channels` stays a prop because it renders the organization's connected platforms, which is server data; the preview is not. |
| D177 | The conflict sentence and the phrase hint are shared constants, not restated copy | Both were places the two screens could word the same condition differently — and `/brand-voice` stated neither the matching rule nor the phrase caps, revealing the 20-phrase limit only by refusing a 21st chip. `describePreviewConflicts` and `PHRASE_LIMIT_HINT` make each a single fact. |
| D178 | The chrome is deliberately **not** shared | Onboarding sits outside the app shell on the public-site brand; `/brand-voice` is a product page inside it. Each renders its own markup, and the alignment test reads both component sources — what regressed here was never a return value, it was one screen importing something the other did not. |

## Decisions made in workflow 06

| # | Decision | Reason |
| --- | --- | --- |
| D78 | A separate `NewsMonitor` boundary, not a widened `PlatformConnector` | Eight of `PlatformConnector`'s ten methods have no meaning for a search API, and implementing them as throwers is the `if (platform === "google")` that D9 exists to prevent, relocated inside the interface. D35 set the precedent: `AiProvider` has one method because there is one thing to ask. So does this. |
| D79 | The provider key is Lia's, held in the environment, shared by every tenant | Lia buys the news plan and serves it; a restaurant group does not arrive with a GNews subscription. Nothing touches `platform_credentials`, `oauth_states`, or the AES vault. The consequence is that quota is a Lia-level resource, which is why D85 enforces it globally. |
| D80 | A `news_media` connection row is created implicitly on first query save | `mentions.platform_connection_id` is `not null`, so news mentions need a connection whether or not one means anything here. Creating it implicitly reuses the existing status and health machinery without inventing a connect flow for a credential the tenant does not hold. |
| D81 | `news_poll_runs` is a new table, not a reuse of `platform_sync_runs` | `platform_sync_runs.platform_profile_id` is `not null` and news has no profile. Making it nullable would weaken a guarantee every Google row currently relies on, to accommodate a source whose lock target (a monitoring query), counters, and failure modes are all different anyway. |
| D82 | Rejected candidates are stored, with reason and score | D26 justified `platform_sync_runs` because "a sync that failed silently looks exactly like a location with no new reviews". The same argument is sharper here: an article Lia rejected looks exactly like an article nobody wrote. "Why did you miss this story" is the first question asked of any monitoring product, and without this table the gate is unfalsifiable and therefore untunable. |
| D83 | The gate never writes `mentions.relevance_score` | D39 reserves that column for the analysis layer, which supersedes any provisional value within minutes anyway. The gate score is persisted only on rejections — where it is the thing being tuned — and as min/mean/max on the run. The invariant stays exactly as strict as it is today. |
| D84 | Incremental fetch by `publishedAfter`, the opposite of D23 | D23 refetches Google's full history because Google reorders on *edit*, so a cursor silently loses the review somebody changed their mind about. Articles are not edited into a different position, and a metered plan makes a full refetch cost real money for no correctness gain. The reasoning differs; the conclusion inverts. |
| D85 | The request budget is enforced globally, in the scheduler | D79 makes quota shared across tenants, which is new: Google's quota was per-connection, so a noisy customer could only hurt themselves. Here one organization with forty queries can exhaust the day for everyone. Enforced above the tenant loop, with headroom reserved for manual polls. |
| D86 | Syndication dedupe lives in the gate, not the provider | GNews offers no clustering. One wire story republished across forty local papers is the single largest noise source in news monitoring, so the gate normalises headlines and rejects a repeat seen within 72 hours. Deliberately provider-agnostic: it survives the Event Registry upgrade rather than being thrown away. |
| D87 | Two crons, not one chained call | A slow model batch must not be able to blow the poll window. Splitting them also finally gives `analyzeMentions()` the scheduler that workflow 04 built it to accept and never wired. |
| D88 | The poll service constructs its own `OrganizationScope` from the query row | This is the first write path in the codebase with no verified human behind it. `getOrganizationContext()` is unavailable to cron, so RLS is not the backstop it is everywhere else, and the tenancy discipline has to be explicit rather than ambient. |
| D89 | GNews free tier now, Event Registry later | The user's decision, taken with the trade-offs stated. Recorded because the free tier is licensed for development only and cannot be the state when Lia has a paying customer. See "The provider decision" in `docs/superpowers/specs/2026-08-04-news-monitoring-design.md`. |
| D90 | No response composer on the media detail screen | `CLAUDE.md` forbids implying publishing where the source does not support it. There is no path by which Lia posts to a newspaper, and a composer on that screen would be exactly the implication the rule prohibits. |

## Decisions made integrating the branches

Brand voice, news monitoring, and the marketing site were built in parallel
from a common ancestor and merged afterwards. Three of the thirteen file
conflicts were real disagreements rather than two features appending to the
same list; those are D91–D93. The rest were resolved by taking both sides.

| # | Decision | Reason |
| --- | --- | --- |
| D91 | `/` is the marketing home; the product starts at `/overview` | The route it replaced was a redirect, so nothing that existed lost a home. `CLAUDE.md` fixes the product route list and `/` was never on it. |
| D92 | The auth gate stays a product denylist, with `/api/cron` as an explicit carve-out | The marketing site requires the denylist: an allowlist bounces every unrecognised URL to `/sign-in`, so a mistyped marketing link or a dead search result met a login form instead of a 404. But `/api` is on the denylist, and news monitoring's cron routes live under it — merging the two as written would have redirected every scheduled invocation to `/sign-in` before its own `CRON_SECRET` check ran. The carve-out is matched by segment and checked first, so `/api/cronjobs` does not inherit the bypass. This is the failure mode the denylist's own comment predicted, and it is covered by tests in both directions because the symptom is silence: nothing errors, and the only sign is data that stops arriving. |
| D93 | The audit vocabulary gets a merge migration rather than an edit to the branch that broke it | `audit_events_known_event_type` is a closed check constraint, and Postgres cannot extend one — so every workflow redefines the whole list. That is safe on one line of history and wrong on three: news monitoring redefined it from a copy predating membership and brand voice, and filename order puts that redefinition last, silently dropping eight event types the application still emits. A new migration keeps each branch's own migration honest about what it knew, and puts the union somewhere a reader can see it was a merge artefact rather than a mistake anyone made alone. |
| D94 | `SEED_TABLE_COLUMNS` wins over the inline column lists | News monitoring pulled the seed generator's hand-written column lists into one module and added a test comparing them against the migrations in both directions — a response to hitting the same silent bug three times, where a column exists everywhere except the generator's list and simply never reaches `seed.sql`. Brand voice added a table to the old inline form. Folding it into the refactor puts the newest table under that test rather than outside it, which is the only version of this resolution that gets the benefit. |
| D95 | Rejection reasons split three ways rather than one added | Only the ambiguity case was mislabelled, but the fix for it also retires an implicit convention: "score 0 means nothing matched" was load-bearing and documented only in a comment. Three reasons for three operator actions costs one extra enum value and makes each return site say what it means. |

## Decisions made building rules and automation

Rule authoring, simulation, and honest activation now exist end to end.
Execution — a rule actually doing something to a mention — does not; it is
the Phase 2 design recorded below the decisions.

| # | Decision | Reason |
| --- | --- | --- |
| D138 | Active rules cannot be structurally edited; disable → edit → re-simulate → enable | An edit mid-flight would let a rule someone is relying on change meaning with nobody re-checking it still holds. The constraint keeps "what an active rule does" always backed by a simulation of that exact configuration, at the cost of one disable click. |
| D139 | `revision` doubles as optimistic-concurrency token and simulation-staleness marker | Activation requires `simulatedRevision === revision`. One counter instead of two: incrementing on every save both rejects a write against a stale copy and tells the authoring UI a simulation no longer reflects the saved rule, with no separate invalidation logic to keep in sync. |
| D140 | One capability registry (`src/lib/rules/capabilities.ts`) is the single activatability gate | Zod schema validity says a rule is well-formed, not that Lia can do what it says — `notify` parses fine and still cannot enable, because no connector delivers it. Routing every activation check through one registry means an action becomes activatable in exactly one place, never at a second inline check that could drift from it. |
| D141 | Strengthened `isAutoPublishSafe`: positive sentiment + low-only risk + routine review source + no approval/escalate conflict | Closes the `at_most medium` bug — a risk condition capped at medium still let medium-risk content through unattended, which the product spec's "high-risk content must always be escalated" promise cannot survive. All four legs must hold, and even a passing rule is not activatable yet: no connector implements automated publishing in Phase 1. |
| D142 | Archive, not delete: `archived_at` column, no DELETE policy on `automation_rules`, deliberately | A deleted rule's history — what it once did, what an escalation traces back to — would disappear with it. RLS enforces the same posture as `audit_events`: nothing short of a migration removes a row. Restore-from-archive has no UI yet (deferred), but the data supports it. |
| D143 | Seed truthfulness: no fabricated `lastRunAt`; drafts state why they are drafts; the three active seeded rules carry only executable actions and fresh simulations | The seed previously implied rules had run, had SLAs, and had capabilities that do not exist. Every seeded rule's `lastRunAt` is null because nothing executes in Phase 1, and the active rules are active honestly — actions the capability registry actually permits, simulated against their current revision — rather than staged to look busier than the product is. |
| D144 | JSON-aware audit diffs: `toJson` recurses; diff compares non-primitives structurally | The existing diff serialized any non-primitive as `String(value)`, so a conditions/actions edit recorded `"[object Object]"` in the audit trail — evidence something changed, useless for what. Recursing through arrays and objects gives a rule-update event a real before/after; existing callers diffing primitives only (status, role, text lengths) are unaffected. |
| D145 | `automation_rule.manage` vs `automation_rule.toggle` split | Authorship (create, edit, archive, simulate) and activation (enable/disable) are different questions even though the same roles hold both today. The split gives a future role that may draft rules but not switch them on somewhere to attach, without a later permission-matrix rework. |
| D146 | Simulation requires a saved rule; staleness tracked on `revision`, not a config hash | No simulate-before-first-save. Reusing the counter that already guards concurrent edits needs no extra state and matches "editing invalidates simulation" for free; the cost is one extra save click before a first simulation. Simulation itself is read-only — no AI call, no side effects — and its audit metadata carries counts only. |
| D147 | Phase 2 idempotency design: execution records keyed unique on (rule revision, mention) | A retry must not double-apply a rule, and an edited rule must re-apply rather than being silently treated as "already handled" — the composite unique key gives both for free via `on conflict do nothing`. The engine runs inside the existing analysis sweep, never from a page request, matching the no-verified-human-behind-it posture D88 established for analysis. |

## Decisions made building rule execution (G0)

The dry-run engine from `docs/superpowers/specs/2026-08-11-rules-execution-phase2-design.md`
now exists end to end: schema, transition matrix, demo-adapter execution
unit, the cron-integrated sweep loop, and rule-detail history. `apply`
against real data does not — the Supabase adapter deliberately throws on
`executeUnit` until the G1 RPC lands (see "Known gaps" below).

| # | Decision | Reason |
| --- | --- | --- |
| D148 | The idempotency key is `(automation_rule_id, rule_revision, mention_id, trigger_analysis_id, mode)`, with the analysis row standing for the trigger occurrence | `mention_analyses.id` is durable and append-only (F13 of the Phase 2 spec) — the row that authorized reconsidering a mention — so it, not a nullable `analysis_run_id`, is what the key holds. A reanalyzed mention gets a new analysis row and therefore a new key, so the same rule revision may legitimately execute again against fresh evidence, while the same occurrence can never apply twice. `mode` in the key separates a dry-run projection from an apply attempt of the same occurrence, so a stale projection can neither block nor satisfy a later apply. |
| D149 | The transition matrix is explicit and lives in one module (`src/lib/rules/transitions.ts`), replacing the earlier status-lattice idea, with `escalated` reserved to the `escalate` executor | `set_status` may never target `escalated` — it returns `blocked`/`escalation_reserved` from every source status — because only `decideEscalate` is permitted to produce that state, and only after validating eligibility against the current locked mention. Naming the permitted `(from, to, risk)` cells directly, instead of ranking statuses on a scale, makes every allowed transition explainable by inspection; the G1 execution RPC restates the same cells in SQL, and a parity test is expected to assert the two agree cell for cell. |
| D150 | Whole-unit rollback: any technical failure discards the unit's business writes and records a surviving `failed` row; a policy refusal (`blocked`, `no_op`) is an outcome, not an error, and can sit beside another action's success in the same unit (`partial`) | Treating a guardrail refusal as a thrown error would make a unit's failure indistinguishable from a rule doing exactly what it was configured to do. The demo adapter's single-threaded twin of the spec's transaction stages business writes against copies of the mention/escalation state and commits them only after every action in the unit finishes; a thrown error discards the copies — that discard *is* the rollback — and finalizes the row `failed`/`retryable` (or `/terminal` for a stale revision or an unparseable action), never partially mutating store state. |
| D151 | Dry-run rows carry their own typed status vocabulary (`would_apply`/`would_partial`/`would_block`/`would_no_op`/`would_fail_validation`), mode-paired structurally against apply's vocabulary, and a `mode='dry_run'` sweep writes zero business records and zero audit events — only its own `automation_sweeps` row and `mode='dry_run'` execution rows | A projection stored under the same status vocabulary as an applied action, or one that touched a mention, an escalation, a rule timestamp, or the audit trail, would be indistinguishable from something that actually happened to a person reading the history later — the data-layer version of the platform-capabilities honesty rule CLAUDE.md states for the UI. Both the domain schema (`automationRuleExecutionSchema`'s `superRefine`) and the database check constraint (`execs_status_by_mode`) refuse an apply status on a dry-run row and a would-status on an apply row, so the pairing cannot drift between TypeScript and Postgres. What dry run may write is deliberately that narrow — no mention write, no escalation, no `lastEvaluatedAt`/`lastMatchedAt`/`lastAppliedAt` update, no audit event of any kind — and is pinned by a table-by-table zero-mutation test that snapshots `mentions`, `escalations`, `automationRules`, and `auditEvents` before and after a dry-run sweep and asserts them byte-identical. |
| D152 | Dry-run projection recording is deliberately held to apply-mode fidelity: escalation dedupe checks for *any* open escalation on the mention (not only one this rule raised), projection state is carried per mention across its own actions, sweep counters are derived from the rows actually recorded rather than tallied separately, and replay exclusion is scoped by `sweepId` | A projection that dedupes, counts, or excludes differently than apply mode would misreport what apply would actually do, which defeats the purpose of a dry run. Threading projection state across one mention's own action list (rather than re-reading raw store state per action) is what lets a projected `escalate` correctly deflate a later projected `set_status` within the same mention's outcome list; scoping replay exclusion by `sweepId` keeps a rule re-evaluated in a later sweep from reading an earlier sweep's projection as already having run. Landed as Task 10's round-1 review fix (`progress.md`); the escalation-dedupe alignment is also the platform-consistent "any" reading tracked as parked question Q7 below. |
| D153 | `RULES_EXECUTION_MODE` and `RULES_EXECUTION_ORG_ALLOWLIST` fail closed | Absence of configuration must mean absence of the behavior, because execution changes what the product does to customer data with nobody in the loop. An unset mode resolves to `off`; an unrecognized mode value fails the startup Zod parse rather than defaulting to something that sounds safe, matching every other mode enum in the codebase; and an active mode with an empty allowlist runs no sweeps, stated plainly in the cron response (`allowlist_empty`) rather than reading as a clean day with nothing to do. |
| D154 | `lastRunAt` is replaced by three monotonic activity timestamps: `lastEvaluatedAt`, `lastMatchedAt`, `lastAppliedAt` | One boolean-shaped fact could not distinguish a rule evaluated every sweep and never matching from one that matches but whose every action is blocked, and an operator reading the rule detail page needs that distinction. All three are written only by apply-mode sweeps (dry run touches none of them) and advance only via `greatest()`, so a late-finishing older sweep can never move one backwards; the list and detail UI label the third one "Last applied." |
| D155 | The cron route folds a *returned-but-unsuccessful* analysis run into `degraded`, and treats "every attempted organization's analysis failed" and "every attempted execution sweep failed" as two independent triggers for `failed`/503 | `analyzeMentions` can return normally carrying an error code and nothing analyzed — a run that succeeds at returning while succeeding at nothing — so counting only thrown exceptions against status, the route's first reading, rendered a total outage indistinguishable from an organization with no backlog. `analysisRunsWithErrors`/`analysisRunsWithoutProgress` close that gap (closes F8). The 503 clause is a disjunction, not a conjunction — matching the spec's parenthetical — because requiring both halves to fail before paging would leave the execution half structurally unable to report systemic breakage on its own: a sweep is only attempted after its own organization's analysis already succeeded, so it can never independently satisfy an analysis-side conjunct. Accepted consequence for the runbook: while the allowlist holds a single organization, that organization's sweep throwing is the only attempted execution sweep, so it alone satisfies "every attempted sweep failed" and pages the whole invocation — honest paging for a single-tenant rollout, worth revisiting only if the allowlist grows before G2. |
| D156 | An authorable-but-unwired action executes to `blocked` with the outcome code `action_not_executable`, driven off `ACTION_CAPABILITIES` in both G0 and G1 | `notify` (and anything else D140's registry marks non-executable) parses as a valid action and can be authored, so a unit can legitimately be handed one. Treating it as silently done would report an effect nobody delivered; throwing would classify a configuration fact as a technical failure and burn a retry. `activationProblems` already stops such an action reaching an active rule, so the code is a backstop for the case where one arrives anyway — and it says exactly which case it is. The string is part of the outcome vocabulary the G1 RPC is parity-tested against: the SQL must emit `action_not_executable` for the same actions, and must derive "which actions" from the same capability registry rather than a hand-copied list that could drift from it. |
| D157 | The executor ignores `escalate`'s `assigneeUserId` by design; the field stays in the rule schema as V1 compatibility only | `ruleActionSchema`'s `escalate` variant carries `assigneeUserId`, but Phase 1 pins it to null for every authorable rule — the builder's `buildDefaultAction` writes null and exposes no editor for it, and every seeded and templated `escalate` action is null too. Meanwhile `createEscalationInputSchema` deliberately has no assignee field at all (an escalation raised without a human has no owner yet; an unassigned item *is* the "somebody must look at this" signal) — there is nowhere for the value to land, and inventing an assignment path would make the executor claim a routing capability the escalation model does not have. So the executor reads the action, drops the field, and records the escalation unassigned. Recorded rather than left implicit because a silent drop is exactly the kind of thing a G1 parity test would otherwise flag as a twin/RPC divergence: the RPC must drop it too. Revisit when escalations gain an assignee — at that point this becomes a real behaviour change, not a schema cleanup. |
| D158 | Escalation dedupe is open-only, globally: `escalations.create` (analysis path and rule execution alike) blocks a new escalation only while an *open* one exists on the mention, enforced by a partial unique index (at most one open escalation per mention); resolving Q7 after the G0 merge | Never-per-mention permanently capped a mention at one escalation for its lifetime, which breaks the product's "high-risk content must always be escalated" promise the first time content changes after a handled escalation (a review edited to add a legal threat could never resurface). Re-escalation is not a hair trigger: it requires a human to close the old escalation, a human to re-triage the mention off `escalated` (the matrix refuses escalate from `escalated` and permanently from `dismissed`), and a genuinely new analysis occurrence — rule execution's idempotency key already carries the occurrence (`trigger_analysis_id`), and the analysis path's crash-retry safety survives because a just-created escalation is open and therefore still blocks the retry. Applied to both paths at once so the platform keeps one escalation contract, with the invariant in the schema (partial unique index) rather than a read-then-check. Mention-level `dismissed` stays the sole permanent "never again" control; no resolved-versus-dismissed semantic exists at the escalation level. Lands as a G1 task: contract change + index migration, deliberate updates to G0's pinned `escalation_exists` tests, re-escalation coverage for both paths, and false-positive re-escalation recorded as an apply-phase watch item. **Landed.** Migrations `20260812000100`–`20260812000600` (below); the contract itself is `20260812000300_escalation_contract.sql` (D159). |

## Decisions made building rule execution (G1)

The internal-`apply` gate from `docs/superpowers/specs/2026-08-11-rules-execution-phase2-design.md`
now exists end to end against real Postgres: the shared escalation contract
and the occurrence lifecycle it depends on, the transactional execution RPC,
atomic sweep claiming, audit hardening, and the CI harness that keeps SQL and
TypeScript from drifting apart. Six migrations, `20260812000100` through
`20260812000600`. Nothing in this worktree turns `apply` on for any
organization — that is an operator action against `RULES_EXECUTION_MODE` and
`RULES_EXECUTION_ORG_ALLOWLIST`, gated by the runbook below.

| # | Decision | Reason |
| --- | --- | --- |
| D159 | The escalation contract (`raise_escalation`) is the sole creator of escalation rows, enforced by grant rather than by convention — `insert` on `escalations` is revoked from every role including `service_role`, and `raise_escalation` itself is granted to nobody, not even `service_role` — so the only path to a new escalation is calling `apply_analysis_occurrence` or `execute_automation_rule`, both `security definer`, which reach it as the function owner | A function only the owner can call cannot be invoked by an application role holding a stolen or misconfigured grant, which closes the class of bug a simple "only `service_role` may call this" grant does not: `service_role` itself is excluded, so even a compromised service-role credential cannot create an escalation except through one of the two audited transactional entry points. Inside the function, the contract is a ladder evaluated in a fixed, load-bearing order: occurrence identity is mandatory (`p_trigger_analysis_id` null raises `22004` — an escalation with no provenance cannot exist), provenance is validated *before* any replay lookup (the supplied occurrence must belong to the named mention and organization, or the call raises `23503` and returns nothing — never another mention's escalation id), and only then does the ladder check, in order: occurrence replay (this exact occurrence already has an escalation — return it, whatever the mention's current status, because a consumed occurrence reports history and never mutates state — the "dismissed-replay" case: a mention dismissed after its escalation was created still returns that escalation on replay rather than `mention_dismissed`), mention dismissed, an open escalation already exists, the mention is already `escalated` awaiting retriage, or create. The return contract is precise — `(escalation_id, created, reason)` with `reason` naming exactly which arm answered (`occurrence_replayed`, `mention_dismissed`, `escalation_exists`, `awaiting_retriage`, or `null` on creation) — so callers never have to infer intent from a null id alone. Creation and its audit event commit in the same statement sequence inside the one transaction, so no crash can produce an escalation with no trail. The fix-round ruling from Task 4 governs the replay case at the caller: `apply_analysis_occurrence` maps `occurrence_replayed` to *preserve the mention's current status*, never to `escalated` — a human decision made between recording and a replayed application (dismissing the mention, for instance) is never overwritten by a replay. |
| D160 | Occurrence identity is the logical analysis event `(organization_id, analysis_run_id, mention_id)`, enforced by a partial unique index (`mention_analyses_one_per_event`); "pending" (`outcome_applied_at is null`) is a separate lifecycle invariant enforced by its own partial unique index (`mention_analyses_one_pending`), explicitly **not** the idempotency key | Every pipeline recording happens inside a run, so the run id is the identity every recorder of the same event carries — collapsing recording onto that key is what makes `record_analysis_occurrence` idempotent under every arrival order, including a late recorder arriving after the event already completed (its unique-violation arm on `mention_analyses_one_per_event` returns the stored row with `created: false` and discards the late output). Pending is a different question — "does this mention have exactly one unfinished occurrence to recover" — and keeping it a separate index means a *second, distinct* event arriving while an older one is still pending is handed the older pending row (`created: false`) rather than either colliding with it or silently starting a second recovery target; the caller finishes the old event first. `analysis_run_id`'s foreign key was hardened from `on delete set null` to `on delete restrict`, because a null run id would fall outside the partial index and make identity evidence for that row unrecoverable — nothing deletes runs today, so the constraint converts "never happens" into "cannot happen." Stated plainly, the honest scope of the guarantee: the database guarantees exactly one durable occurrence row and exactly one applied outcome per logical event, under every arrival order and every crash point. It does **not** guarantee exactly one model call — two racing recorders can each pay for a classification before either inserts, and only one insert wins; that race is bounded only by the per-organization analysis-run lock (D37), a coarser mechanism than the occurrence contract, and the cost of losing it is one wasted classification, never a duplicate occurrence or a duplicate applied effect. |
| D161 | The final mention status is derived inside `apply_analysis_occurrence` from the mention's current state and the escalation ladder's result — never supplied by a caller — and a human decision made between recording and application is never overwritten | `escalation_id`/`created`/`reason` map to status as: `created` or `escalation_exists` → `escalated`; `awaiting_retriage` → preserve `escalated`; `mention_dismissed` → preserve `dismissed`; `occurrence_replayed` → preserve the mention's *current* status, whatever it now is. The non-escalating branch is the mirror: `new` → `analyzed`, every other current status preserved, because a status the mention already holds (human-set or previously automated) is a decision this occurrence has no authority to overturn. `occurrence_replayed` preserving current status rather than re-deriving `escalated` is the fix-round semantics from Task 4's ruling: the v5 plan's SQL sketch would have moved a dismissed mention back to `escalated` on a replay, contradicting the user's explicit instruction that "replay must never change the dismissed state" — the guarantee governs, and the shipped SQL matches the ruling, not the sketch. |
| D162 | The audit contract for execution: identifiers, outcomes, status, SQLSTATE, and counts only — never mention, review, or rule-configuration content — written exclusively by service-role/security-definer paths, with the RPCs writing their own events inside the same transaction as the effects they describe | `automation_rule.executed` and `automation_rule.execution_failed` metadata carries `originSweepId` (the sweep that first claimed the unit — preserved across retries because the claim insert's `on conflict do nothing` never updates it), `attemptSweepId` (the sweep making *this* call), `mentionId`, `analysisId`, outcome counts (`applied`/`blocked`/`noOp`), and on failure `errorCode` (this attempt's SQLSTATE) — the same metadata-key vocabulary on both branches so a reader does not need to know which branch produced a row to query it. No mention content, no rule name beyond what the escalation's own `summary` field already states for a human reading the escalation itself. This lands together with `audit_events_insert` being dropped and `insert` revoked from `authenticated` (spec §6, closes F3): actor-stamping alone (`actor_user_id = auth.uid()`) stops impersonation but not fabrication, so the only remaining writers are the service-role adapter method (`recordAuditEvent`, one change point per F16) and the security-definer functions (`raise_escalation`, `execute_automation_rule`) writing their own rows as the function owner, inside the transaction whose effects they describe — an audit row for an execution can never exist without the execution it describes, and vice versa. |
| D163 | `execute_automation_rule` executes only the stored rule revision — the caller names a unit (`rule_id`, `revision`, `mention_id`, `analysis_id`), never supplies action payloads — and validates the stored `actions` jsonb null-safely against all eight authorable action shapes before any business write | A caller-supplied payload would let a request define what a "rule" does at execution time, defeating the point of `revision`-gated activation (D138, D139): what runs is what was simulated and activated, looked up fresh from the row under `for share`, with a stale revision failing closed (`rule_changed`, terminal). Validation covers `generate_draft`, `auto_publish`, `require_approval`, `assign`, `escalate`, `notify`, `tag`, and `set_status` — the same eight `ruleActionSchema` recognizes — and is null-safe by construction: every case arm is wrapped in `coalesce(…, false)` so a missing or null field fails validation rather than evaluating to SQL `null`, which `bool_and` would silently discard from the aggregate and let slip through. A validation failure is `would_fail_validation` in dry run and terminal `failed`/`invalid_action` in apply, before any mutation. Once inside the apply loop, each action's raw decision (from `automation_set_status_decision`/`automation_escalate_decision`, or the escalation ladder's own `reason`) is mapped at the boundary into the pinned outcome vocabulary — `escalation_exists`/`occurrence_replayed` become `no_op`/`escalation_exists`; the matrix-unreachable `mention_dismissed`/`awaiting_retriage` arms map defensively to `blocked`/`forbidden_transition` — so SQL-internal reason strings never leak into the outcome rows the UI and the parity tests read. |
| D164 | Sweep claiming is one atomic decision inside `claim_automation_sweep`: the existing `running` row (if any) is locked `for update` first, so exactly one caller performs a stale-lease takeover and every other concurrent caller blocks on that lock, re-reads, and receives the winner's claim as an ordinary `claimed: false` outcome — never a race against the insert | An application-level "check then insert" would race exactly like every other unlocked check-then-write in this codebase (D24's reasoning restated for sweeps). Locking the running row first, rather than racing straight to the insert, means the 30-minute lease-expiry decision itself only ever happens once per stale row, by whichever caller won the lock — no second caller can also decide the lease is expired and insert a competing claim. The unique-violation absorption on the fallback insert path is diagnostics-verified rather than assumed: `get stacked diagnostics constraint_name` is checked against the literal `automation_sweeps_one_running`, and anything else re-raises, because a partial unique index has no entry in `pg_constraint` — the constraint-name string in the diagnostics is the only reliable identity available, and asserting it (rather than swallowing every `unique_violation`) keeps an unrelated future unique constraint on the same table from being silently absorbed here too. |
| D165 | CI is the parity gate: a `database` job runs the full `db:verify-execution` harness (RLS + execution-verification + the generated matrix-parity SQL + the concurrency race script) against a freshly started local Supabase instance on every PR and push to `master`, at a Supabase CLI version pinned to the exact combination the harness ran green on during Task 11 (`2.101.0`, Postgres 17.6) — not a combination verified "safe": that image's known segfault behavior is a fact the harness routes around, not one it clears | A TypeScript-only review of a matrix or RPC change cannot catch SQL that silently disagrees with `transitions.ts` or the demo adapter's twin; running the harness on every change is what makes that drift a merge blocker instead of a later production surprise. The CLI pin is not cosmetic: Task 11 found that this local Postgres image **segfaults** the whole cluster on an EXECUTE-denied call of a non-immutable function after `set role` — exactly the shape of an unauthorized PostgREST RPC call — while an *immutable* function under the same denial returns a clean `42501` (the ACL check happens during constant folding rather than in the executor, which is what narrows the trigger to non-immutable functions specifically). `db:verify-execution` is written around this, not fixed by it: the one place the spec calls for asserting "`service_role` cannot execute `raise_escalation` directly" is proven statically, from `pg_catalog.has_function_privilege`, rather than by attempting the denied call — because attempting it would take the harness's own database down mid-run. The pin exists to hold this avoidance strategy fixed against a known-quantity image, not to certify the image safe; bumping it requires a local `npm run db:verify-execution` run first precisely because a different image could change the segfault behavior in either direction — narrower (only a smaller set of calls crash it) or wider (more of the harness's own catalog-based workarounds stop being sufficient) — and nothing here would notice without that run. Marking the `database` job a required status check in branch protection was recorded as the runbook's owner action, not done by the task that wrote this row — CI enforces the check only once a human enables it as a merge gate. **Done, 2026-08-12.** It could not be done sooner for a reason the row did not anticipate: branch protection is unavailable on private repositories at this account tier, and the API answered `403 — Upgrade to GitHub Pro or make this repository public` rather than anything about the check itself. The repository was made public, and `master` is now protected: `verify` and `database` both required, `strict: true` (a branch must be current with `master` before merging, so a stale branch cannot pass on an old base), force-pushes and branch deletion blocked. `enforce_admins` is deliberately **false** — the owner keeps an override for the case where CI itself is broken rather than the code. Every merge to `master`, including documentation, now goes through a pull request; direct pushes are refused because a bare push has no passing checks attached. |
| D166 | A generation attempt is written by exactly three functions — `claim_generation_attempt`, `complete_generation_attempt`, `fail_generation_attempt` — which serialize on the **mention row**, hand the claimant a compare-and-set token, and commit the draft, the attempt, and the audit event as one transaction | `authenticated` holds no `insert`/`update`/`delete` on `generation_attempts` at all, so the trio is the whole write surface rather than the recommended path through it. The claim's first act is `select … from mentions where id = … for update`: two clicks on the same review cannot both reach the insert, because the second parks on that lock, re-reads after the first commits, and reports `in_progress` with its `dedup_hits` counted (proven by race 1 in `scripts/generation-race-test.sh`, which asserts session B is genuinely parked via `pg_stat_activity` rather than assuming it). `complete`/`fail` are compare-and-set on `(id, claim_token, status = 'pending')`, which is what makes a stale worker harmless: a hung claimant whose lease expired and whose review was taken over returns to find its completion refused as `superseded`, with the replacement attempt byte-identical afterwards (race 3 compares `to_jsonb(row)` either side). `complete` locks the mention up front too, matching the claim's order, because its `response_drafts` insert would otherwise take an implicit FK lock on the same row in the opposite order and deadlock a completing worker against a live lease. The lease sweep runs **before** the `draft_exists` short-circuit: ordering it the other way pinned an expired attempt at `pending` forever on any mention that had acquired a draft by some other path, since nothing ever reached the sweep again. `generation_attempts_one_pending` is a backstop behind the serialized claim, not the mechanism. |
| D167 | Every attempt records the exact input it was given — the frozen `DraftingContext`, its canonical hash, the prompt version, and hashes of the rendered system and user messages — and the drafting prompt is version-pinned by a test that hashes the template and the version together | Provenance that can be reconstructed is not provenance: the mention, the location, the organization, and the brand-voice profile can all change between a draft being written and somebody asking why it says what it says, so `buildDraftingContext` deep-copies what it read and the row stores that snapshot verbatim rather than the ids to re-read it from. `context_hash` is over a key-order-independent encoding, so two attempts with the same inputs are comparable regardless of how the JSON happened to serialize. The pin test hashes `DRAFTING_PROMPT_VERSION` *together with* the template constants, so editing the wording without bumping the version fails, and bumping the version without editing the wording fails too — the pair moves or neither does. `output_schema_version` is recorded separately from the prompt version because the structured-output schema and the prose can change independently. The gate between the model and the database (`validateDraftText`) is the reason a stored draft is worth this provenance at all: no URL, e-mail, phone number, Markdown, preamble, or second option reaches `complete`, and a refusal is recorded as `invalid_output` rather than saved and flagged. |
| D168 | `changes_requested` replaces `rejected` as the decision an approver emits; the `approval_status` enum keeps `rejected` for the rows that already carry it, and the composer says "Request changes" | The old label described the wrong thing. Sending a draft back does not end its life — it returns it to editable `draft` status for the writer — so "rejected" named a terminal outcome the code never produced. `decideResponseDraftInputSchema` now accepts `changes_requested` and **rejects** `rejected`, pinned in both directions, because a swap that merely adds the new value leaves the old emission path alive. The enum value stays: Postgres cannot remove one, and historical rows are history rather than a migration problem. The confirm dialog lost its `destructive` styling with the rename — red framing for "the writer gets it back" overstated what happens. |
| D169 | The retention *mechanism* ships without a retention *policy*: `redact_generation_snapshots(interval)` empties finished attempts' context snapshots to the JSON-null sentinel, and nothing calls it | The period is an operational decision that needs a person, and a migration inventing "30 days" would make that decision silently. What the mechanism guarantees is testable now and independent of the number eventually chosen: only finished attempts are touched, hashes and telemetry survive so a redacted row stays auditable, no audit event is written, and a second pass reports zero. The column stays `not null` and a redacted snapshot reads as jsonb `null` — distinguishable from any real context object, where "deleted the row" or "wrote `{}`" would not be. **Open operational item:** choosing the period and scheduling the call. Related deviation, recorded as deliberate: the spec called for `scripts/verify-generation-concurrency.ts` over a new `pg` dev dependency, and the shipped proof is `scripts/generation-race-test.sh` over FIFO-driven psql sessions instead — the G1 race harness already established that pattern, it adds no dependency, and driving the interleaving statement by statement is what makes the races reproducible rather than timing-dependent. |

## Decisions made adding brand-voice phrase matching

| # | Decision | Reason |
| --- | --- | --- |
| D170 | Both brand-voice phrase lists match as **phrases**, not as substrings: the customer's words in the order they typed them, with extra words permitted around *and* between them, bounded at two words per gap (`src/domain/entities/phrase-match.ts`) | The lists were matched with `haystack.includes(needle)`, which was wrong in both directions at once. It missed the case customers actually mean — "it made our day" did not cover "it really made our day", an insertion in the *middle*, which is also where this departs from the Google Ads phrase match it is modelled on (Google allows the extra words only at the ends) — and it matched across word boundaries, so avoiding "our day" also fired on "our dayboat scallops", a word nobody wrote. The gap is bounded rather than unlimited because an unbounded in-order match is not a phrase: "it made our day" would fire on "it was made clear our server had a bad day". Two covers the intensifiers and articles that get slipped in and stops short of drifting across a clause. Deliberately lexical — no stemming, no synonyms, no plural folding — because this is a rule a customer has to be able to predict from the words in front of them on a settings screen, and a cleverer matcher's misses cannot be explained to them. Matching is case- and punctuation-insensitive and folds the curly apostrophe to the straight one, so a phrase typed in a word processor and a reply generated elsewhere cannot miss each other over a character nobody can see. |
| D171 | The use/avoid contradiction is checked under phrase matching, extending D68 | D68 rejected a phrase that appeared in both lists as the same string. Under D170 that net is too narrow to keep the promise D68 was making: with "made our day" on the avoid list, an approved "it really made our day" is unusable, because every use of it breaks the other rule. It is the same unresolvable instruction D68 refused to send to generation, so it is refused at the same boundary. Identical spellings still collide, since a phrase always matches itself. The reverse direction is deliberately *not* an error — avoiding "it made our day" while approving the shorter "made our day" is satisfiable, so the schema does not invent a conflict the rules do not have. |
| D172 | `approvedPhrases` is mapped into the drafting context as `preferredPhrases`, closing a gap left by task 6 | Task 6 mapped `prohibitedPhrases` to `bannedPhrases` and left the approved list unmapped, so the two halves of one screen behaved differently: avoiding a phrase changed real replies, asking for one changed only the onboarding preview. A customer who fills in "use these phrases" and watches it do nothing has been given a control that is not connected. The prompt states it as *a vocabulary, not a checklist* and qualifies it with "where it fits naturally", because a bare list under a heading reads as something to exhaust — a reply welding all twenty phrases in would be both unnatural and a different thing from what the screen promised ("phrases Lia may include"), and forcing an invitation back into a reply to a serious complaint is how a voice setting becomes a liability. Both lists are operator-authored, so neither is wrapped as untrusted content the way the review body is; they sit at the same trust level and get the same treatment. Landed with a `DRAFTING_PROMPT_VERSION` bump and a re-recorded template hash, per D167's pin. |
| D173 | The phrase lists offer **suggestions**, which are never applied on their own | `DEFAULT_BRAND_VOICE` ships both lists empty on purpose — a default phrase puts words in a customer's mouth — and that stands: nothing in `SUGGESTED_APPROVED_PHRASES` or `SUGGESTED_PROHIBITED_PHRASES` reaches a saved profile, a prompt, or a reply unless somebody pressed it. What they fix is a different problem: an empty box with a placeholder does not show what a *useful* entry looks like, and the entries that make this feature work are longer and more specific than what people type unprompted. A suggestion is withheld once it is on the list, once an existing phrase already covers it under D170, or once it appears on the opposite list, where pressing it could only produce D171's error. |

## Known gaps after workflow 04

Carried over from workflow 01:

- ~~Migrations have never been executed.~~ **Resolved.** All eight are applied to
  a hosted Supabase project via `supabase db push`, the seed is loaded, and the
  RLS policies are verified against live Postgres — including a harness
  self-test confirming the checks can actually fail. Running them surfaced a
  seed-generator bug that four workflows of parse-validation had missed.
- The Supabase adapter is now partly exercised: reads through the inbox,
  overview, and mention detail run against real Postgres under RLS. The write
  paths — sync ingest, analysis, escalation creation — have still only run
  against the demo adapter.
- ~~Brand voice has no table; the screen still reads a typed fixture.~~
  **Resolved.** `brand_voice_profiles` ships with RLS, both adapters, and an
  audited action. ~~Nothing generates text from it yet.~~ **Also resolved:**
  response generation reads the profile into a frozen drafting context and a
  drafted reply records which voice produced it (D166–D167). A tenant with no
  saved profile drafts from `DEFAULT_BRAND_VOICE`, recorded honestly as
  `brand_voice_source: "default"` rather than as a configured voice.
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

New in workflow 04:

- **The Anthropic API has never been called from this repository.** Same
  position workflow 02 was in with Google: every test stubs the provider, and
  the client is covered against a stubbed `fetch` rather than a live request.
- **Prompt quality is unvalidated.** There is no labelled dataset, so the first
  version's risk classification is untested against ground truth. The
  `prompt_version` column and the append-only analyses table exist so a later
  version can be compared against this one.
- `effort` is left at the API default and unswept (D43). Deliberate — the sweep
  needs real data.
- ~~No scheduler.~~ **Resolved in workflow 06.** `analyzeMentions()` accepts
  `trigger: "scheduled"`, and `/api/cron/analyze-mentions` now calls it on a
  timer: `vercel.ts` schedules it hourly at :30, half an hour after the news
  poll sweep at :00 so it picks up what that sweep just ingested rather than
  racing it (D87). Google review sync still has no scheduler — see workflow
  03's gap of the same name — so only news polling and analysis are wired to
  cron so far.
- Cost is bounded per run, not per day. Adequate while the trigger is manual
  for Google reviews; news polling is now bounded per day instead (D85).
- Auto-escalation is a machine decision: a false critical creates an escalation
  somebody must dismiss.
- Analysis is per organization, not per location — there is no way to analyse
  one restaurant's backlog only.
- No re-analysis surface. The table supports it (append-only, readers take the
  latest) but nothing in the product triggers it.
- ~~Brand voice still has no table. It arrives in workflow 05, where it first
  drives generation.~~ **Resolved.** See "New in brand voice configuration"
  below.

New in brand voice configuration:

- **Nothing reads the table.** Response generation does not exist, so the
  settings change no output. This was D34's objection, accepted deliberately:
  the alternative was leaving a screen whose controls discarded every edit.
- **The Supabase write path has only run against the demo adapter**, the same
  position the sync and analysis writes are in.
- **A concurrent save can lose an edit.** `save` is read-then-write with no
  transaction available (D17), so two simultaneous saves can both read version
  *n* and both write *n+1*. The unique constraint still guarantees one row.
  Acceptable for a screen edited rarely by a handful of people; a serialising
  fix needs a stored procedure.
- **The axis taxonomy is unvalidated.** Five paired sliders are inherited from
  the fixture and the reference screens. Whether they are the right five is
  unanswerable until a prompt consumes them.
- ~~`response_drafts.brand_voice_version` is still written null. Stamping it is
  drafting's job.~~ **Resolved.** `complete_generation_attempt` copies the
  version off the attempt that produced the draft, so a generated reply names
  the voice it was written in. Drafts created by a person still carry null —
  there is no voice version to name.
- **The screen's interactive behaviour has not been exercised in a browser.**
  Slider dragging, the autosave settling window, the status transitions, the
  retry path, Enter-adds-a-phrase, and the end-to-end save round trip are
  covered by the status-machine tests, the service and repository tests, and
  code review — but no browser has driven them. Server-side rendering was
  verified against a demo-mode dev server for both roles: an editor gets five
  sliders and the status live region; a role without the permission gets the
  notice, every control disabled, and no status region.
- **Autosave multiplies audit events and version bumps.** Every save that
  changes something writes a `brand_voice.updated` event and increments
  `version`, and changes now save themselves. One tuning session that used to
  be a single Save press is several requests, so it leaves several audit rows
  and advances `version` by several. Accepted deliberately (D70): the client
  coalesces — a slider saves on release, then an 800 ms idle window batches a
  burst — but the volume is still higher than an explicit Save produced.
  Merging the events server-side is not available: `audit_events` grants no
  UPDATE or DELETE, by design.
- **The profile `name` is stored but unreachable.** `brand_voice_profiles.name`
  is `not null`, is persisted by both adapters, and is one of the fields the
  audit diff tracks — but no control on the screen edits it and nothing in the
  interface renders it. A new organization is stamped with the default
  `"Brand voice"` permanently, and the seeded `"Union Square Hospitality
  voice"` is never shown. In practice `name` can therefore never appear in a
  `brand_voice.updated` audit diff. It is either a field the screen should
  surface or a column that should not exist; the question is open, and it
  should be settled when response generation gives the name a consumer.
- **The audit diff can record an empty change for a phrase edit.**
  `auditShape` in `src/lib/brand-voice/save.ts` joins each phrase list with
  `", "` before diffing. A change that only re-splits the same joined text —
  turning the single phrase `"a, b"` into the two phrases `"a"` and `"b"` —
  produces an identical joined string, so the version bumps while the
  recorded diff is empty. The stored voice is correct; only the audit entry
  is uninformative. A separator that cannot occur inside a phrase would fix
  it.

New in workflow 06:

Two things the design spec predicted as gaps turned out not to be, once
implementation reached them. Recorded here as corrections, not gaps:

- **Rejection retention has a sweeper.** The spec predicted none —
  "`news_rejected_candidates` has a 30-day retention policy but no sweeper job
  until one exists to hang it on." One exists: `pollMonitoringQuery` purges
  rows older than `REJECTION_RETENTION_MS` (30 days) on every run it makes,
  best-effort, so a purge failure never turns an otherwise-successful poll
  into a failed one. This is working, not a gap.
- **Two structural tests now pin code against the database**, not asked for by
  the design spec: `tests/audit-vocabulary-migrations.test.ts` and
  `tests/seed-generator-columns.test.ts`. Both parse the real SQL migrations
  with `libpg-query` — not a hardcoded list or a regex — and fail in both
  directions: a TypeScript enum value with no matching database constraint, or
  a constraint value nothing in TypeScript names. They exist because this
  workflow hit the same class of drift three times (Tasks 10, 11, and 13) with
  nothing catching it until a human noticed.

Three judgement calls the relevance gate makes, recorded in
`src/lib/monitoring/gate.ts`'s own comments and repeated here because a gate
that silently misses stories needs its blind spots to be discoverable from
outside the source:

- **Headline length is a weak proxy for ambiguity.** A term with no internal
  space at or under 8 characters is treated as ambiguous and, matched alone,
  requires corroboration (see below). That threshold catches "Bond" exactly as
  readily as it catches legitimate one-word restaurant brands — Nobu, Odo,
  Zuma, Semma, Estela, Carbone — so any of those needs a second keyword or an
  `allowedDomains` entry to be admitted on the strength of its own name alone.
  Acceptable as a v1 position only because every such rejection is logged with
  its reason (D82) and is therefore discoverable and tunable.
- **A description-only match never clears the default relevance threshold on
  its own.** A description match alone scores 0.2 against a default threshold
  of 0.35, so a piece that names the restaurant only in its summary — headlined
  on the chef instead — is dropped by a plain brand query.
  `MONITORING_QUERY_TYPES` includes `person` precisely so a named chef can be
  tracked directly rather than relying on a restaurant query's description-only
  signal.
- **Exact-match syndication detection misses re-headlined pickups.**
  `normaliseHeadline` catches only byte-identical wire copy once casing,
  punctuation, and whitespace are normalised; a locally rewritten headline
  covering the same wire story slips through as independent coverage. The
  inverse risk is real too: two genuinely different stories that happen to
  share a generic headline ("X opens new location") within the 72-hour window
  collapse into one — a live risk for the multi-location groups that are the
  target customer, not a hypothetical.

**The ambiguity rule changed during review, from what the design spec
described.** The spec described it as a scoring penalty. A CRITICAL finding in
Task 9's review showed the penalty was defeated whenever the ambiguous keyword
also appeared in the description — the normal case — because the
description-match bonus nearly cancelled the ambiguity penalty regardless of
whether the second occurrence was the *same* term or a genuinely distinct one.
It shipped instead as a hard corroboration requirement: a lone ambiguous term,
matched once in any field or repeated across fields, is rejected outright
unless corroborated by a second, distinct matched keyword or by the publisher
appearing in the query's `allowedDomains` list. Repeated occurrences of the
same term do not count as corroboration — that was the exact defect being
closed. Consequence, stated plainly: **a restaurant with a short, one-word
name needs one of those two signals — a second keyword, or an allow-listed
local publisher — before Lia will surface anything about it at all.**

The rest are gaps, largely as the design spec predicted:

- **The GNews API has never been called live.** The same position workflows
  02, 03, and 04 shipped in for Google and Anthropic. Every test stubs the
  provider; the client is covered against a stubbed `fetch`.
- **The Supabase adapter's news write paths have never run against a real
  database.** Poll ingest, rejected-candidate recording, and both cron routes
  are exercised only by the demo adapter and by static reading — mirroring the
  same gap already recorded for sync ingest, analysis, and escalation creation
  under "Carried over from workflow 01."
- **Gate thresholds are unvalidated** against labelled data, exactly as prompt
  quality is per D43. The rejections table exists so a later threshold can be
  compared against this one.
- **The free tier is licensed for development only.** Must be resolved before
  commercial use.
- News is up to 12 hours behind, and the analysis layer sees headline and
  description rather than the article.
- A poll returning more than 10 matches truncates; no paging is available.
- An article naming two restaurants attributes to one. `monitoring_query_id`
  is set on insert and never overwritten on conflict — first finder wins.
- No notification beyond escalation. A critical story found at 3am waits for
  somebody to open the escalations centre.
- **No test renders any of the new UI** — the media detail screen or
  `/integrations/news-media`, in any state. Everything beyond the capability
  strings covered by unit tests is verified by reading only.
- **`requestsSpentSince` builds a service-role client regardless of the data
  source it was constructed from**, so a user-facing page render
  (`news-media/page.tsx`) performs an unscoped cross-tenant read and depends
  on `SUPABASE_SERVICE_ROLE_KEY` being set. The payload is a coarse global
  integer that D85 arguably intends, but the mechanism is an ambient
  privilege escalation inside a repository method, and the same escape hatch
  makes `listDue` callable from any request path. Fixing it properly means
  deciding how the repository layer expresses privilege — a design decision,
  not a fix-wave edit.
- **Manual polls bypass the shared budget entirely.** `MANUAL_RESERVE` is
  subtracted from the scheduler's allowance but never enforced as a ceiling
  on manual polling, so repeated "Poll now" clicks in one tenant can exhaust
  the shared daily quota for all tenants.

One item deferred during implementation is worth keeping at this level, as a
deliberate choice someone could otherwise "fix" by mistake:

- `resolveNewsMode()` requires **both** `LIA_NEWS_MODE=live` and
  `GNEWS_API_KEY`, where the Google and Anthropic equivalents infer live mode
  from credential presence alone. Deliberate, not an inconsistency: for a
  metered provider on a shared daily budget (D85), a key appearing in the
  environment should not by itself start a cron spending quota.

**Correction:** an earlier version of this section recorded the
`monitoringQueries` cross-tenant `locationId` gap as "Pre-existing, both
adapters." That was wrong — `monitoringQueries` is introduced by this
branch, not carried over from an earlier one — and the gap itself has since
been closed: `createMonitoringQueryAction` and `updateMonitoringQueryAction`
(`src/app/actions/monitoring.ts`) now resolve a caller-supplied `locationId`
through `locations.get(context.scope, locationId)` before trusting it, the
same pattern `updateLocationManagerAction` already used, with a cross-tenant
rejection pinned by `tests/monitoring-actions.test.ts`.

A handful of smaller implementation nits — an unpinned `sourceCountry`
validation, duplicated `rows()`/`fail()` adapter helpers, a missing `.limit()`
on `listDue`'s underlying query, and two UI regressions in the monitoring-query
editor (a lost two-column grid; an inline edit form inside an unconstrained
`DataTable` cell) — are tracked in `progress.md` rather than repeated here;
they sit an abstraction level below what an architecture scan needs.

Two defects found and fixed while adding the monitoring locality, both worth
recording because neither was visible from the UI:

- `QueryEditor` sent the literal `sourceCountry: "us"` on create and omitted
  the field entirely on update, so every query created from the News & Media
  screen watched the United States and no edit could change it. The country is
  now a real field on both paths.
- `updateMonitoringQueryInputSchema` derives from the create schema, and Zod's
  `.partial()` makes a key optional **without** stripping its `.default()` — an
  absent key still parses to the default. With `.default(null)` on the three
  locality columns, any patch that did not mention them (a rename, a toggle)
  would have arrived at the repository carrying explicit nulls, and both
  adapters would have written them. The update schema now re-takes those three
  fields from `monitoringQuerySchema`, where they have no default, so
  `undefined` means "not mentioned" again. Pinned by
  `tests/monitoring-repositories.test.ts`.

New after integrating the branches:

- The marketing site, help requests, and early access shipped without ever
  reaching this document; their routes and directories are recorded above as
  of this merge. Whatever caused them to be missed is a process gap, not a
  code one — the branch that added them updated no architecture doc at all.

New building rule execution (G0):

- **G0 ships dry run only.** `set_status` and `escalate` are the only
  executors, `RULES_EXECUTION_MODE=apply` is untested end to end against
  real data, and nothing in this branch enables it for any organization.
  The spec's release gates (§3) govern when `apply` may be turned on: G1 is
  internal-organization-only via allowlist, and G2 is the earliest point
  customer `apply` is permitted, contingent on the transactionality work
  below.
- **The Supabase adapter's `executeUnit` deliberately throws
  `DataError("unavailable")`.** There is no execution RPC yet — only the
  demo adapter implements the claim/replay/retry/rollback algorithm
  described in spec §7 — so no request path, cron or otherwise, can apply
  an effect against a real Postgres row before the RPC exists. The demo
  adapter's algorithm is the G1 RPC's specification, not yet its proof: the
  transaction shape is verified only by the TypeScript twin's tests, never
  by the PostgreSQL harness the spec designates as authoritative (§11
  DB-1…DB-10).
- **The audit vocabulary migration and audit hardening (spec §6) are G1
  work, not landed here.** `automation_rule.executed`,
  `automation_rule.execution_failed`, and `automation_sweep.completed`
  do not exist in `audit_events_known_event_type` yet — nothing in G0
  writes an audit event for execution at all, dry run by design (§8) and
  apply because it cannot run. Removing authenticated audit inserts
  (`audit_events_insert` policy, `revoke insert … from authenticated`) is
  also deferred to G1, timed to land in the same migration as the adapter
  change per F16.
- **Q7, open-vs-any escalation dedupe: resolved — open-only, globally
  (D158).** Decided after the G0 merge, before any G1 SQL exists. G0's
  shipped any-escalation dedupe (shared by the analysis path and pinned by
  D152's dry-run fidelity) is now the known interim behavior; the G1
  escalation task replaces it in `escalations.create` for both paths, adds
  the partial unique index, updates the pinned `escalation_exists` tests
  deliberately, and adds re-escalation coverage for both paths. See D158
  for the decision and its safeguards.
- **P0-2, the reset-verification gate, passed.** `supabase db reset`
  applied all 34 migrations — including this branch's three
  (`20260811000100_tenant_integrity_prereqs`,
  `20260811000200_automation_execution`,
  `20260811000300_automation_execution_rls`) — cleanly against the local
  Docker stack, and `npm run db:verify-rls` then ran the full
  `supabase/tests/rls-verification.sql` harness against that reset
  database with 37 checks passing and zero failures. Both commands ran
  against the local stack only (`SUPABASE_DB_URL` pointed at
  `127.0.0.1:54322`); the hosted project received nothing. This is the
  first time `db:verify-rls` has completed — see the "Still open" entry
  below, now resolved.

New building rule execution (G1):

- **G1 landed.** The transactional execution RPC (`execute_automation_rule`),
  the shared escalation contract and occurrence lifecycle
  (`record_analysis_occurrence`/`apply_analysis_occurrence`/`raise_escalation`),
  atomic sweep claiming (`claim_automation_sweep`), the transition matrix
  restated in SQL, audit hardening (no authenticated `audit_events` inserts),
  and the CI database harness all exist against real Postgres, verified by
  `npm run db:verify-execution` locally (37 RLS checks + the execution
  harness + generated matrix parity + the concurrency race script) and by the
  `database` job in `.github/workflows/verify.yml` on every PR. See D159–D165.
  `RULES_EXECUTION_MODE=apply` is still off everywhere it is not explicitly
  turned on by an operator — nothing in this worktree enables it for any
  organization. ~~The hosted project has received none of these six
  migrations.~~ **All six were pushed to hosted on 2026-08-12**; the schema
  being present changes nothing about the flag, which is still off
  everywhere. The Internal-apply runbook below governs turning it on for the
  founder/test organization only (G1's own scope, per the spec's release
  gates).
- **Response generation landed.** Lia now writes a first reply for a Google
  review on request: a frozen drafting context built from the mention, the
  location, the organization, and the brand-voice profile; a version-pinned
  prompt; a hard output gate between the model and the database; and the
  claim/complete/fail lifecycle that makes a second click cost nothing and a
  stale worker's late result harmless. Verified against real Postgres by
  `npm run db:verify-generation` (85 harness checks + three FIFO-driven
  concurrency races), which the `database` CI job runs alongside the execution
  harness. See D166–D169. Generation is manual only — nothing schedules it,
  no rule action triggers it, and every draft it produces enters the same
  approval flow a person's draft does. Its four migrations were pushed to
  hosted on 2026-08-12, before this branch merged, and the live schema was
  probed to confirm the privilege boundary survived the push — see the
  runbook's step 2.
- **The local-image segfault finding (Task 11) is an operational fact, not
  merely a test-harness workaround.** An EXECUTE-denied call of a
  non-immutable function after `set role` — the exact shape of an
  unauthorized PostgREST RPC call reaching, say, `raise_escalation` or
  `organizations_with_unanalyzed_mentions` — crashes the whole local Postgres
  cluster (`SIGSEGV`, into crash recovery) rather than returning a `403`.
  This has been reproduced against the local Supabase image
  (PostgreSQL 17.6, aarch64) only. **Hosted behavior on this same class of
  call is unverified** — nobody has probed it, because nothing has pushed
  these migrations to the hosted project yet. The runbook below makes
  confirming the hosted build returns `403`/`42501` (not a crash) a
  pre-push gate, not an assumption.
- **Two items are explicitly G2, not G1, and neither is started here:**
  - The inert cross-tenant uuid disclosure in `record_analysis_occurrence`'s
    pending arm (Task 11 Finding 2): if organization A records against
    organization B's `mention_id` and that mention already holds a pending
    occurrence, the `mention_analyses_one_pending` unique-violation arm
    returns B's occurrence id to A instead of the `23503` the composite FK
    would otherwise raise. Nothing is written and no analysis content comes
    back — only a uuid, unusable without a coherent mention id to pair it
    with, and every real caller supplies coherent ids — but it is a real
    ordering property of two constraints firing in sequence, adjudicated as
    accept-and-document for G1 (Task 11's ledger entry). An explicit tenant
    check in that arm is batched with G2's other execution-path work rather
    than fixed in isolation.
  - The spec's G2 gate itself: per-path transactional RPCs for every
    overlapping human/automated mutation path the F17 inventory names
    (response actions, `updateMentionStatusAction`,
    `updateEscalationStatusAction`, `assignEscalationAction`), and
    location-aware write policies making location authorization a database
    guarantee rather than only an application check. Customer-facing
    `apply` (G2) does not begin until both land; G1's RPC and escalation
    contract are internal-organization-only by design, not a subset of G2
    already done.
- **The `analyze.ts` crash-window comment history is superseded by the
  occurrence lifecycle, not merely extended.** D42's "escalation → mention
  update → analysis insert" ordering — the best available answer with no
  transaction at the repository layer — described real production code
  through G0. `analyzeOne`'s doc comment in `src/lib/analysis/analyze.ts`
  now states outright that it "replaces the old write-order reasoning
  entirely," and does: `record_analysis_occurrence` is the sole commit point
  for a classification, and `apply_analysis_occurrence` applies the
  escalation, the mention transition, and the completion stamp as one
  Postgres transaction, so there is no longer an ordering of three
  independent writes to reason about. D42 is marked superseded in place
  (above) rather than deleted, so the historical reasoning stays legible to
  a reader working from an older commit.

## Internal-apply runbook (G1)

> **Resolved 2026-08-12 — hosted is current.** Every migration this note
> worries about is on the hosted project (verified via
> `supabase migration list --linked`: local and remote aligned through
> `20260813000300`, schema pushed ahead of the deploy). The ordering
> warning below is kept for the record and for the next branch that ships
> migrations the deployed code depends on; it no longer describes a live
> risk for this set.
>
> **Deploy-vs-migration-push ordering — read this before merging or
> deploying this branch.** This branch's application code unconditionally
> calls `record_analysis_occurrence` and `apply_analysis_occurrence` on
> every scheduled analysis (`analyzeOne` in `src/lib/analysis/analyze.ts`
> has no fallback for a hosted database that predates them) and reads
> `mention_analyses.outcome_applied_at`, a column those migrations add.
> None of the six migrations below has reached the hosted project yet.
> **Merging and deploying this branch before `supabase db push` runs breaks
> every scheduled analysis, for every organization** — not just the
> founder/test organization this runbook otherwise scopes `apply` to — the
> moment the deployed code makes its first cron call against RPCs and a
> column that do not exist on hosted. The failure is loud and non-
> destructive, never silent or corrupting: the call fails before writing
> anything, every attempted organization's analysis fails, and
> `/api/cron/analyze-mentions` answers `503` until the push happens — no
> partial writes, no mixed-schema state. The fix is ordering, not code:
> **the six migrations must be pushed to the hosted project immediately
> before, or at the moment of, deploying this branch — never after.** This
> is a merge-time coordination requirement between whoever merges/deploys
> and whoever holds hosted `supabase db push` access; nothing in CI
> enforces it.

Human-executed; nothing here is automated by this worktree. Scope is
strictly the founder/test organization via allowlist (the spec's G1 gate,
§3) — this is not a path to customer-facing `apply`, which is G2 and
requires its own, separate work (see the G1 gaps above).

### The six migrations, in push order

| Version | File | What it does |
| --- | --- | --- |
| `20260812000100` | `execution_audit_vocabulary.sql` | Redefines `audit_events_known_event_type` to add `automation_rule.executed`, `automation_rule.execution_failed`, `automation_sweep.completed`. |
| `20260812000200` | `audit_events_no_client_inserts.sql` | Drops `audit_events_insert`; revokes `insert` on `audit_events` from `authenticated` (spec §6). |
| `20260812000300` | `escalation_contract.sql` | The occurrence lifecycle columns/indexes on `mention_analyses`; escalation provenance; `raise_escalation`, `record_analysis_occurrence`, `apply_analysis_occurrence`; the open-only partial unique index (D158); grants. |
| `20260812000400` | `automation_transition_functions.sql` | `automation_set_status_decision`/`automation_escalate_decision`, the matrix restated in SQL. |
| `20260812000500` | `execute_automation_rule_rpc.sql` | The transactional execution RPC (D163). |
| `20260812000600` | `automation_execution_support.sql` | `claim_automation_sweep`, `automation_mark_activity`, and the widened `organizations_with_unanalyzed_mentions`. |
| `20260812000700` | `response_generation_audit_vocabulary.sql` | Redefines `audit_events_known_event_type` to add `response.generated` and `response.changes_requested`. Landed ahead of the rest of its vocabulary change: the TS↔SQL drift-guard test forced the audit literals to ship with the domain change that introduced them (D168). |
| `20260813000100` | `generation_attempts.sql` | The `generation_attempts` table: state-shape CHECKs, the one-pending partial unique index, composite tenant FKs to `mentions` and `response_drafts`, select-only RLS, and the column revoke that makes `claim_token` unreadable (D166). |
| `20260813000200` | `generation_functions.sql` | `claim_generation_attempt`, `complete_generation_attempt`, `fail_generation_attempt`, `redact_generation_snapshots`, and their grants (D166, D169). |
| `20260813000300` | `response_generation_vocabulary.sql` | `alter type approval_status add value 'changes_requested'` (D168). Irreversible: Postgres enums cannot drop a value, so rollback is an application revert that stops emitting it. |

### Rollout sequence

Each step gates the next, in this order. Earlier drafts of this runbook
filed the hosted segfault probe as a "pre-push" gate even though it needs
the migrations already on hosted to have anything to probe — a
contradiction. It is sequenced here as what it actually is: the first
post-push gate, run before enabling anything.

1. **Local harness green, at the pinned CLI (the actual pre-push gate).**
   `SUPABASE_DB_URL` is not set anywhere in the repository or `.env`;
   export it, then run the harness, against a freshly `supabase db reset`
   local stack, using the CLI version pinned in
   `.github/workflows/verify.yml` (`2.101.0` at time of writing) — not
   merely "some recent CLI":

   ```bash
   export SUPABASE_DB_URL="$(supabase status -o env | grep DB_URL | cut -d= -f2- | tr -d '\"')"
   npm run db:verify-execution
   ```

   The `database` CI job running this on every PR is the ongoing form of
   this gate; a manual local run before pushing is the one-time form of it
   for the push itself.

   **Response generation adds a second harness to this gate.** Run
   `npm run db:verify-generation` as well, the same way and at the same
   pinned CLI. It resets the stack itself, so the two are independent runs
   rather than one chained sequence, and CI runs both in the `database`
   job.
2. **Push the migrations, coordinated with deploy.** `supabase db
   push` against the hosted project, timed immediately before or upon
   deploying this branch — see the deploy-ordering note at the top of this
   section. Do not let a push and the matching deploy drift apart in time.

   **Done for both groups, 2026-08-12.** G1's six were pushed earlier that
   day; response generation's four (`20260812000700`,
   `20260813000100`–`20260813000300`) were pushed the same evening, ahead of
   this branch's merge, via `supabase db push --linked` — passwordless, four
   migrations, no collisions. Verified against the live schema rather than
   the CLI's success message: the table, all four functions, the
   `changes_requested` enum value, and the state-shape CHECKs exist, and
   `has_column_privilege('authenticated', …, 'claim_token', 'select')` is
   false while `status` remains readable. (Watch out for
   `information_schema.column_privileges` when re-checking that last one: it
   shows a `REFERENCES` row for `claim_token`/`authenticated`, which looks
   like a surviving grant and is not one. `has_column_privilege` is the
   operative test.)

   `20260813000300` (`alter type approval_status add value`) was the one
   irreversible step in the set: enum values cannot be dropped, so rolling
   back now means reverting the application so nothing emits the value.
   Because the schema went first, the ordering rule this step exists to
   protect is satisfied from the other direction — hosted is ahead of the
   deploy rather than behind it, so no deploy can reach a missing RPC.
3. **Probe the hosted build for the segfault finding, post-push, before
   enabling anything.** Task 11 found that the *local* Postgres 17.6 image
   crashes (`SIGSEGV`, whole cluster into recovery) on an EXECUTE-denied
   call of a non-immutable function after `set role` — the same shape as
   an unauthorized PostgREST RPC call. Now that step 2's migrations are on
   hosted and before `RULES_EXECUTION_MODE` is set to anything but
   `off` there, make an unauthorized RPC call against the hosted
   PostgREST endpoint — for example, call `raise_escalation` or
   `organizations_with_unanalyzed_mentions` as an `authenticated` (non
   service-role) client — and confirm the response is `403`/`42501`, not a
   dropped connection or an error indicating the backend restarted. A crash
   response means the hosted image shares the local finding and nothing
   past this point should proceed until that is resolved with Supabase
   support or a different image/CLI pin.
4. **Owner marks `database` a required status check.** Branch protection
   does not enforce the CI harness until a human adds it; `verify.yml`'s own
   comment records this as the intended next step. Do this before treating
   a green PR as sufficient evidence the harness ran — an optional check that
   nobody looks at is not a gate.

   **Deferred, 2026-08-12, deliberately:** branch protection on a private
   repository requires GitHub Pro, and the owner chose to hold off. Both CI
   jobs still run on every PR and push to `master`; what is missing is only
   enforcement. Until the repo upgrades or goes public, the gate is
   procedural — nothing merges on red checks — and every merge to date has
   gone through reviewed, verified gates. Revisit if a second contributor
   ever joins, where procedural discipline stops being a guarantee.

### Turning `apply` on, internal organization only

1. Set `RULES_EXECUTION_MODE=dry_run` first, `RULES_EXECUTION_ORG_ALLOWLIST`
   naming only the founder/test organization's id. Confirm one scheduled
   sweep produces projection rows and leaves `mentions`, `escalations`,
   `automation_rules`, and `audit_events` byte-identical (the same
   zero-mutation property §11-INT-9 pins in the test suite, now observed
   against the hosted project).
2. Flip `RULES_EXECUTION_MODE=apply`, allowlist unchanged (internal
   organization only). Watch the next scheduled sweep run — do not flip and
   walk away.
3. **First-live-sweep reconciliation**, per the spec's acceptance criteria
   (§11): reconcile the sweep's execution rows, the escalation dedupe
   behavior against D38's "high/critical always escalates" promise, and the
   audit events it wrote — all by hand, against the sweep's own cron
   response — before any second organization is ever added to the
   allowlist. This is a one-time manual check, not a script; the acceptance
   criteria are written that way deliberately.
4. **False-positive re-escalation is a standing watch item during this
   rollout** (D158's own text names it explicitly): the open-only dedupe
   means a mention re-escalates whenever it is re-triaged off `escalated`
   and a genuinely new analysis occurrence follows. Watch the internal
   organization's escalations centre for a mention re-escalating on stale
   or noisy grounds during the rollout window, since this is the first time
   the open-only contract runs against anything but a test suite.
5. **Cron response-shape note, for whoever wires external monitoring on
   this:** the `/api/cron/analyze-mentions` response's `execution.sweeps`
   field is an **array** of `SweepSummary` objects, one per organization
   the sweep attempted execution for — not rows keyed by `sweep_id`. Each
   object is camelCase: `organizationId`, `sweepId` (**null** for
   `not_claimed` and for `failed` — neither an idle return nor a throw
   carries a sweep id back), `status` (`"completed" | "not_claimed" |
   "failed"`), `claimed`, `counters` (the eight-field `SweepCounters` —
   `mentionsEvaluated`, `rulesMatched`, `actionsApplied`, `actionsBlocked`,
   `actionsSkipped`, `actionsFailed`, `retryableFailures`,
   `terminalFailures`), `mentionsSkipped`, and `budgetExhausted` (spec
   §10). `status: "degraded"`/HTTP 200 is normal operation under
   real-world partial failure and must not page; `status: "failed"`/HTTP
   503 — every attempted unit of work failed — is the actual page
   condition. While the allowlist holds exactly one organization (true for
   the whole of this rollout), that organization's sweep failing is, by
   itself, "every attempted execution sweep failed," so it alone satisfies
   the 503 condition (D155's accepted consequence, restated here because it
   is exactly what a monitor watching this endpoint needs to know going
   in).

## Closed by the first live run

All 26 migrations are applied to the hosted project, and the subsystems below
have now executed against real infrastructure rather than a stub. What each
one actually proved:

| Was | Now |
| --- | --- |
| Only 8 of 23 migrations applied | All 23 applied. The collided-and-renumbered versions (D93) went on cleanly, confirming none had ever been pushed under their old numbers. |
| **The Anthropic API had never been called from this repository** | Called. A scheduled sweep classified 12 mentions across both organizations with zero failures, writing real provenance — `claude-opus-5`, prompt version `analysis@2026-08-04`, per-row token counts. |
| Analysis had no scheduler | `/api/cron/analyze-mentions` ran end to end under `CRON_SECRET`, through `getServiceDataSource()`, and recorded two `completed` rows in `analysis_runs`. |
| D88's system-actor rule was a reading of the code | Verified in Postgres: both scheduled runs stored `actor_user_id = null`. `SYSTEM_ACTOR_ID` satisfies the `OrganizationScope` type and reaches no foreign key. |
| RLS policies had never been enforced by a live database | Enforced. Signed in as a seeded admin, all eight organization-owned tables returned own-tenant rows only; a cross-tenant insert was rejected `42501` with a same-tenant control proving the table was writable; a cross-tenant update touched 0 rows; the service-role scan RPC was rejected `42501`; anonymous read returned nothing. |
| Brand voice and monitoring-query writes were demo-adapter only | Both exercised against live Postgres under RLS — brand voice update plus its audit event, and monitoring-query insert, update, and delete. |
| News ingest was demo-adapter only | The whole pipeline ran against live Postgres with the mock provider: 3 queries polled, 5 articles ingested, 13 rejected `below_threshold`, gate scores and `requests_spent` recorded. The mock-derived rows were then removed, so the database is reproducible from the seed again. |
| The audit-vocabulary defect (D93) was a test failure | Confirmed against live Postgres: all eight restored event types insert, and an unknown type is still rejected `23514`. Without `20260807000700` the first membership change or brand voice edit would have failed in production. |
| **GNews had never been called** | Called. A live sweep fetched real articles, and a temporary probe query for a real brand ingested two of them as mentions — title, content, publisher name and domain, source URL, external id, and published-at all normalised correctly, with `raw_payload` left `{}` as D28 requires. The probe and everything it produced were removed afterwards; the database is reproducible from the seed again. |

### Onboarding, verified against the hosted project

`20260808000100` and `20260808000200` are applied, the seed carries an
`organization_onboarding` row per tenant, and the flow was exercised
end to end with a throwaway account that was removed afterwards.

| Property | Result |
| --- | --- |
| Provisioning creates three rows, not two | Confirmed. One RPC produced the organization, an `owner`/`active` membership, and an `organization_onboarding` row at `in_progress`/`organization`. An organization cannot exist with nowhere to record its setup. |
| The profile trigger still fires | `on_auth_user_created` made the `public.users` row every policy resolves through, before the RPC ran. |
| RLS on the new table | A member of one tenant sees exactly one row — their own — cannot read another's by asking for it, and cannot advance another's setup (0 rows updated). An admin writing their own row is the control that keeps those checks meaningful. |
| The new owner can read their own row | Confirmed. Without it the wizard could not read the progress it exists to resume. |
| Seeded tenants skip the wizard | Both seed organizations are `completed`/`ready`, so a seeded login lands on the overview rather than being sent back through setup. |

**Found while cleaning up: there is no `on_auth_user_deleted`.** Deleting an
account through the admin API or the dashboard removes the `auth.users` row and
leaves `public.users` behind, authenticating as nobody. That is defensible —
audit events reference `users`, and the member-management design already says
removal deletes the membership rather than the account — but it is the
unstated half of a trigger pair, and the asymmetry is worth knowing before
somebody adds a cascade to "tidy up" and erases the audit trail with it.

### What the first live news poll showed about the gate

Two behaviours that look like bugs and are not, recorded so the next reader
does not re-investigate them:

- **A candidate scoring 0.7 against a 0.35 threshold was rejected.** That is
  the ambiguity-corroboration rule, working exactly as written: `Laurent` is
  seven characters with no space, so it is ambiguous, and a lone ambiguous
  match is rejected *regardless of score* without a second distinct keyword or
  an allow-listed domain. It kept a New Yorker piece about Yves Saint Laurent
  out of a restaurant's inbox.
- **`status: partial` on a run that errored nowhere.** `truncated` was true —
  GNews capped the page at ten. Recorded as partial so a capped poll never
  reads as a quiet news day.

**And one thing that was a real defect, now fixed.** `gate_rejection_reason`
had four values and none meant "ambiguous term, uncorroborated", so that
rejection was recorded as `below_threshold` — false whenever the score cleared
the threshold, which it usually did. Of five articles about a genuine
salmonella outbreak at the probed brand, four were rejected at 0.7 against a
0.35 threshold and labelled as scoring too low.

It now emits `ambiguous_uncorroborated`, and a true non-match emits
`no_keyword_match`, leaving `below_threshold` to mean only itself. Each of the
three maps to a different operator action: fix the keywords, tune the
threshold, or revisit the ambiguity rule. `AMBIGUOUS_TERM_MAX_LENGTH`'s
justification — that the trade-off is acceptable because the rejection is
"discoverable and tunable" — is now accurate rather than aspirational.

Ambiguity is still checked before syndication, so wire copies of one story are
recorded as `ambiguous_uncorroborated` rather than `probable_syndication` when
the brand name is short. That ordering is unchanged and remains open.

`AMBIGUOUS_TERM_MAX_LENGTH` itself is still unrevisited: the heuristic still
rejects any lone ambiguous match under its length regardless of score, and
labelling the rejection accurately does not make that trade-off correct. Left
open because it is a gate-tuning decision with real product consequences, and
this document is the wrong place to make it silently.

Two useful things fell out of doing it:

- **`npm run db:seed:remote`.** There was no supported way to seed the hosted
  project without the database password, which is not in the repo and not
  recoverable from the CLI's keychain entry — so the tables added since
  workflow 04 sat empty. The loader goes through PostgREST under the
  service-role key instead, and shares `SEED_PLAN` with the SQL generator so
  the two cannot seed different things.
- **`--overwrite`.** Insert-only is the right default and matches
  `seed.sql`'s `on conflict (id) do nothing`, but it cannot fix a database
  seeded *before* a migration added a column: the row exists, the insert is
  skipped, and the new column keeps its default forever. That is exactly what
  had happened here — the hosted `news_article` mentions carried no publisher
  and no monitoring query long after both columns existed, and re-running the
  seed would never have said so.

## Still open

- **`toneNotes` and `signOff` reach every drafting prompt as `null`.** The
  drafting voice snapshot carries four fields the brand-voice entity does not
  model; D172 closed the third by mapping `approvedPhrases`, but these two have
  no counterpart to map — `brand_voice_profiles` has no notes column and no
  signature column — so every organization's prompt currently says "no
  preferred sign-off given -- close naturally as the business". Closing this is
  a migration, not a mapping, and the shape depends on a decision nobody has
  made yet: whether a sign-off is per-organization (one column) or per-location
  (a `location_id` override, in the shape D61 left open for the axes). Nothing
  invents a value for either in the meantime.
- **The real Google OAuth flow has still never been run**, and it cannot be
  run headlessly: it needs a person at a browser and a Google account with
  access to a Business Profile. Worth recording what does *not* substitute for
  it — requesting the authorize endpoint with the configured client returns a
  302 whether the client is real, the redirect URI is unregistered, or the
  client id is invented, because Google defers every one of those checks until
  after sign-in. A 302 there is not evidence of anything.
- **The `NEWSAPI_AI_API_KEY` in `.env` is dead configuration.** It is an Event
  Registry key, read by no code here, and it will not authenticate against the
  GNews client. D89's upgrade is still an upgrade, not the current state.
- ~~`supabase/tests/rls-verification.sql` has still never been executed.~~
  **Resolved, building rule execution (G0).** `npm run db:verify-rls` ran
  against the local Docker stack — `supabase db reset` followed by the
  harness itself against `postgresql://postgres:postgres@127.0.0.1:54322/postgres`
  — and passed: 37 checks, zero failures, including this branch's three new
  migrations. `SUPABASE_DB_URL` is not set anywhere in the repository or
  `.env`; it must be exported to the local connection string before running
  the script, which the two prior attempts recorded here evidently never
  did. Not run against the hosted project, which is a separate, deliberate
  step gated on this passing first.
- **Prompt quality remains unvalidated.** The first live run classified 11 of
  12 mentions `low` and one `medium`, and raised no escalation. That is
  plausible for this seed and is not evidence the risk thresholds are right;
  there is still no labelled dataset. `prompt_version` is recorded on every
  row so a later version can be compared against this one.
- Cost per run is now measurable rather than theoretical: the sweep of 12
  mentions spent roughly 1,500 input and 5,200 output tokens.
- **Two migration files shared versions with unrelated siblings and were
  renumbered before they ever reached the hosted project.**
  `monitoring_query_origin` (was `20260808000300`, now `20260808000600`) and
  `response_edited_audit_event` (was `20260808000500`, now `20260808000700`)
  each collided with a same-day migration that had already been applied under
  that version (`gate_rejection_reason_vocabulary` and `avatar_storage`
  respectively). The duplicate versions broke `supabase db reset` — and
  therefore `npm run db:verify-rls` — with a `schema_migrations` primary-key
  conflict. The applied files keep their original versions; the unapplied
  pair moved to free slots that still sort before
  `20260809000100_automation_rule_authoring`, which must remain the last word
  on `audit_events_known_event_type`.

## Decisions made adding the rule platform indicator

Every rules surface — the table, the detail header, each template card, and the
builder — shows which platforms a rule affects. The interesting part is not the
badge, it is what the badge is allowed to claim.

| # | Decision | Reason |
| --- | --- | --- |
| D179 | Scope is **derived** from a rule's conditions, never stored | A stored answer disagrees with the rule the moment somebody edits a condition. `src/lib/rules/platform-scope.ts` is pure, so the server renders it for a saved rule and the builder recomputes it while conditions are edited, from the same function. |
| D180 | `source_type` conditions count, not just `platform` ones | Every source type belongs to exactly one platform, and three of the five shipped templates scope themselves by `source_type` rather than by `platform`. Reading only `platform` conditions would have reported "all platforms" for most of the templates on the screen. |
| D181 | "No conditions" is reported as **matches nothing**, not as "all platforms" | `matchesRule` returns false for an empty condition list on purpose (a rule that says nothing should not fire). Rendering that rule as the broadest one on the screen would be the most misleading thing this feature could do. |
| D182 | Contradictory conditions get their own outcome, distinct from "no conditions" | They are different facts with different fixes. Two `is` values on the same field can never both hold — including two source types on the *same* platform (`reddit_post` AND `reddit_comment`), which a plain platform-level intersection would happily report as "affects Reddit" for a rule no mention can satisfy. |
| D183 | Excluding a source type only excludes its platform when it takes the last one | `source_type is_not reddit_post` leaves `reddit_comment`, so the rule still affects Reddit. Reddit is the only platform with two source types today; `PLATFORM_SOURCE_TYPES` is derived from `SOURCE_TYPE_PLATFORM` rather than hard-coded around that, so the second one cannot break it. |
| D184 | `SOURCE_TYPE_PLATFORM` is reused from `mention.ts`, not redeclared | It already existed there for grouping and routing. A second copy is a second thing to keep in step with the enum — the first draft of this work added one and the duplicate-export error caught it. |
| D185 | Badges carry no availability state | Considered marking platforms Lia has no connector for (Reddit throws from `getConnector`; Yelp is fixture-only), on the grounds that a Reddit-scoped rule cannot fire today. Decided against on the owner's call: the indicator answers "what does this rule target", and connector readiness is the integrations screen's subject. The consequence, recorded here rather than hidden: a rule scoped to an unimplemented platform looks exactly like one scoped to Google. |

## Decisions made building the empty rules screen

| # | Decision | Reason |
| --- | --- | --- |
| D186 | "No rules at all" and "no rules on this tab" become different branches | They were one, so filtering to Draft with no drafts told somebody with ten active rules "No rules yet". They now lead somewhere different too: a genuinely empty workspace gets the templates beside it, and a filtered-empty view must not — those rules exist one tab away, and offering to create more answers a question nobody asked. |
| D187 | The templates panel appears on the empty rules screen, not just in the builder | At zero rules the question is not "how do I create a rule" but "what would I even automate", which a bare empty state cannot answer. Same 7/5 split the builder already pairs templates with, so the relationship reads identically on both screens. |
| D188 | `RuleTemplatesPanel` takes `canManage`, defaulting to true | The builder renders it only after its own permission check, so it must not have to pass the flag; the rules list shows it to anybody who can see an empty screen, and a reader whose role cannot create rules would otherwise get five buttons into a page that tells them so. No action renders at all for them — not a disabled button in an empty container. |
| D189 | Status tabs are hidden when the organization has no rules | Four tabs all reading zero are a filter for nothing. |
| D190 | The empty card stretches to the sidebar's height | Verified in a browser rather than assumed: with `items-start` the left card ended at 490px against a sidebar running to 1100px, leaving a 600px void that read as unfinished. The repo's test suite computes no layout, so this class of problem is only ever found by looking. |
