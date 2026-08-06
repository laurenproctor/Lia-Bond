# New-user onboarding

## 1. Purpose

A self-serve owner who has just created an account has an organization with a
name and nothing else: no industry, no timezone, no connected source, no
locations, no voice, and no teammates. Dropping them on `/overview` teaches
them the product is empty rather than that it is unconfigured — every KPI reads
zero, every card renders an empty state, and nothing on the screen says why.

Onboarding is five steps that turn that row into a workspace, followed by a
separate screen that hands over the first thing worth doing.

It is deliberately **not** a settings wizard. Every step already exists as a
real product screen (`/settings`, `/integrations`, `/locations`,
`/brand-voice`), and a completed organization is redirected out of the flow
rather than allowed to run it again.

## 2. Route map

```mermaid
flowchart LR
    A[Create account] --> B[Organization]
    B --> C[Connect sources]
    C --> D[Choose locations]
    D --> E[Brand voice]
    E --> F[Invite team]
    F --> G[Workspace Ready]
    G --> H[First useful action]
    H --> I[Overview]
```

| Route | Step | Purpose |
| --- | --- | --- |
| `/onboarding/organization` | 1 | Enrich the organization created at signup |
| `/onboarding/connect-sources` | 2 | Three sources: connect Google, optionally configure News & Media, see Reddit's real status. Or skip. |
| `/onboarding/locations` | 3 | Map Google listings, or add a location by hand |
| `/onboarding/brand-voice` | 4 | Set the five-axis voice |
| `/onboarding/team` | 5 | Issue invitation links |
| `/onboarding/ready` | — | **Not step 6.** No progress strip, no step badge. |

The group lives at `src/app/onboarding/`, directly under `src/app` rather than
inside `(app)`. That is what keeps the navy sidebar, the organization switcher,
and the badge counts off these screens — all three would be wrong for a
workspace that has not been configured.

## 3. Signup transition

```text
signUpAction
  └─ supabase.auth.signUp()        ← creates auth.users
       └─ trigger on_auth_user_created
            └─ public.users        ← the row every RLS policy resolves through
  └─ organizations.provision()     ← RPC: organization + owner membership
                                     + organization_onboarding, one transaction
  └─ redirect("/onboarding/organization")
```

`provision_organization` was rewritten to insert the onboarding row in the same
function body. A function body is a transaction, which is the only place this
codebase has that guarantee (D17), so an organization can never exist without
somewhere to record its setup progress.

**Email confirmation.** When the Supabase project requires it, `signUp` returns
no session — so there is no `auth.uid()` for provisioning to act as, and the
organization cannot be created yet. The name is carried in signup metadata under
`lia_pending_organization`, and `provisionPendingOrganization()` reads it back
on the first authenticated request (from `/auth/callback` and from
`signInAction`, so either route repairs it).

That key is a **hint, never an authorization**. Supabase user metadata is
writable by the account it belongs to, so anybody could set it on themselves.
It buys nothing: provisioning runs only when the account belongs to *no*
organization at all, so the worst outcome is the empty workspace they could
already have created through the sign-up form.

**Invitation signup is untouched.** `acceptInvitationWithSignUpAction` calls
`invitations.accept` and never `organizations.provision`, and the pending-name
path is gated on a membership check rather than on which form was submitted —
so an invitee is excluded by the fact that they already belong somewhere,
whichever route they arrive through.

## 4. Progress model

One row per organization in `organization_onboarding`, primary-keyed on
`organization_id`. Progress is stored server-side rather than in wizard state
because setup is not a single sitting: it involves an OAuth round trip through
Google, and people routinely start on a laptop and finish on a phone.

| Column | Meaning |
| --- | --- |
| `status` | `in_progress` or `completed` |
| `current_step` | Where to resume. **Advisory** — see below. |
| `*_completed_at` | When a step was finished |
| `*_skipped_at` | When a step was deliberately waived |
| `completed_at` | When the wizard finished |
| `ready_viewed_at` | When the result screen was first opened |
| `organization_size` | Setup metadata, deliberately not on `organizations` |

`current_step` is never trusted. The route guard recomputes the resume point
from the timestamps via `firstIncompleteStep()`, so a stale or tampered value
cannot unlock a step whose prerequisites were never met.

There is one timestamp **per outcome** rather than a single high-water mark,
because a step can be skipped rather than completed and those are different
facts with different consequences — skipping the source step is why location
discovery is unavailable two screens later.

Three check constraints hold the shape: a `completed` row must carry
`completed_at`, and no step may be both completed and skipped.

**Absence means completed.** `get()` returns null for an organization with no
row, and every caller treats that as finished rather than as "start the
wizard". Every pre-existing organization was backfilled, so a missing row is an
anomaly — and the safe direction for an anomaly is into the product, not into a
setup wizard for a workspace somebody has used for months.

## 5. Step prerequisites

A step is reachable when **every step before it is settled** — completed or
skipped. Backward navigation falls out for free (a completed step's
predecessors are settled by definition) and typing the URL of a step three
ahead does not.

| Step | Reachable when |
| --- | --- |
| 1 Organization | always |
| 2 Connect sources | step 1 completed |
| 3 Choose locations | steps 1–2 settled |
| 4 Brand voice | steps 1–3 settled |
| 5 Invite team | steps 1–4 settled |
| Ready | `status = completed` |

At least one of three things must happen before step 3 advances: a Google
profile is mapped, a location is created by hand, or the step is explicitly
skipped. A submission where every mapping row failed does **not** advance — it
returns the per-row reasons and stays put.

## 6. Skip behavior

Three steps offer a skip. Two do not: the organization details and the brand
voice are always answered, which is why neither has a `_skipped_at` column.

| Step | Skip wording | Consequence |
| --- | --- | --- |
| 2 | Continue without connecting | No review import, no Google location discovery, step 3 falls back to manual entry |
| 3 | Skip for now | No locations to route feedback to |
| 5 | Skip for now | No invitations issued; setup still completes |

Step 2's skip requires a deliberate confirmation that states the three
consequences by name. It is a text button, not an outlined one — skipping stays
reachable but must not read as the primary path.

## 7. Step 2 — three sources

Step 2 presents Google Business Profile, News & Media, and Reddit as three
source cards inside one working card, with the same aside-and-card layout as
every other step. The three are not equals and the screen does not pretend
they are:

- **Google** is the prerequisite. The step completes when it is connected, or
  when the person confirms — deliberately — that they are continuing without
  it. Nothing else can satisfy that prerequisite.
- **News & Media** is optional persisted configuration against the real
  monitoring-query system (section 7.2). It never blocks progress.
- **Reddit** is presented exactly as capable as the repository is, which
  today is not at all (section 7.3).

Every status word and count on the screen derives from persisted rows. A card
may say *Recommended*, *Optional*, *Connected*, *Configured*, or *Available
after setup* (`source-status-badge.tsx` is the closed vocabulary); nothing is
ever labelled *Active*, because a saved row proves configuration, not
activity.

### 7.1 Google OAuth return path

The CTA is a real `<form method="post">` to the existing
`/api/integrations/google-business-profile/connect` route. A GET that mints
OAuth state and redirects to a consent screen can be fired by an `<img>` tag on
any page on the internet; POST means the request came from a form on Lia.

`ALLOWED_REDIRECT_PATHS` contains `/onboarding/connect-sources` and
`/onboarding/locations`. Step 2 asks for **`/onboarding/connect-sources`** —
the grant returns to the three-source screen, so the person can configure the
optional monitoring beside the connection they just made before moving on. The
value is validated against the closed list twice — when the state is issued,
and again when it is consumed — so the hidden field is a preference, not an
instruction. An unlisted path is silently ignored rather than rejected, which
is the safest handling for the parameter an open-redirect attack wants.

Nothing about the grant reaches the URL: the callback appends `connected=1` and
the account name, never a code, a token, or the state value.

**The callback settles the source step itself** when the grant's return path
is an onboarding path: it re-reads the onboarding row, and unless the
organization has already finished setup it calls `completeSourceStep` —
best-effort, with failure swallowed, because losing the redirect over a
progress write would strand somebody who just granted access. This is what
makes the return loop-free: step 2 renders as a settled, revisitable step, and
**Save and continue** merely records the (idempotent) completion again on the
way to step 3. Both repository adapters clear `source_skipped_at` when they
set `source_completed_at`, so someone who skipped, came back, and connected
does not trip the both-timestamps check constraint. A grant that started from
`/integrations` never touches onboarding — the gate is the stored return
path, and a completed organization is refused belt-and-braces on its own
status.

If Google was connected on a previous visit, step 2 shows the connection with
the safe account name and a quiet **Manage connection** reauthorization form;
the primary action stays **Save and continue**, and nobody is pushed through
OAuth again for revisiting the step. `completeOnboardingSourceAction` still
re-reads the connection server-side — a client that could mark the step
complete without one would let anybody past the only step with a real
external prerequisite. No duplicate connection is created:
`platform_connections` is upserted on `(organization, platform)`.

### 7.2 News & Media configuration

The card is backed entirely by the existing monitoring-query architecture —
there is no onboarding-only news table, no second validation schema, and no
parallel write path.

- **Input** is `onboardingNewsMonitoringInputSchema`, a `pick` of the real
  create schema: name, keywords, exclusions, country, language, enabled. The
  advanced fields the wizard never shows get the documented defaults on
  create — `queryType: "brand"`, `locationId: null`, empty publisher lists,
  `DEFAULT_RELEVANCE_THRESHOLD` (0.35), `DEFAULT_POLL_INTERVAL_MINUTES` (240)
  — and are **left untouched on update**, so tuning done on the News & Media
  screen survives a revisit to step 2.
- **The save path** is `saveOnboardingNewsMonitoringAction` →
  `saveOnboardingNewsQuery` → the existing `createMonitoringQuery` service,
  which provisions the implicit `news_media` connection (D80) and records the
  same audit events a save from the News & Media screen records. The action
  requires `monitoring.manage_queries`, the same permission that screen
  requires.
- **Which query onboarding manages** is decided by `findOnboardingNewsQuery`:
  the **oldest organization-wide brand query** (`queryType = 'brand'`,
  `locationId IS NULL`, ordered by `createdAt` then id). Structural, persisted
  fields — never the display name, which anybody can edit. Repeated saves
  therefore edit one row rather than accreting "Brand watch" copies, and a
  brand query created by hand is edited rather than shadowed. The known
  limitation: a hand-created organization-wide brand query is
  indistinguishable from an onboarding-created one, because
  `monitoring_queries` has no origin column and a migration for bookkeeping
  was not worth it.
- **Prefill** comes from real organization data only: the organization's name
  as the first keyword, its website host as a one-press suggestion. No
  fabricated aliases, people, or location names — step 3 has not chosen
  locations yet, and the wizard does not pretend otherwise.
- **The summary** on the card (`summarizeNewsMonitoring`,
  `lastSuccessfulNewsPollAt`) is derived from persisted queries and
  `news_poll_runs`: enabled-query count, unique keyword count, language and
  country only when every enabled query agrees, and the last **completed**
  poll's time — otherwise "Not checked yet". The badge says *Configured*, not
  *Active*.
- **Location queries are not auto-created after step 3.** The data model
  cannot distinguish onboarding-generated queries from user-created ones
  without a migration, so automatic per-location monitoring is left to the
  full News & Media screen and recorded here as a limitation.

### 7.3 Reddit

There is no Reddit connector, monitor, persistence, or polling service in
this repository — `getConnector("reddit")` throws, and
`tests/onboarding-sources.test.ts` pins that fact to the card. The card
renders the *Available after setup* badge, honest copy, and a genuinely
disabled **Configure after setup** button whose reason travels with it via
`aria-describedby`. No configuration form, no counts, no last-checked time,
and no write path of any kind. `docs/architecture/current-state.md` records
the capability gap.

## 8. Location mapping

Step 3 reuses `listGoogleBusinessAccounts`, `listGoogleBusinessLocations`,
`buildCandidates`, and `saveGoogleLocationMappings` — the same services the
integrations setup screen uses, including their server-side re-fetch of every
selected listing. A form field naming a Google location id is a claim, not
evidence.

**A suggestion is never applied.** `buildCandidates` computes a fuzzy match, and
the wizard renders it as an option labelled *(suggested match)* — never as the
selected value. The default for an unmapped row is "Create in Lia", which is
always safe. A wrong mapping sends one restaurant's complaints to another's
queue, where somebody answers them in good faith about a meal that was never
served there, and the damage is invisible until it is public.

Row states: **Matched** (existing in Lia), **Create in Lia** (new location),
**Not selected**, **Already connected** (locked, no control), **Unavailable**
(a previously disconnected listing).

Failures are per row. Nine locations that mapped correctly are kept when the
tenth collides, and each failure is shown against its own row.

When no usable connection exists, the route renders a genuinely different
screen: a manual location form. There is no empty Google table and no refresh
button that could never return anything — that would tell somebody their Google
account has no locations when the truth is that no account is connected.

## 9. Brand-voice persistence

Step 4 reads and writes the **existing** profile through `saveBrandVoice`, the
same service `/brand-voice` uses. There is no second brand-voice schema and no
onboarding-only storage, so a voice set here is the voice the product uses.

The two writes — the profile, then the step — are not one transaction (the
repository interface has none to open). The order is what makes that safe: the
voice is saved first, so a crash between them leaves the settings persisted and
the step unmarked. The form is seeded from the stored profile, so the person
returns to their own answers and presses the button again. **Nobody is ever
asked to re-enter a voice they already saved.**

The preview is deterministic and calls no model. Three reasons, in order:
dragging five sliders would fire a request per frame; `LIA_AI_MODE` is
frequently unconfigured during onboarding, which is the one moment a new
customer must not meet a configuration error; and a model's answer would be one
sample from a distribution shown beside a claim that this is how Lia replies.
The screen labels it *"Preview — an illustration, not a published reply"* and
states that the example review is made up.

## 10. Invitation-link behavior

Lia does **not** email invitations (D55: Supabase's built-in SMTP on a new
project is rate-limited and may deliver only to project members, so an
email-only invitation would fail silently and look like a bug in Lia). Step 5
issues copyable links, and the screen says so in as many words — the button
reads "Finish setup", the results panel reads "Copy these invitation links now",
and the *what happens next* list says links can be copied and shared. Nothing on
the screen contains the word "sent".

Each link is shown **exactly once**. Only the SHA-256 hash reaches the database;
the raw token is never persisted, never logged, and never written to an audit
event. A link that is not copied cannot be recovered — it can only be revoked
and reissued from `/settings`, which the panel says.

Rows fail independently. One invalid address must not discard the links already
generated beside it, because those links cannot be regenerated. Setup completes
regardless: somebody whose three addresses were all typos has still finished
setting up their workspace.

The owner row is locked with no remove control. A constraint trigger refuses to
leave an organization with no active owner, so an editable row would offer
something the database refuses. Owner is absent from `INVITABLE_ROLES` and
therefore from the role select.

## 11. Workspace Ready quick-win hierarchy

`resolveQuickWin()` reads real repository data and returns the first rung that
applies:

1. **A response draft awaiting a decision** → *Review first suggestion*, routed
   to the workspace for the mention it answers
2. **An analysed mention** → *Review first analysed mention*
3. **An imported mention** → *Review imported feedback*
4. **Connected profiles, no sync yet** → *Start importing reviews* (an action,
   not a navigation)
5. **Nothing connected** → *Connect Google Business Profile*

Each rung is strictly weaker than the one above. Reaching rung 5 means step 2
was skipped, which is the only honest thing left to say.

"Go to Overview" is a quiet secondary link and never displaces the quick win.
The setup summary is a compact two-column strip beneath it, not five large
numbered rows: it is a receipt, and the point of the screen is the first thing
worth doing next.

### Import progress

**There is no scheduled review sync.** `vercel.ts` schedules the news poll and
the analysis sweep; neither touches reviews. So the flow does not enqueue an
import at step 3 — inventing a background job to enqueue against would mean the
ready screen claimed an import that nothing would ever run.

Instead the screen offers a real, user-triggered **Start importing reviews**
action that calls `syncGoogleReviews`, the same service the integrations screen
uses, once per connected profile, sequentially (parallel syncs against one
shared Google credential is how a first-day customer meets a quota error).

The import panel renders only from `platform_sync_runs` rows, and
`ImportStatus` has **no field that could hold a percentage**. Google does not
report how many reviews a location has until a page has been fetched, and even
then `totalReviewCount` is optional — a bar at "68%" with nothing behind the 68
would be the most misleading thing this page could show. A provider total, when
one exists, is rendered as "of N" and never divided. Counts come from finished
runs only; a run still in flight has tallies that would tick backwards.

`hasStarted: false` is a real answer, not an empty state, and the panel says so.

## 12. Route guards

Two guards, pointing in opposite directions, which is what keeps them from
looping.

| Guard | Where | Diverts |
| --- | --- | --- |
| `requireOnboardingStep(step)` | each step page | **completed** organizations out to `/overview` |
| `redirectIfOnboarding()` | `(app)/layout.tsx` | **incomplete** organizations in to the resume step |

A finished organization satisfies the first and is untouched by the second; an
unfinished one is the reverse. Neither can hand back to the other.

`redirectIfOnboarding()` runs **before** the sidebar queries and before anything
renders, so a half-configured workspace never shows a dashboard implying setup
is done.

Only owners and admins are diverted. Every step is an owner-or-admin decision,
so sending an analyst to a wizard they cannot operate would strand them at a
form with every control refused. Everybody else sees the product, partially
configured — which is honest, because those screens render real data and real
empty states.

`/onboarding/ready` uses `requireOnboardingReady()` instead: the mirror image,
sending an organization that has not finished back to finish it, and letting a
finished one through as many times as it likes.

`middleware.ts` lists `/onboarding` in `PRODUCT_PATHS`, so an anonymous request
gets the sign-in page rather than a redirect from the layout.

## 13. RLS and authorization

`onboarding.manage` is held by **owner and admin only** — narrower than
`can_write_in_organization`, because finishing setup decides what everybody in
the organization sees on sign-in, and because its five steps are each already an
owner-or-admin decision on their own.

`organization_onboarding` has RLS enabled with:

- **select** — any active member (`is_organization_member`). The guard runs for
  every role, so every role needs the read. Nothing sensitive is in the row.
- **insert / update** — `has_organization_role(..., ['owner','admin'])`,
  mirroring the permission. Restated in SQL rather than trusted to the
  application: a check in application code protects only the path that runs it.
- **no delete**, and the grant is revoked so the absence is deliberate. Deleting
  the row would read as "never onboarded", which the application treats as
  complete — a delete would look like a setup that never happened.

Other controls:

- OAuth state stays single-use, expiring, user-bound, and organization-bound.
- Invitation tokens stay hashed at rest; raw links are shown once.
- No credential enters client props. Step 2 receives the Google account **name**
  and nothing else — no account id, no scopes, no tokens.
- No client component imports a service-role client or a `server-only` module.
- Every redirect path is internal and allowlisted.
- Every write is validated with Zod before anything else happens.

## 14. Testing

Eight suites, all against the demo adapter and the real source:

| Suite | Covers |
| --- | --- |
| `onboarding-progress.test.ts` | settlement, reachability, resume, step table, step-1 input schema, offered options |
| `onboarding-repository.test.ts` | provisioning, transitions, idempotence, completion refusal, cross-organization isolation |
| `onboarding-routing.test.ts` | signup, invited signup, completed bypass, resume, role-gated diversion, guard shape, ready framing |
| `onboarding-preview.test.ts` | determinism, no provider, every axis has an effect, phrase handling |
| `onboarding-ready.test.ts` | quick-win hierarchy end to end, import status from real runs, no percentage field |
| `onboarding-permissions.test.ts` | permission matrix, RLS policy text, OAuth allowlist, audit vocabulary, no credentials in client code, mock mode |
| `onboarding-accessibility.test.ts` | `aria-current`, labels, sliders, hidden decoration, the disabled Reddit control's explanation, the configurator's focus and announcement behaviour, heading order, no product palette |
| `onboarding-sources.test.ts` | step 2's three-source model: deterministic onboarding-query selection, dedupe-safe News saves through the real service, schema-compliant defaults, truthful summaries, Reddit's absent capability, Google-only completion |
| `onboarding-activation.test.ts` | the overview banner appears only while its condition holds, and disappears |

`supabase/tests/rls-verification.sql` gained a section 9 covering
`organization_onboarding`: cross-organization reads return nothing,
cross-organization updates match no rows, an analyst can read but cannot mark
setup complete, and nobody can delete a row. **All seven checks pass against a
local Postgres.**

### What has been run against a real database

`supabase init` + `supabase start` + `supabase db reset` on a local stack
(never the linked remote):

- both migrations apply cleanly from an empty database, in order, after the
  other twenty-three;
- the seed loads, and both seeded organizations land as `completed` with
  `completed_at` equal to their own `created_at`;
- every organization has exactly one onboarding row;
- `provision_organization` creates the organization, the owner membership, **and**
  the onboarding row at step 1 in one transaction, with the actor taken from
  `auth.uid()`;
- all five table constraints refuse what they are supposed to: `completed`
  without `completed_at`, a step both completed and skipped, an unknown
  organization size, a second row for one organization, and an orphan row;
- RLS is on, there is no delete policy, and section 9's seven checks pass;
- `supabase/tests/rls-verification.sql` now passes **end to end — all 34
  checks**. It did not before: section 8's analyst-delete assertion expected
  an exception where an RLS `using` clause filters silently, which failed
  against a real database and hid every section after it. Corrected to assert
  `row_count = 0`, matching section 3's cross-tenant UPDATE check;
- 21 assertions against the **Supabase adapter** under a real signed-in user
  session — so every policy applied — covering the `nowIfUnset` sentinel's
  idempotence, the skip/complete transitions, the completion refusal,
  `markReadyViewed`, `organizations.update` (including that the slug does not
  move), and `create()`'s upsert.

`audit-vocabulary-migrations.test.ts` (pre-existing) asserts the migration's
check constraint matches `AUDIT_EVENT_TYPES`, and covers the eleven new events.
`seed-generator-columns.test.ts` (pre-existing) asserts the seed generator's
column list matches the new table's real columns.

## 15. Known limitations

1. **No real browser was driven.** The walkthrough was HTTP-level against a dev
   server in demo + Google mock mode. Rendering, both guards, all five steps,
   both step-3 paths, the ready screen, and a full mock OAuth round trip were
   verified; layout at 375 / 768 / 1024 / 1440 px was **not**.
2. **No real Google OAuth flow has run.** Mock mode exercises state issue,
   callback, code exchange, discovery, and mapping, but no live Google Cloud
   project was involved.
3. **Review import is manual.** There is no scheduled review sync, so a customer
   who closes the ready screen without pressing *Start importing reviews* has an
   empty workspace until they press it on the integrations screen. The
   activation banner on `/overview` is what surfaces that.
4. **Step 1's two writes are not atomic** (organization row, then onboarding
   row). Ordered so a crash leaves the details saved and the step unmarked,
   which is recoverable by pressing the button again.
5. **The activation banner's dismissal is per-session.** Persisting it would
   need a column, and the banner already removes itself when its condition stops
   being true.
6. **An invited admin joining an organization whose owner abandoned setup will
   be diverted into the wizard.** The guard is role-based and state-based rather
   than signup-path-based; that organization genuinely is unconfigured, and the
   admin has the authority to finish it.
7. **A cancelled Google grant loses its message during onboarding.** The
   callback's failure path redirects to `/integrations?error=…`, and the
   product shell's guard immediately diverts an unfinished organization back
   into the wizard — dropping the query string. The person lands on step 2
   with Google accurately shown as disconnected, but without the sentence
   explaining why. Fixing it would mean redirecting failures to a path taken
   from an unconsumed state parameter, which is exactly the parameter the
   open-redirect protections exist to distrust.
8. **Reddit monitoring does not exist.** The step-2 card says so; nothing in
   this repository ingests, persists, or polls Reddit. See
   `docs/architecture/current-state.md`.
9. **No automatic location News queries after step 3.** `monitoring_queries`
   cannot distinguish onboarding-generated queries from user-created ones, so
   per-location monitoring stays a manual step on the News & Media screen
   rather than risking duplicate or overwritten queries on retries.
10. **A hand-created organization-wide brand query is adopted by step 2.**
    `findOnboardingNewsQuery` identifies the onboarding-managed query
    structurally (oldest org-wide brand query), which is also how it avoids
    duplicates — the trade-off is that the wizard edits such a query rather
    than creating a second one, which is the intended behaviour but worth
    knowing.
