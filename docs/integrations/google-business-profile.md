# Google Business Profile

Lia's first production platform integration. Connection and mapping delivered in
workflow 02; review synchronisation in workflow 03.

> **What this integration does not do:** it does not publish a reply, edit one,
> or delete one, and it does not watch Google. Reviews arrive when somebody runs
> a sync, so a location is only as current as its last sync. Every surface in
> the product says so — see `googleCapabilities()` in
> `src/lib/integrations/capabilities.ts`.

## 1. Purpose

A restaurant group's Google listings are where most of its public reputation
accumulates. Before Lia can read a review, four things have to be true and
provable:

1. The person connecting is authorised to act for this Lia organization.
2. Google has granted Lia standing permission on their listings.
3. Lia knows which Google account and which locations that permission covers.
4. Each Google location is bound to the right Lia restaurant.

Getting the fourth wrong is the expensive one. A misrouted mapping puts one
restaurant's complaints in another's queue, where a manager answers them in good
faith about a meal that was never served there — invisible until it is public.
So workflow 02 ended at a verified mapping, and workflow 03 starts from it:
every imported review inherits its location from the mapping, which is why the
mapping had to be provable first.

Once those four hold, workflow 03 imports the reviews for each mapped location
into the same `mentions` table every other source normalises into. There is no
Google review table, and that is the load-bearing decision — see §18.

## 2. Architecture

```text
src/integrations/
  connector.ts                    PlatformConnector interface, shared types
  errors.ts                       IntegrationError + normalised error codes
  registry.ts                     resolves live vs mock — the only place that decides
  google-business-profile/
    scopes.ts                     the one scope, and why
    schemas.ts                    Zod schemas for every Google response
    client.ts                     the ONLY file that issues HTTP to Google
    connector.ts                  refresh policy + normalisation
    mock-connector.ts             deterministic fixtures, development only

src/lib/integrations/
  oauth-state.ts                  issue / consume handshakes
  credentials.ts                  the only module that unseals a token
  google-service.ts               connect, discover, health, disconnect
  google-mapping.ts               persist location mappings
  matching.ts                     pure suggestion scoring
  capabilities.ts                 honest per-capability states

src/lib/crypto/token-vault.ts     AES-256-GCM envelope
```

Layering, strictly downward:

```text
route handler / server action
  └─ src/lib/integrations/*        orchestration, audit, permissions
       ├─ src/integrations/registry → PlatformConnector
       │    └─ google-business-profile/client.ts   ← all network I/O
       └─ src/lib/data/*            repositories (scoped, tenant-safe)
```

Nothing above `src/integrations/` knows an HTTP status code, and nothing below
it knows what an organization is.

### The connector boundary

```ts
interface PlatformConnector {
  readonly platform: Platform;
  capabilities(): ConnectorCapabilities;
  getAuthorizationUrl(input: AuthorizationRequest): Promise<string>;
  exchangeAuthorizationCode(input: AuthorizationCallbackInput): Promise<PlatformCredentials>;
  refreshCredentials(credentials: PlatformCredentials): Promise<PlatformCredentials>;
  revokeCredentials(credentials: PlatformCredentials): Promise<void>;
  testConnection(session: CredentialSession, connection: PlatformConnection): Promise<ConnectionHealth>;
  listExternalAccounts(session: CredentialSession): Promise<ExternalAccount[]>;
  listExternalProfiles(session: CredentialSession, accountId: string): Promise<ExternalProfile[]>;
}
```

Two deviations from the shape suggested in the workflow brief, both deliberate:

- **`CredentialSession` instead of raw credentials.** A session carries the
  credentials *and* a write-back callback. When a connector refreshes an access
  token mid-call it persists immediately; otherwise every request would refresh
  again, burning quota and risking a dropped token rotation.
- **`capabilities()` on the connector.** The integrations UI reads capabilities
  to decide what to offer. Having the connector declare them keeps the honest
  answer next to the implementation rather than in a constant somebody forgets.

This is not a plugin framework. There is no registration lifecycle and no
dynamic loading — one implementation plus a mock ships today, and inventing
extension points for connectors that do not exist would be guessing at their
requirements.

## 3. OAuth sequence

```mermaid
sequenceDiagram
    participant User
    participant Lia
    participant Google
    participant DB

    User->>Lia: POST /connect (form, owner or admin)
    Lia->>Lia: authorize(integration.connect)
    Lia->>DB: Store SHA-256(state) + user + org + redirect + expiry
    Lia->>DB: Audit integration.oauth_started
    Lia-->>User: 303 to Google
    User->>Google: Grant business.manage
    Google-->>Lia: GET /callback?code&state
    Lia->>Lia: Resolve session + active organization
    Lia->>DB: Atomic consume of state (single UPDATE)
    Lia->>Lia: Verify provider, user, organization, redirect
    Lia->>Google: Exchange code
    Google-->>Lia: access_token, refresh_token?, granted scope
    Lia->>Lia: Reject if business.manage was not granted
    Lia->>Google: accounts.list (establish the connected account)
    Lia->>DB: Upsert connection; store AES-256-GCM sealed credentials
    Lia->>DB: Audit integration.oauth_completed + integration.connected
    Lia-->>User: 303 to /integrations/google-business-profile/setup
    User->>Lia: Open setup
    Lia->>Google: accounts.list, accounts.locations.list (paginated)
    Lia-->>User: Candidates + suggestions (nothing applied)
    User->>Lia: Confirm mappings
    Lia->>Google: Re-fetch locations (verify the claims)
    Lia->>DB: Create locations, upsert profiles, audit each
```

### Routes

| Route | Method | Purpose |
| --- | --- | --- |
| `/api/integrations/google-business-profile/connect` | POST | Start the flow |
| `/api/integrations/google-business-profile/callback` | GET | Google returns here |
| `/integrations` | — | Connector list, connect entry point |
| `/integrations/google-business-profile` | — | Detail, health, reauthorize, disconnect |
| `/integrations/google-business-profile/setup` | — | Location selection and mapping |
| `/onboarding/connect-sources` | — | First-run setup, step 2. Starts the same POST flow. |
| `/onboarding/locations` | — | First-run setup, step 3. Same discovery and mapping services. |

**The onboarding flow adds two return destinations, not a second connector.**
`ALLOWED_REDIRECT_PATHS` gained `/onboarding/connect-sources` and
`/onboarding/locations`. Step 2 asks for the latter, so a successful grant lands
on step 3 rather than returning to a step the person just completed; step 2 is
listed as well because the callback re-checks the stored path on the way out and
a reauthorization started from step 2 must be able to return there.

Everything else is unchanged. Step 2 posts to the same connect route with the
same CSRF posture, the callback is the same handler, and steps 2 and 3 call
`getGoogleConnection`, `listGoogleBusinessAccounts`,
`listGoogleBusinessLocations`, `buildCandidates`, and
`saveGoogleLocationMappings` rather than reimplementing any of them. There is no
onboarding-specific Google code path, which is why the suggestion rule below
holds on both screens.

If a connection already exists, step 2 shows it and offers **Continue** instead
of a second consent screen. The action behind that button re-reads the
connection server-side; a client that could mark the step complete without one
would be past the only step with a real external prerequisite. No duplicate
connection can be created either way — `platform_connections` is upserted on
`(organization, platform)`.

**Connect is POST, not GET.** A GET that mints OAuth state and redirects to a
consent screen can be triggered by an `<img>` tag on any page on the internet.

**No `/[organizationSlug]` prefix.** The workflow brief suggested one. Workflow
01 decision D4 put the active organization in a verified httpOnly cookie
because `CLAUDE.md` fixes the route list; adding the segment to this one route
would make it the only screen in the product that disagrees with every other.
The organization is still bound into the OAuth state and re-verified on the
callback, so nothing is lost.

## 4. Requested scopes and rationale

| Scope | Why |
| --- | --- |
| `https://www.googleapis.com/auth/business.manage` | Google gates **all** Business Profile APIs behind this single scope. It covers account discovery, location discovery, and — later — review management. There is no narrower read-only scope; requesting less is not an option Google offers. |

Verified against Google's current documentation (checked August 2026):
[implement-oauth](https://developers.google.com/my-business/content/implement-oauth),
[basic-setup](https://developers.google.com/my-business/content/basic-setup).

### Deliberately not requested

Recorded in `src/integrations/google-business-profile/scopes.ts` so "we did not
ask for this" is checkable rather than asserted.

| Scope | Why not |
| --- | --- |
| `openid`, `userinfo.email`, `userinfo.profile` | The connected Google identity is established from the Business Profile account listing, which `business.manage` already covers. An identity scope would add access without adding capability. |
| `plus.business.manage` | Deprecated. Google keeps it alive only for backward compatibility. Lia does not request it. |

The rationale is rendered on the integration detail screen next to each granted
scope, so an administrator can check what Lia asked for and why without taking a
consent screen on trust.

### Partial grants

Google's consent screen lets a user decline individual scopes, and the token
response reports what was actually granted. The connector rejects a grant
missing `business.manage` at exchange time rather than storing it — a credential
that cannot do anything would otherwise produce a connection that looks healthy
and fails on every request.

## 5. Credential encryption

`src/lib/crypto/token-vault.ts`. AES-256-GCM from Node's standard library. No
cryptography is invented; the module assembles primitives and defines an
envelope.

```text
v1.<keyId>.<iv:base64url>.<tag:base64url>.<ciphertext:base64url>
```

| Decision | Reason |
| --- | --- |
| Authenticated encryption (GCM) | Without the tag, ciphertext could be altered in storage and would decrypt to something attacker-influenced rather than failing. |
| Version and key id are authenticated as AAD | A downgrade to an older envelope format fails the tag check, not just the parse. |
| One string, not four columns | The parts are all public — only the key is secret — and keeping them together makes it impossible to store a ciphertext whose IV or tag went missing. |
| Key from the environment | A database dump on its own decrypts nothing. |
| Key id recorded per value | Rotation without a flag day: a value records which key sealed it. |
| Empty input refused | A sealed empty string is indistinguishable downstream from a sealed real token, and that difference decides whether Lia offers to reauthorize. |
| Errors carry no detail | OpenSSL's text distinguishes a bad tag from a bad key. That distinction is an oracle. |

Storage lives in `platform_connection_secrets`: RLS enabled, **zero policies**,
reachable only by the service role. `PlatformCredentialRepository` returns
ciphertext; `src/lib/integrations/credentials.ts` is the only module that
unseals it, and what it produces never leaves a `CredentialSession`.

**Losing the key** loses no data, but every connection must be reauthorized. A
value that will not decrypt is reported as `authorization_revoked`, because
re-consenting is genuinely the only fix.

## 6. Account discovery

`GET https://mybusinessaccountmanagement.googleapis.com/v1/accounts`, paginated
at Google's maximum page size of 20.

Pagination is not optional: a hospitality group with an agency relationship
often holds several accounts — their own, a location group, and one shared by a
marketing partner. Taking only the first page would silently hide locations.

Normalised to:

```ts
interface ExternalAccount {
  externalAccountId: string;   // "accounts/1122334455"
  name: string;                // falls back to the resource name
  accountType?: string;
  role?: string;
  verificationState?: string;
  organizationInfo?: JsonObject;
}
```

Provider metadata is built by **naming fields**, never by spreading a response,
so a field Google adds tomorrow cannot silently become stored Lia data.

## 7. Location discovery

`GET https://mybusinessbusinessinformation.googleapis.com/v1/{account}/locations`,
paginated at 100.

`readMask` is **required** by Google — omitting it is an error, not a default —
so the mask is the definition of what Lia knows about a location:

```text
name, title, storeCode, websiteUri, phoneNumbers,
storefrontAddress, metadata, openInfo
```

No coordinates, no hours, no attributes: only what the mapping screen renders
and what a later review sync will need to address a location.

Locations are deduplicated by external profile id — Google can return the same
one twice when an account belongs to a group that also grants access directly,
and two identical checkboxes is a bug the user cannot resolve.

Google's location resource carries no verification state. `hasVoiceOfMerchant`
is the closest signal it gives for "this profile is genuinely yours to manage",
so it is surfaced as `VERIFIED` / `UNVERIFIED` rather than inventing a state
Google never sent.

Each candidate is annotated with what Lia already knows:

| State | Meaning |
| --- | --- |
| `unmapped` | Lia has never seen this listing |
| `mapped` | Connected, but not bound to a Lia location |
| `already_connected` | Connected and bound to a Lia location |
| `unavailable` | Previously connected, currently disconnected |

## 8. Location mapping

### Suggestions are suggestions

`src/lib/integrations/matching.ts` scores a listing against each Lia location.
Weights encode how much each signal is worth **as evidence**:

| Signal | Weight | Note |
| --- | --- | --- |
| Name matches exactly | 0.40 | Below the 0.45 threshold **on purpose** |
| Name is similar | 0.25 | |
| Street address matches | 0.35 | Abbreviations folded (`St` → `Street`) |
| Postal code matches | 0.15 | |
| City matches | 0.10 | |

A name match alone can never produce a suggestion. A restaurant group's sites
all share a name — that is precisely the case that would misroute reviews.

Two further restraints:

- At most **one** suggestion per row. A ranked list invites skimming and picking
  the top item, which is the behaviour this module exists to prevent.
- If the top two candidates are within 0.1 of each other, **no** suggestion. The
  signals did not separate them, and showing either would be a coin toss dressed
  up as a recommendation.

Every proposal renders its evidence beside the row and requires an explicit
click. Nothing auto-applies.

### Persisting

On save, for each selected profile:

1. Locations are **re-fetched from Google server-side** and the profile must
   appear in that live listing. A form field naming a Google location id is a
   claim; the live listing is the evidence. This is what stops an arbitrary
   Google location being mapped into an organization.
2. An existing Lia location must belong to the active organization — the list
   comes from a scoped repository call, so a foreign id is simply absent.
3. A new Lia location is created with `status: 'setup'`. Marking it `active`
   would flatter every roll-up that counts active locations.
4. `PlatformProfile` is upserted on `(connection, external profile id)`.
5. Audit events are written per row.

Gaps in a Google address are filled with the literal `Not provided by Google`
rather than an empty string: obviously wrong to a human reading the locations
screen, which `""` is not.

Constraints enforced:

| Rule | Where |
| --- | --- |
| One external profile maps once per connection | `platform_profiles_unique_external` |
| One Lia location per connection | `platform_profiles_one_location_per_connection` |
| No cross-organization mapping | Scoped repositories + RLS `WITH CHECK` |
| No duplicate rows in one submission | Application layer |

### Why there is no transaction

The repository interface is adapter-agnostic. The demo adapter has no
transaction to open, and PostgREST does not expose one. Wrapping the batch in a
Postgres function would work for the Supabase adapter and be untestable in the
demo one.

Instead each decision is **independent and idempotent**: every profile upserts
on its natural key, so re-running after a failure converges rather than
duplicating, and failures are returned per row. A user who mapped nine locations
correctly and one that collided keeps the nine and is told exactly which failed.
This is a real trade-off, recorded rather than hidden.

## 9. Authorization rules

Centralised in `src/lib/auth/permissions.ts`. No role check is written inline in
a route handler, action, or component.

| Role | connect | reauthorize | manage mappings | test | disconnect |
| --- | --- | --- | --- | --- | --- |
| Owner | ✓ | ✓ | ✓ | ✓ | ✓ |
| Admin | ✓ | ✓ | ✓ | ✓ | ✓ |
| Communications lead | — | — | ✓ | ✓ | — |
| Location manager | — | — | — | — | — |
| Approver | — | — | — | — | — |
| Analyst | — | — | — | — | — |
| Viewer | — | — | — | — | — |

Reasoning:

- **Connect and disconnect stay with owners and admins.** An OAuth grant hands
  Lia standing authority over a customer's Google listings; withdrawing it
  silently stops every downstream feature.
- **Mapping sits one notch lower.** Consequential but reversible, and the
  day-to-day work of running the integration — which is the communications
  lead's job.
- **Location managers are excluded.** A mapping is an organization-wide decision
  about which Google listing represents which restaurant. There is no location
  to scope them to, so granting it would widen their authority beyond their own
  sites.

There is deliberately **no `integration.view` permission**. That table gates
writes; reading is governed by holding an active membership and by the RLS
select policies underneath. A permission every role held would add a name
without adding a check.

## 10. Connection health

`checkGoogleConnectionHealth()` decrypts, refreshes if needed, and makes the
lightest authenticated request Google offers on this scope.

| Status | Means | Connection status |
| --- | --- | --- |
| `healthy` | Google accepted the request | `connected` |
| `token_expiring` | Expiring and cannot renew itself | `action_required` |
| `authorization_required` | Grant revoked or unreadable | `action_required` |
| `insufficient_permissions` | Scope missing | `action_required` |
| `quota_limited` | Rate limited | `connected` |
| `provider_unavailable` | Google 5xx or timeout | `connected` |
| `unknown_error` | Unclassified | `connected` |

Quota limits and outages are Google's problem and they pass — telling an
operator their integration is broken would send them to a consent screen that
fixes nothing.

`token_expiring` is only reported when there is **no** refresh token. With one,
an expiring access token is routine and renews itself.

Audit: `integration.health_checked` on every run;
`integration.health_degraded` only when the state actually *changed* for the
worse. Emitting a degradation per poll would bury the moment it broke.

Manual **Test connection** is on the detail screen. There are no recurring
background checks — the repository has no job system, and adding one to run
network calls on a timer is not a small change.

## 11. Reauthorization

Reuses the same state mechanism with `reauthorization: true`.

- The **existing connection row is updated**, never duplicated — every
  `platform_profiles` row references its id.
- Profile mappings survive; ones a disconnect left inactive are reactivated.
- `prompt=consent` is forced *only* here and when the connection is already
  `action_required`. Forcing it on every connection would train users to click
  through the screen that tells them what they are granting.
- **If Google returns no refresh token, the stored one is kept.** Google issues
  one on first consent and withholds it on silent re-approval. Writing the
  response verbatim would replace a working token with null, and the connection
  would die quietly hours later with no obvious cause.

Audit: `integration.reauthorization_started`, `integration.reauthorized`.

## 12. Disconnect semantics

Confirmation states the consequences before the button is armed.

| What | Outcome |
| --- | --- |
| Remote revocation | Attempted first — it needs the credentials the next step destroys |
| Local credentials | Deleted, always, even if revocation failed |
| Connection row | `status = disconnected`, scopes cleared, row kept |
| Profile mappings | Preserved as `disconnected` |
| Lia locations | Untouched |
| Audit history | Untouched, and added to |
| Imported review data | None exists — no review has ever been imported |
| Reconnecting | Restores every mapping |

Ordered so the local side always ends clean: leaving encrypted tokens behind
because Google was briefly unreachable would be the worse outcome.

**Revocation is never claimed unless Google confirmed it.**
`integration.credentials_revoked` on confirmation;
`integration.credentials_revocation_failed` otherwise, and the UI then tells the
administrator to remove Lia in their Google account settings. Saying "revoked"
when Google never answered would leave a live credential behind a UI claiming
otherwise, and nobody would go and revoke it.

Idempotent: a second disconnect succeeds quietly and does not re-ask Google.

## 13. Local mock mode

```bash
# .env.local
GOOGLE_INTEGRATION_MODE=mock
TOKEN_ENCRYPTION_KEY=$(openssl rand -base64 32)
APP_URL=http://localhost:3000
```

The mock's authorization URL points back at Lia's **own callback**, so clicking
Connect in development walks the identical route handler, state validation, and
persistence path a real grant would. Only the network call is absent — the
credentials it produces are encrypted and stored for real.

The fixtures are deliberately awkward: two accounts rather than one, a listing
whose name nearly matches a seeded Lia location, an unverified listing, and one
with no address. Tidy fixtures hide exactly the cases the mapping screen exists
to handle. Re-consent returns no refresh token, so the preservation path is
reachable in development rather than only in a unit test.

Guarantees:

- **Refused in production.** `NODE_ENV=production` with `mock` fails at
  environment parse — the process does not boot, rather than serving fabricated
  Google accounts to a customer.
- **Never chosen implicitly.** An absent configuration is `unconfigured`, not
  `mock`, so fixture data cannot be mistaken for a real connection.
- **UI cannot tell.** `src/integrations/registry.ts` is the only file that
  decides, and the mock declares the same capabilities as the real connector.

## 14. Known limitations

1. **Reviews arrive only when a sync is run.** There is no scheduler and no
   Pub/Sub subscription, so a location is as current as its last sync. Workflow
   03 deliberately shaped the service to be callable by a job without changing
   it, but did not add the job.
2. **The migrations have never been executed.** No PostgreSQL server and no
   Docker daemon in this environment. They are validated by parsing with the
   real PostgreSQL grammar (`npm run db:validate`), which catches syntax but not
   a column that does not exist. Run `npm run db:reset` before trusting them.
3. **The real Google OAuth flow has never been run.** No Google Cloud project
   was available. Every Google interaction in the test suite is stubbed. The
   HTTP route handlers are covered by type-checking and the production build,
   not by a live request.
4. **No transaction around a mapping batch.** See §8.
5. **No phone-number matching.** `locations` has no phone column, so Google's
   number has nothing to compare against. It is the strongest signal available
   and the first weight to add when the column exists.
6. **No background health checks.** Manual only.
7. **Timezone is inherited from the organization.** Google's location resource
   carries none, and guessing from an address would be wrong for exactly the
   multi-city groups Lia serves.
8. **One connection per platform per organization.** A group whose listings are
   split across two unrelated Google accounts cannot connect both.
9. **`accounts.list` is called on every setup render.** No caching; fine at this
   scale, a quota consideration later.
10. **Every sync refetches the whole history.** Deliberate — see §17,
    "Idempotency". Correct, and more bandwidth than an incremental cursor would
    use. Revisit only with a safe overlap window and tests proving an edited
    older review is not skipped.
11. **One location at a time.** No bulk sync control, by design; a group with
    forty restaurants pressing one button would be forty serial page-walks
    behind a single spinner.
12. **Deleted Google reviews are never removed from Lia.** A mention with a
    draft and an escalation attached is not something to delete because a page
    came back shorter.
13. **The reviews endpoint has never been called against real Google.** Same
    reason as (3): no Google Cloud project. Pagination, retries, and error
    classification are covered against a stubbed `fetch`.

## 15. Troubleshooting

| Symptom | Cause | Fix |
| --- | --- | --- |
| "not configured on this server" | Missing `GOOGLE_CLIENT_ID` / `SECRET` / `REDIRECT_URI` / `TOKEN_ENCRYPTION_KEY` | Set them; the server log names which. |
| `redirect_uri_mismatch` at Google | `GOOGLE_OAUTH_REDIRECT_URI` differs from the registered value | They must match exactly — scheme, host, port, path. |
| "authorization link has expired or was already used" | Older than 10 minutes, or replayed | Start again. Consuming is single-use by design. |
| "started by a different person" | Signed in as another user since starting | Start again from your own account. |
| "started for a different organization" | Organization switched mid-flow | Switch back and start again. |
| "no Business Profile accounts" | The Google user administers none | Sign in with an account that manages the listings, or be granted access in Google. |
| "missing a Google permission" | `business.manage` declined | Reauthorize and accept every permission. |
| "rate-limiting requests" | Google quota | Wait. Request a higher quota in Cloud Console. |
| Locations list is empty | Wrong account selected | Use the account selector; groups often hold several. |
| "already mapped to a different Google location" | One Lia location, two Google listings | Change or skip one. |
| Reconnect leaves mappings inactive | Reconnected as a *new* connection rather than reauthorizing | Use Reauthorize. |
| Credentials will not decrypt | `TOKEN_ENCRYPTION_KEY` changed | Reauthorize. Ciphertext under a lost key is unrecoverable. |
| "a sync is already running" | Another request holds the lock | Wait. It clears when that run finishes, or after 30 minutes if its process died. |
| Sync reports 0 fetched on a busy listing | Wrong Google location mapped, or the listing is unverified | Check the mapping on the setup screen; verify the location in Google. |
| "no longer available to this connection" | Google 404 — unverified location, or access withdrawn | Verify the location in Google, or reauthorize with an account that manages it. |
| Reviews imported with no restaurant attached | The Google listing is mapped to no Lia location | Map it on the setup screen, then sync again — the ingest is idempotent. |
| "some reviews could not be stored" | Item-level failures; the rest were saved | Run the sync again. Check `platform_sync_runs.error_code` for the reason. |
| Counts show everything "unchanged" | Working as intended | That is what an idempotent second run looks like. |

Server logs carry error **codes and variable names**, never tokens, codes,
state values, or Google's message text.

## 16. Google Cloud Console setup

1. Create a Google Cloud project.
2. Enable the Business Profile APIs — at minimum **My Business Account
   Management API** and **My Business Business Information API**.
3. **Request Business Profile API access.** Google gates these behind an
   application form and grants a default quota of zero. Approval takes days to
   weeks; without it, calls fail even with a valid token. This is the step most
   likely to block a first real connection.
4. Configure the OAuth consent screen. External apps serving other people's
   businesses require verification, since `business.manage` is a sensitive scope.
5. Create an **OAuth 2.0 Client ID** of type *Web application*.
6. Register the redirect URI exactly as in `.env.example`, for every
   environment.
7. Put the client id and secret in `.env.local` — never in the repository.

## 17. Review synchronisation (workflow 03)

### What it does

Imports every review for one connected Google location into `public.mentions`,
idempotently, and records the attempt.

```text
POST /api/integrations/google-business-profile/reviews/sync   (or the server action)
  └─ authorize("integration.sync_reviews")     owner | admin | communications_lead
       └─ syncGoogleReviews()                  src/lib/integrations/google-reviews.ts
            ├─ resolveSyncTarget()             scoped lookup, platform + status checks
            ├─ platformSyncRuns.start()        THE LOCK — partial unique index
            ├─ loadCredentials()               decrypt; refresh writes back mid-call
            ├─ connector.listExternalReviews() every page, retries, normalisation
            ├─ mentions.ingest()               per review, source-owned fields only
            ├─ platformSyncRuns.finish()       counts, status, sanitised error
            ├─ platformProfiles.markSynced()   ONLY on success
            └─ recordAuditEvent()              counts, never review text
```

### The Google API

`GET https://mybusiness.googleapis.com/v4/{parent=accounts/*/locations/*}/reviews`

Reviews are the one Business Profile resource Google never migrated off the
legacy **v4** API — the v1 families cover accounts and locations only. Same
OAuth scope (`business.manage`, §4), different host. No new scope is requested
and no new environment variable is introduced: workflow 03 runs entirely on what
workflow 02 already configured.

| Parameter | Value | Why |
| --- | --- | --- |
| `pageSize` | `50` | Google's documented maximum. |
| `orderBy` | `updateTime desc` | Edited reviews surface first. |
| `pageToken` | followed to exhaustion | An initial backfill imports the **whole** history, not the first page. |

The location must be verified. An unverified one returns 404, which Lia reports
as `resource_unavailable` — "that location is no longer available to this
connection" — rather than as a permissions problem.

### Running a sync

**In the product.** `/integrations/google-business-profile` → **Connected
locations** → **Sync reviews** on the location you want. Each location is a
separate Google request against a shared quota, so there is deliberately no
"sync everything" button; that is the scheduled job's job, not a button's.

**Over HTTP.**

```http
POST /api/integrations/google-business-profile/reviews/sync
Content-Type: application/json

{ "channelId": "<platform_profiles.id>" }
```

```jsonc
{
  "ok": true,
  "syncRunId": "…",
  "channelId": "…",
  "status": "completed",          // completed | partial | failed
  "counts": { "fetched": 412, "created": 9, "updated": 2, "unchanged": 401, "failed": 0 },
  "totalReviewCount": 412,        // Google's own count, or null when it omits one
  "lastSuccessfulSyncAt": "2026-08-03T10:14:22.104Z"
}
```

Statuses: `400` invalid body or non-Google channel, `403` role refused, `404`
unknown channel *or a channel in another organization*, `409` a sync is already
running, `502` provider failure, `503` not configured.

The response never carries a token, a Google status string, or a raw provider
payload. `platformProfileId` is accepted as a synonym for `channelId`.

### Review → mention mapping

| Google | `mentions` column | Note |
| --- | --- | --- |
| `reviewId` | `external_id` | The idempotency key. |
| `name` | `external_resource_name` | Null when Google omits it. Never reconstructed. |
| — | `source_type` | Always `google_review`. |
| — | `platform_connection_id`, `platform_profile_id` | From the connection and the mapping. |
| — | `location_id` | Inherited from the profile's mapping. |
| `starRating` | `rating` | `ONE`…`FIVE` → 1–5. `STAR_RATING_UNSPECIFIED` → **null**, never 0. |
| `comment` | `content` | `""` on a rating-only review. Never invented prose. |
| `reviewer.displayName` | `author_name` | Null when absent. |
| `reviewer.profilePhotoUrl` | `author_avatar_url` | |
| `reviewer.isAnonymous` | `author_is_anonymous` | Distinct from a missing name. |
| `createTime` | `published_at` | Falls back to `updateTime`. |
| `updateTime` | `source_updated_at` | |
| `reviewReply.comment` | `source_reply_text` | Source state — **not** a Lia draft. |
| `reviewReply.updateTime` | `source_reply_updated_at` | |
| — | `received_at` | First import only. A re-sync never moves it. |
| — | `last_synced_at` | Every run that touched the row. |
| — | `source_metadata` | Named fields only, never a spread of Google's response. |

Deliberately **not** stored: a reviewer id (Google exposes no stable one, and
deriving one from a display name would merge every "John S." into one customer),
a per-review URL (Google returns none; a fabricated deep link would 404), a
language (Google does not report it here), and the raw payload (`raw_payload` is
left `{}` — a verbatim copy would put a reviewer's name and photo URL in a
second, unmanaged place for no capability gained).

### Idempotency

Enforced at the database by `mentions_unique_external`
`(platform_connection_id, source_type, external_id)`, which the foundation
already had. The ingest is an upsert on that key, so the guarantee does not
depend on an application-level find-before-insert.

The second guarantee is structural rather than careful. `IngestMentionInput`
**has no field** for `status`, `sentiment`, `risk_level`, `relevance_score`,
`engagement_score`, or `received_at`, so a sync cannot write them even by
accident. `SOURCE_OWNED_MENTION_FIELDS` in `src/domain/entities/mention.ts` is
the one declaration of which side of the line each field falls on; both adapters
read it, so they cannot disagree.

Consequently a re-sync leaves untouched: the status somebody set, any analysis,
every response draft and approval, escalations, assignments, and the mention id
that all of them reference.

**No incremental cursor**, and that is a decision. Google orders by
`updateTime desc`, so a "stop at the first review we already have" rule would
skip an older review whose *edit* pushed it up the list — exactly the review
most worth noticing, because somebody changed their mind in public. The upsert
makes refetching consequence-free, so correctness is bought with bandwidth
rather than with a cursor that can silently lose data.
`platform_profiles.sync_cursor` therefore remains unused.

### Concurrency

`platform_sync_runs_one_active`, a partial unique index on
`(platform_profile_id, resource) where status = 'running'`, **is** the lock.
Opening a run is the whole of the concurrency control — the application never
checks first and then inserts, because that is two statements with a race
between them. A second concurrent sync gets a 23505 and is reported as a `409`.

Not an in-memory lock: Lia runs on serverless functions, so two concurrent
requests are routinely two processes.

A run left `running` by a process that died still holds the lock, so one older
than **30 minutes** (`SYNC_RUN_STALE_AFTER_MS`) is closed as `sync_abandoned`
and the new run takes over. Without that, one crash would block a location's
syncs until somebody edited the database.

### Inspecting status and failures

- **Per location**, in the product: imported review count, last successful sync,
  current state, and the last sanitised error, on the integration screen.
- **Per run**, in the database: `public.platform_sync_runs` — actor, trigger,
  started/completed, the five counts, pages fetched, and a normalised error code.
  Readable by any active member, by design: distinguishing "no new reviews" from
  "the import is failing" is not a privileged question.
- **In the audit trail**: `integration.reviews_synced` and
  `integration.review_sync_failed`, attributed to the `platform_profile`.
  Metadata carries counts and a code — never review text, a reviewer's name, or
  a provider message.

A **failed** run never moves `platform_profiles.last_synced_at`. Showing
"synced a minute ago" beside an error is how an operator concludes their reviews
are current when they are not.

### Retries

Bounded: 3 retries, exponential from 500 ms, capped at 20 s, honouring
`Retry-After` in either the seconds or the HTTP-date form. Only
`quota_exceeded` (429) and `provider_unavailable` (5xx, timeout, network) are
retried. A 401 or 403 is **not** — it will not become a 200 in two seconds, and
retrying only delays the message telling the user to reauthorize.

Discovery calls deliberately do **not** retry: they run inside a page render
where somebody is waiting.

### Google API limitations

1. **v4 is legacy.** Reviews have no v1 equivalent. If Google migrates them,
   only `client.ts` changes.
2. **No per-review URL.** Google returns none, and Lia fabricates none.
3. **No stable reviewer identity.** Repeat customers cannot be recognised.
4. **`totalReviewCount` is not always sent.** Null is recorded rather than the
   array length, which would be the page size and not the total.
5. **Deleted reviews are not detected.** Google simply stops returning them, and
   Lia deliberately deletes nothing — a mention with a draft and an escalation
   attached is not something to remove because a page came back shorter.
6. **Quota is zero until Google approves the API application** (§16). A valid
   token is not sufficient.
7. **No Pub/Sub.** Reviews are as fresh as the last sync.

## 18. Why there is no Google reviews table

The obvious shape — a `google_reviews` table mirroring Google's payload — was
rejected. `public.mentions` already exists as the canonical model, already
carries `google_review` as a source type, and already has the unique constraint
that makes a repeated ingest idempotent.

A parallel table would have forked the unified inbox, the insights aggregates,
escalations, and the response pipeline, and every one of those would then need a
join or a union that knew about Google specifically. Worse, it would need
merging back later — at exactly the moment there was real customer data to lose.

The cost is eight columns added to `mentions`. They are named
platform-neutrally (`source_reply_text`, not `google_review_reply`) because Yelp,
Trustpilot, and TripAdvisor all have an owner reply and an edited-at timestamp,
and the next connector should be filling these in rather than adding its own
near-identical set.

## 19. The boundary for workflow 04

Workflow 04 is:

> A Google review response workspace with AI-assisted draft generation, using
> imported reviews, brand voice, response rules, citations to relevant customer
> details, human approval, and an explicit separation between drafting and
> publishing.

It inherits, ready to use:

- Google reviews in `public.mentions`, with rating, comment, reviewer, and the
  owner reply Google currently shows.
- `source_reply_text` as source state, so a drafting flow can tell an
  already-answered review from an unanswered one — and the
  `mentions_org_awaiting_reply_idx` partial index to find the latter cheaply.
- `response_drafts` and `approvals`, untouched by any sync.
- A capability set that already says publishing is unavailable, so the UI must
  offer "copy for manual publishing" rather than a publish button.

It must **not**: publish a reply to Google (that needs a further design pass on
`reviews.updateReply`, and a capability change that would be a lie today),
subscribe to Pub/Sub, add a scheduler, or widen the OAuth scopes.
