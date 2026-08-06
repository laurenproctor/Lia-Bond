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
| `src/lib/brand-voice/` | Brand voice save service, summary derivation, and autosave status. |
| `src/lib/onboarding/` | First-run setup: route guards, step transitions and their audit trail, the deterministic brand-voice preview, quick-win resolution, import status, and the post-authentication destination. |
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
monitoring-query service — `saveOnboardingNewsQuery` edits the oldest
organization-wide brand query rather than creating duplicates), and Reddit.

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
  status advanced from `new`. Source-owned columns are not reachable from
  `MentionAnalysisOutcome`, the mirror of the rule that keeps a sync out of
  Lia's workflow state.
- A synchronisation writes only source-owned fields. Lia's workflow state —
  status, sentiment, risk, assignment, drafts, approvals, escalations — is not
  reachable from `IngestMentionInput`, so an ingest cannot overwrite it even by
  accident. `SOURCE_OWNED_MENTION_FIELDS` is the single declaration of the line.
- Review text and reviewer names never appear in an audit event, a sync-run
  error message, a log line, or an API response.
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
| D39 | An analysis may not write source state | The mirror of D22. `MentionAnalysisOutcome` has fields for four columns and nothing else, so the guarantee is structural rather than a rule a call site must remember. |
| D40 | Rating-only reviews are analysed deterministically, with no model call | A rating with no text has nothing to classify. The saving is incidental — the real reason is that asking a model to explain a wordless review invites it to invent a reason, and an invented reason stored as an analysis would be quoted back by a later drafting workflow. |
| D41 | Reviewer display names are sent to the model | The user's explicit decision. Recorded because it sends personal data to a third party for a classification task that does not require it. |
| D42 | The `mention_analyses` insert is the per-item commit point | No transaction is available (D17). Ordering escalation → mention update → analysis insert means a crash costs a repeated call, never a silently un-analysed mention. Analysis-first would leave a record that looks analysed, never gets its risk level, and is never selected again. |
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
  audited action. Nothing generates text from it yet.
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
- `response_drafts.brand_voice_version` is still written null. Stamping it is
  drafting's job.
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

New after integrating the branches:

- The marketing site, help requests, and early access shipped without ever
  reaching this document; their routes and directories are recorded above as
  of this merge. Whatever caused them to be missed is a process gap, not a
  code one — the branch that added them updated no architecture doc at all.

## Closed by the first live run

All 25 migrations are applied to the hosted project, and the subsystems below
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

**And one thing that is a real defect.** `gate_rejection_reason` has four
values and none of them means "ambiguous term, uncorroborated", so that
rejection is recorded as `below_threshold` — which is false whenever the score
cleared the threshold, and it did on most of them. The live probe made the
cost concrete: of five articles about a genuine salmonella outbreak at the
probed brand, four were rejected at score 0.7 against a 0.35 threshold,
labelled as though they had scored too low. Only the one whose headline
happened to carry the full two-word company name was admitted.

This matters more than a mislabelled row. `AMBIGUOUS_TERM_MAX_LENGTH`'s own
comment accepts the short-brand-name trade-off *on the grounds* that "the
rejection is logged with its reason (D82) and is therefore discoverable and
tunable". It is not discoverable: an operator reading this table sees
`below_threshold` at 0.7 and concludes the threshold logic is broken, and
lowering the threshold — the obvious response — changes nothing, because the
corroboration rule never consulted it. The rejection data the gate depends on
to be tunable currently cannot distinguish "irrelevant" from "on-topic but
uncorroborated", which is the distinction it exists to record.

A related consequence: because ambiguity is checked before syndication, four
near-identical wire copies of the same story were each recorded as
`below_threshold` rather than `probable_syndication`, so the dedupe rule
never ran on the clearest syndication case the live poll produced.

The fix is a fifth enum value plus the migration to add it, and it needs the
`AMBIGUOUS_TERM_MAX_LENGTH` heuristic revisited alongside — not done here
because both are gate-tuning decisions with real product consequences, and
this document is the wrong place to make them silently.

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
- **`supabase/tests/rls-verification.sql` has still never been executed.** The
  live checks above were run through PostgREST as an authenticated user, which
  covers the tenancy property that harness protects but not the harness
  itself — it needs `psql` and the database password, and `npm run
  db:verify-rls` additionally needs `supabase db reset`, which needs Docker.
- **Prompt quality remains unvalidated.** The first live run classified 11 of
  12 mentions `low` and one `medium`, and raised no escalation. That is
  plausible for this seed and is not evidence the risk thresholds are right;
  there is still no labelled dataset. `prompt_version` is recorded on every
  row so a later version can be compared against this one.
- Cost per run is now measurable rather than theoretical: the sweep of 12
  mentions spent roughly 1,500 input and 5,200 output tokens.
