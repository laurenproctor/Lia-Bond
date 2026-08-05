# Current state

Factual snapshot of the Lia codebase after workflow 04 (AI provider layer and
mention analysis), the authentication work that followed it, and brand voice
configuration. Update this document whenever a workflow changes the stack,
the tenancy model, or the data flow.

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
| `src/app/` | App Router routes. All product screens live in the `(app)` route group. |
| `src/app/actions/` | Server actions. The only write path in the application. |
| `src/components/` | Presentational components. **Never** query the database. |
| `src/domain/` | Zod schemas, inferred types, and lifecycle enums. No I/O. |
| `src/integrations/` | Platform connector boundary. All Google API behaviour lives behind it. |
| `src/ai/` | Model boundary. All Anthropic API behaviour lives behind it. |
| `src/lib/analysis/` | Analysis orchestration: prompt, schema, heuristic, run service. |
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
| `/sign-in` | Email and password sign-in. **Outside the app shell** — see D46. | Supabase Auth |
| `/sign-up` | Creates an account **and** the organization it owns. Outside the app shell. | Supabase Auth + `provision_organization` |
| `/invite/[token]` | Accept an invitation. Public — the invitee has no account yet. | `invitation_preview` / `accept_invitation` |
| `/forgot-password` | Requests a reset link. Outside the app shell. | Supabase Auth |
| `/reset-password` | Sets a new password using the recovery session. Outside the app shell. | Supabase Auth |
| `/auth/callback` | Where an emailed auth link lands; establishes the session | Supabase Auth |
| `/brand-voice` | Voice configuration | repositories |
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

### Sign-up and provisioning

A new account and a new organization are created together, and the ordering is
load-bearing:

```text
signUpAction
  └─ supabase.auth.signUp()          ← creates auth.users
       └─ trigger on_auth_user_created
            └─ public.users          ← the row every RLS policy resolves through
  └─ organizations.provision()       ← RPC: organization + owner membership, one transaction
```

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
- **No scheduler.** `analyzeMentions()` accepts `trigger: "scheduled"` and needs
  no request context, but nothing calls it on a timer.
- Cost is bounded per run, not per day. Adequate while the trigger is manual.
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
  Slider dragging, the sticky save bar and Discard, Enter-adds-a-phrase, and
  the end-to-end save round trip are covered by service and repository tests
  and by code review, but no browser has driven them. Server-side rendering
  was verified against a demo-mode dev server, including the read-only render
  for a role without the permission: notice shown, all five sliders disabled,
  no save bar.
