# Voice-aware response generation for Google reviews

Design document, v3. Written 2026-08-07; revised twice the same day after
design review. Supersedes v2 (git history holds v1 and v2). Not implemented.

Standing scope (unchanged): manual generation (D116), Google reviews only
(D117), human approval before anything leaves Lia. No automation, no
publishing, no job platform, no prompt-management product.

## Repository conventions this design reuses (verified)

- **SQL authorization helpers**: `public.is_organization_member(org_id)` and
  `public.has_organization_role(org_id, array[...]::membership_role[])` —
  used by `20260808000200_organization_onboarding_rls.sql`, whose header
  states the convention this design follows: a permission row from
  `src/lib/auth/permissions.ts` is *restated* in RLS/SQL "rather than
  trusted to the application."
- **Function security**: every function in
  `20260805000100_membership_provisioning.sql` is `security definer` with
  `set search_path = public, pg_temp`;
  `20260807000600_oauth_helpers_default_privilege_revoke.sql` shows the
  explicit `revoke execute … from anon, authenticated` convention for
  server-only functions.
- **`.rpc()` call sites** in `src/lib/data/supabase/index.ts` (`provision_organization`,
  `accept_invitation`, `consume_oauth_state`, …).
- **Postgres enums** (`approval_status`, `membership_role`, …) rather than
  text+check for closed vocabularies that RLS or functions consume;
  text+check for the audit event list (full-redefinition pattern, mirror
  test `tests/audit-vocabulary-migrations.test.ts`).
- **FK convention**: `references … on delete cascade` for
  organization-owned rows (20 uses in the initial schema).
- **Real-DB harness**: `supabase/tests/rls-verification.sql` via
  `npm run db:verify-rls` (`supabase db reset && psql -f`).
- **Anthropic client** (`src/ai/anthropic/client.ts`): sets `model` and
  `max_tokens` only; temperature is provider-default (extended thinking on
  by default); `messages.parse` with `zodOutputFormat`; SDK exposes the
  provider request id on responses.
- **Existing gaps acknowledged rather than hidden**: no scheduler/cron
  runner beyond the two Vercel crons; deleted Google reviews are never
  removed; audit trail is append-only with UPDATE/DELETE revoked.

## Database-enforced guarantees vs application behavior

**The database enforces** (nothing here depends on application timing or
discipline):

1. At most one live (`pending`) attempt per mention — partial unique index,
   retained as defense in depth behind the serialized claim function.
2. All attempt mutations flow through three functions; direct
   INSERT/UPDATE/DELETE by `authenticated` is impossible (no policies grant
   it, and grants are revoked).
3. `response.generate` is checked *inside* `claim_generation_attempt` via
   `has_organization_role`, mirroring the TS matrix (owner, admin,
   communications_lead) — the onboarding precedent.
4. Completion/failure require the attempt's unguessable `claim_token`
   (compare-and-set on `id + claim_token + status = 'pending'`) — a stale
   worker cannot overwrite a newer attempt's result.
5. Draft + attempt completion + `response.generated` audit event are one
   transaction; a generated draft without audit history is unrepresentable.
6. State-combination integrity via CHECK constraints (below); tenant
   integrity via composite foreign keys (below).
7. Tenant isolation via RLS on the table (select only) and scope checks
   inside the functions.

**The application provides** (behavior, not guarantees): the button and its
pending/failed/dedup states; DTO construction and snapshotting; prompt
rendering; output validation; classified error copy; telemetry queries;
retention function invocation.

## Schema (migration 1)

```sql
create type generation_attempt_status as enum ('pending', 'completed', 'failed');
create type generation_failure_category as enum
  ('provider_error', 'invalid_output', 'lease_expired');
create type brand_voice_source as enum ('configured', 'default');

create table public.generation_attempts (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null references public.organizations (id) on delete cascade,
  mention_id          uuid not null,
  status              generation_attempt_status not null default 'pending',
  failure_category    generation_failure_category,
  claimed_by_user_id  uuid not null references public.users (id),
  -- Compare-and-set credential for complete/fail. Returned only to the
  -- claimant by claim_generation_attempt; never readable via select (the
  -- RLS select policy excludes it via a column grant revoke).
  claim_token         uuid not null default gen_random_uuid(),
  claimed_at          timestamptz not null default now(),
  expires_at          timestamptz not null,
  finished_at         timestamptz,
  response_draft_id   uuid,
  -- Immutable provenance (D130, revised per review item 2):
  context             jsonb not null,         -- the DraftingContext, verbatim
  context_hash        text not null,          -- sha256 of canonical context JSON
  prompt_version      text not null,          -- e.g. 'drafting@2026-08-07'
  rendered_system_hash text,                  -- sha256 of the rendered system prompt
  rendered_user_hash  text,                   -- sha256 of the rendered user message
  output_schema_version text,                 -- zod output schema version tag
  model_provider      text,
  model_name          text,
  max_output_tokens   integer,
  temperature         numeric,                -- null = provider default (current client)
  provider_request_id text,
  input_tokens        integer,
  output_tokens       integer,
  latency_ms          integer,
  brand_voice_source  brand_voice_source not null,
  brand_voice_version text,
  analysis_included   boolean not null,
  dedup_hits          integer not null default 0,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),

  -- Review item 5: valid state combinations.
  constraint ga_pending_shape check (
    status <> 'pending'
    or (finished_at is null and failure_category is null and response_draft_id is null)
  ),
  constraint ga_completed_shape check (
    status <> 'completed'
    or (finished_at is not null and response_draft_id is not null and failure_category is null)
  ),
  constraint ga_failed_shape check (
    status <> 'failed'
    or (finished_at is not null and failure_category is not null and response_draft_id is null)
  ),
  constraint ga_lease_order   check (expires_at > claimed_at),
  constraint ga_counts_sane   check (
    coalesce(input_tokens, 0) >= 0 and coalesce(output_tokens, 0) >= 0
    and coalesce(latency_ms, 0) >= 0 and dedup_hits >= 0
  ),

  -- Tenant integrity (review item 5): composite FKs pin the mention and the
  -- draft to the same organization as the attempt. Requires the two backing
  -- unique constraints below — a new pattern for this schema, called out in
  -- "Conflicts" — actor cross-org integrity is enforced in the claim
  -- function (claimed_by_user_id must hold an active membership; CHECKs
  -- cannot reference other tables).
  constraint ga_mention_same_org foreign key (mention_id, organization_id)
    references public.mentions (id, organization_id) on delete cascade,
  constraint ga_draft_same_org foreign key (response_draft_id, organization_id)
    references public.response_drafts (id, organization_id)
);

alter table public.mentions        add constraint mentions_id_org_key        unique (id, organization_id);
alter table public.response_drafts add constraint response_drafts_id_org_key unique (id, organization_id);

-- The concurrency backstop (defense in depth behind the serialized claim).
create unique index generation_attempts_one_pending
  on public.generation_attempts (mention_id) where status = 'pending';

-- Operational indexes (review item 6), each tied to a named query:
--   latestForMention (button state on the workspace):
create index generation_attempts_mention_recency_idx
  on public.generation_attempts (mention_id, created_at desc);
--   telemetry listing/counting per organization:
create index generation_attempts_org_recency_idx
  on public.generation_attempts (organization_id, created_at desc);
--   edited-before-approval metric join (attempt → its draft):
create index generation_attempts_draft_idx
  on public.generation_attempts (response_draft_id)
  where response_draft_id is not null;
-- No status/failure-category reporting index yet: no shipped query reads it
-- (the insights modules that would are unbuilt). Deliberate non-index.
-- No lease-expiration index: expiry is only ever evaluated for one mention's
-- pending row inside the claim, which the partial unique index already serves.
```

RLS: `enable row level security`; one **select** policy
(`is_organization_member(organization_id)`); **no insert/update/delete
policies**, plus explicit
`revoke insert, update, delete on public.generation_attempts from authenticated;`
so the absence is deliberate (the onboarding migration's own style). A
column-level `revoke select (claim_token)` keeps the CAS credential
unreadable; members see attempt existence and state, never the token.

## Functions (migration 2)

All three: `security definer`, `set search_path = public, pg_temp`.
Grants: `revoke execute … from anon` on all of them; claim, complete, and
fail remain executable by `authenticated` — claim enforces the role check
internally (that is the point), and complete/fail are useless without the
CAS token only the claimant ever held. The redaction function is revoked
from `anon` **and** `authenticated` (server-only, the
`consume_oauth_state` convention). Signatures and typed results:

```sql
-- Serialized claim (review item 3). Locking order: exactly one row lock —
-- the mention row via SELECT … FOR UPDATE — taken before any read or write
-- of generation_attempts, so all claim activity for a mention serializes on
-- one lock and no second lock is ever taken (no ordering to get wrong, no
-- deadlock cycle possible within this path).
create function public.claim_generation_attempt(
  p_mention_id uuid,
  p_context jsonb,
  p_context_hash text,
  p_prompt_version text,
  p_brand_voice_source brand_voice_source,
  p_brand_voice_version text,
  p_analysis_included boolean,
  p_lease_seconds integer default 120
) returns table (
  outcome text,             -- 'claimed' | 'in_progress' | 'draft_exists'
  attempt_id uuid,
  claim_token uuid,         -- non-null only when outcome = 'claimed'
  response_draft_id uuid    -- non-null only when outcome = 'draft_exists'
);
```

Algorithm, one transaction:

1. Resolve the caller's organization membership for the mention's org;
   raise unless active **and**
   `has_organization_role(org, array['owner','admin','communications_lead'])`
   — the `response.generate` row restated in SQL (review item 1).
2. `select … from public.mentions where id = p_mention_id for update` —
   also verifies existence, org scope, and `source_type = 'google_review'`.
3. If any `response_drafts` row exists for the mention → return
   `('draft_exists', null, null, draft_id)` (this phase: drafts are
   generation-blocking regardless of status, D132).
4. Load the pending attempt, if any. If expired
   (`expires_at < now()`): close it — `status = 'failed'`,
   `failure_category = 'lease_expired'`, `finished_at = now()` — and fall
   through to 6.
5. If live: `dedup_hits = dedup_hits + 1`; return
   `('in_progress', id, null, null)` — no token, so the second caller can
   never complete someone else's attempt (review item 1, ownership).
6. Insert the new pending attempt (snapshot columns from parameters;
   `expires_at = now() + p_lease_seconds`); return
   `('claimed', id, claim_token, null)`.

```sql
create function public.complete_generation_attempt(
  p_attempt_id uuid,
  p_claim_token uuid,
  p_draft_text text,
  p_rendered_system_hash text,
  p_rendered_user_hash text,
  p_output_schema_version text,
  p_model_provider text,
  p_model_name text,
  p_max_output_tokens integer,
  p_temperature numeric,
  p_provider_request_id text,
  p_input_tokens integer,
  p_output_tokens integer,
  p_latency_ms integer
) returns table (outcome text, response_draft_id uuid);
-- outcome: 'completed' | 'superseded'
```

One transaction: CAS-update the attempt
(`where id = … and claim_token = … and status = 'pending'`). Zero rows →
return `('superseded', null)`: the lease expired and a newer claim closed
this attempt, or completion was already submitted — either way the stale
worker writes nothing (review item 3). One row → insert the
`response_drafts` row (`status 'draft'`, `generated_by 'ai'`, provenance
columns from the attempt), set `completed` + telemetry + `finished_at` +
`response_draft_id`, insert the `response.generated` audit event (metadata:
model, versions, token counts — never text). **Provider succeeds after
lease expiry but before anyone re-claimed:** the CAS still matches
(`status = 'pending'`) and the completion is accepted — the lease exists to
unblock retries, not to discard finished work; the moment a re-claim has
closed the attempt, the CAS fails instead. Double completion: second call
returns `('superseded', …)` — idempotent, no error.

```sql
create function public.fail_generation_attempt(
  p_attempt_id uuid,
  p_claim_token uuid,
  p_failure_category generation_failure_category,
  p_latency_ms integer,
  p_provider_request_id text
) returns text;  -- 'failed' | 'superseded'
```

Same CAS; double-fail and fail-after-supersession return `'superseded'`.

## Concurrency scenarios (review item 3, documented)

| Scenario | Outcome |
| --- | --- |
| Two users click simultaneously | Both claims serialize on the mention row lock; first inserts, second gets `in_progress` + `dedup_hits` incremented. One model call. |
| Request during a live attempt | `in_progress`, no token, no model call. |
| Lease expires while the worker still runs | Nothing happens until someone acts: a new claim closes the old attempt (`lease_expired`) and starts fresh. If the original worker finishes **before** any re-claim, its CAS still matches and the result is kept. |
| Worker finishes **after** a re-claim closed its attempt | CAS fails → `superseded`; the newer attempt's result is untouchable by the stale worker. |
| Completed draft already exists | `draft_exists` with the draft id; UI opens it. |
| Completion or failure submitted twice | Second call returns `superseded`; no duplicate draft (also structurally blocked: `ga_completed_shape` + one `response_draft_id`). |

## Draft lifecycle (review item 4 — no disguised rejection)

The decision vocabulary gains **`changes_requested`** (the review's stated
preference), replacing this phase's use of `rejected`:

- `alter type approval_status add value 'changes_requested';` —
  `'rejected'` stays in the enum, reserved for a future terminal reject;
  nothing writes it after this change.
- `decideResponseDraftInputSchema.decision` becomes
  `z.enum(["approved", "changes_requested"])`. The repository `decide`
  maps `changes_requested` → draft status `draft` (editable), approval row
  `changes_requested` + note, audit event **`response.changes_requested`**
  (new vocabulary entry + label; rides the audit migration).
- **Who**: `response.decide` holders (owner, admin, approver) — unchanged
  gate, accurately named action ("Request changes" in the composer; the
  confirm dialog explains the draft returns to the editor).
- **Editable after**: yes — status `draft` is the editable/decidable set
  (D108 unchanged). Editing does not re-route anything automatically;
  routing to review remains the existing assign/approval flow.
- **Regeneration**: still out of phase (D132); a mention with any draft is
  not generation-eligible, so "regenerate" cannot arise.
- **Audit**: `response.changes_requested` (decision), `response.edited`
  (subsequent edits), `response.approved` — the trail reads as what
  happened.

Migration/PR note: this renames the shipped "Send back" flow (PR #9
surface). The `response.rejected` audit event stays in the vocabulary for
history already written by seed/demo data; only the emission changes.

## Provenance (review item 2 — precise claim)

Stored per attempt: the **complete business context supplied to the model**
(the `DraftingContext` snapshot, verbatim, plus its hash) — *not* the
rendered wire messages. Reconstruction is: immutable prompt template at
`prompt_version` + snapshot → re-render → verify against
`rendered_system_hash` / `rendered_user_hash`. Also stored: provider,
model, `max_output_tokens`, `temperature` (null = provider default, the
client's current behavior), `output_schema_version`,
`provider_request_id` when the SDK exposes it, token counts, latency. Not
stored: credentials, headers, raw provider payloads, or any secret.

**Prompt immutability**: `DRAFTING_PROMPT_VERSION` plus a pin test — the
test records the sha256 of the template constants for the current version;
editing the template without bumping the version fails the suite (and the
hash recorded on attempts makes historical verification possible). The
analysis prompt's "bump on any output-moving change" doctrine, made
mechanical.

## DTO, prompt rules, and output validation (unchanged from v2)

`DraftingContext` / `DraftingVoiceSnapshot` exactly as v2 (narrow, pure
builder, snapshot = provider input verbatim). Untrusted-input framing and
the full safety rule set as v2 (D136), including the corrected boundary
rule: *raw provider errors and unvalidated provider output never reach a
user*. Validation gate as v2 (D137): trim; reject empty/whitespace,
> 1,500 chars (900 target in prompt; 5,000 stays storage ceiling),
preambles, alternatives, URLs/e-mails/phones, Markdown structure;
Unicode-safe. Invalid output → `fail_generation_attempt('invalid_output')`.

## Retention and redaction (review item 7)

The snapshot duplicates review text and reviewer names, so it is not
silently permanent:

- **Mechanism now, policy later**: migration 2 also ships
  `public.redact_generation_snapshots(older_than interval)` (server-only:
  execute revoked from `anon, authenticated`) which nulls `context`,
  `rendered_*_hash`-verifiable fields remaining intact — for attempts
  finished longer ago than the interval, leaving telemetry columns, hashes,
  `context_hash`, and the audit trail untouched. Operational integrity
  survives redaction; the personal data does not.
- **Unresolved policy decision (flagged, not silently chosen)**: the
  retention period. The function is callable from the existing cron surface
  once a period is chosen; nothing invokes it in this phase. The
  current-state ledger records this as an open operational item, alongside
  the repo's existing "no retention sweeper for sync runs" gap.
- **Organization deletion**: `on delete cascade` (house convention) —
  attempts die with the org.
- **Mention deletion**: cascade likewise; note the repo's standing gap that
  Google review deletions never propagate — when that lands, attempts
  follow their mention automatically.
- **What must survive redaction**: audit events (append-only, untouched),
  attempt states, hashes, telemetry counts.

## Permission matrix, telemetry, failure table

As v2, unchanged: `response.generate` = owner/admin/communications_lead
(now also DB-enforced); full role table as v2; the attempt table is the
telemetry store; edited-before-approval via `hasHumanEdit` join is the
quality metric; failure/retry table as v2 with `lease_expired` replacing
`timeout_expired`.

## Migration order and rollback

1. `<ts>_generation_attempts.sql` — enums, table, constraints, composite-FK
   backing uniques, indexes, RLS + revokes.
2. `<ts>_generation_functions.sql` — the three functions + redaction
   function + grants/revokes.
3. `<ts>_response_generation_vocabulary.sql` — audit constraint
   redefinition adding `response.generated` **and**
   `response.changes_requested`; `alter type approval_status add value
   'changes_requested'`.

Rollback: 1–2 are cleanly reversible (drop functions, drop table, drop
enums, drop the two backing unique constraints). 3 is partially
irreversible — Postgres cannot remove an enum value; rollback is "stop
emitting it" (application revert), which is why `changes_requested` is
additive and `rejected` is left in place. The audit-constraint
redefinition reverses by re-running the previous full list.

## Test plan (review item 8)

**Unit (vitest, node)** — as v2 (DTO, prompt incl. injection rendering,
validation incl. Unicode/malformed output, mock provider, permission
matrix every role, service with counting stub provider: dedup = zero
provider calls, retry-after-failure, default voice recorded, snapshot
frozen against post-claim mutation of voice/review) **plus** the prompt
version pin test.

**Real PostgreSQL, serialized proofs**
(`supabase/tests/generation-verification.sql`, psql, extending the
`rls-verification.sql` harness): direct INSERT/UPDATE/DELETE denied for
`authenticated` on `generation_attempts`; `claim_token` unreadable; claim
raises for every non-generating role and for cross-org callers; function
execution grants (anon denied everywhere; redaction denied to
authenticated); state-shape constraints reject invalid rows; composite FKs
reject cross-org mention/draft pairs; lease expiry closes and re-claims;
CAS: complete with wrong token / after supersession / twice →
`superseded`, and the newer attempt's row is byte-identical after the
stale write; completion writes draft + attempt + audit atomically and a
forced failure leaves no partial rows; `draft_exists` short-circuit.

**Real PostgreSQL, genuinely overlapping connections**
(`scripts/verify-generation-concurrency.ts`, new `npm run
db:verify-generation`; requires adding `pg` as a dev dependency — flagged
below): two connections; A opens a transaction and calls
`claim_generation_attempt`, holding the transaction open; B calls
concurrently and is observed to block on the mention lock; A commits; B
resolves to `in_progress` with `dedup_hits = 1`; exactly one pending row
exists; a stub "provider call" counter proves one generation. Repeated for
the expiry path (backdated lease) and the stale-worker completion path.
This is the review's "separate connections, real overlapping
transactions" requirement; the psql file cannot express it, the script
can.

## Acceptance criteria (measurable)

1. `db:verify-generation` (script + SQL file) passes against a reset local
   database, including the two-connection interleaving proofs.
2. Under a 2-connection concurrent-claim test, the provider-call counter
   reads exactly 1 and `generation_attempts` holds exactly 1 pending row.
3. `authenticated` cannot mutate `generation_attempts` directly (all three
   verbs fail), cannot read `claim_token`, and cannot execute the
   redaction function — proven in the SQL file, not asserted in prose.
4. A viewer/analyst/location-manager/approver calling the claim function
   gets a permission error raised by Postgres, with no attempt row created.
5. Every generated draft row has exactly one `completed` attempt and one
   `response.generated` audit event, created in the same transaction
   (forced-failure test shows zero partial writes).
6. A stale worker's complete/fail after supersession changes zero rows.
7. Editing the drafting prompt template without bumping
   `DRAFTING_PROMPT_VERSION` fails the unit suite.
8. `npm run verify` green; no existing test regresses.
9. The composer presents "Request changes", records
   `approval_status = 'changes_requested'` and audit
   `response.changes_requested` — grep shows no path writing `rejected`.
10. With no brand-voice row, generation succeeds and the attempt records
    `brand_voice_source = 'default'`.

## Phased implementation sequence

As v2's seven phases, with these deltas: phase 1 domain adds the three new
Postgres-mirrored vocabularies + `changes_requested` through the zod
decision schema; phase 2 becomes the three migrations + SQL file + the
`pg`-based concurrency script + npm script; phase 3's Supabase adapter
passes tokens through the typed claim/complete/fail results; phase 6 also
relabels the composer decision ("Request changes") and its confirm dialog.

## Conflicts and flagged items

1. **Composite FKs + backing unique constraints are a new pattern** for
   this schema (RLS alone carried tenant integrity until now). Additive
   and cheap; called out so it is a choice, not drift.
2. **`pg` dev dependency** for the concurrency script — the only way to
   hold two real overlapping transactions from the repo's tooling.
   Alternative (two `psql` processes with fifo coordination) is
   shell-fragile; the script is the safest option.
3. **`complete`/`fail` remain executable by `authenticated`, with the CAS
   token as the credential.** Alternative — service-role-only execution —
   would route completion through a server-only client, a bigger break
   from the current invoker model; the token (unguessable, unreadable,
   single-issue) achieves the ownership guarantee. Flagged in case the
   stricter posture is preferred.
4. **Unresolved by design**: retention period (mechanism ships, policy
   open); response-language override (v2's D135 interpretation stands —
   review-language with `defaultLanguage` as ambiguity fallback — awaiting
   explicit sign-off); status/failure reporting index deferred until an
   insights query exists.
5. **Sequencing**: branch follows PR #9 (composer surface).
