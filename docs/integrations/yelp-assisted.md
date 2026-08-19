# Yelp Assisted

Companion to `docs/integrations/google-business-profile.md`. That one documents
a connector that reads reviews; this one documents a connector that deliberately
does not, and the product design that follows from it.

**Status: built, and not scheduled.** Every part of the feature works —
connection, activity detection, manual capture, drafting, assisted posting — and
the scheduled sweep is deliberately not wired to cron yet. See
[Rollout](#10-rollout) for why and what to do about it.

---

## 0. What Lia can actually see

Pinned at the top because it is the single claim most likely to be overstated on
a marketing page, in a capability card, or in a sales conversation:

> Lia sees a Yelp listing's **review count** and **star rating**. It never sees
> a Yelp review. Every Yelp review in Lia was typed in by a customer.

Everything below follows from that sentence. When Lia says "review activity
detected", it means one of those two numbers moved — nothing more. A review
count changes when reviews are **added, removed, or reclassified** by Yelp's
recommendation software, and Lia cannot tell which happened. Any copy implying
otherwise is wrong, and `src/lib/yelp/capabilities.ts` states the limitation in
the *enabled* state rather than only in the unconfigured one, precisely so a
working integration cannot read as a monitoring one.

## 1. Why assisted

Yelp splits its API into two products, and Lia holds one of them.

| | Fusion / Places | Partner (Respond to Reviews) |
| --- | --- | --- |
| Business search and match | ✅ | ✅ |
| Review count and rating | ✅ | ✅ |
| Full review text | ❌ (3 truncated excerpts) | ✅ |
| Review webhooks | ❌ | ✅ |
| Post a reply | ❌ | ✅ |
| How you get it | API key, self-service | Licensed partnership |

The Places plan is a key you paste in. The Partner API is a commercial
agreement, and Lia does not have one. So the product is built around the
capability that exists rather than around the one that would be convenient:

```
Lia checks the listing  →  a counter moves  →  Lia tells you
                                                    ↓
                              you look at Yelp and add the review
                                                    ↓
              analysis · rules · escalation · drafting · approval   (unchanged)
                                                    ↓
                     copy the reply  →  open Yelp  →  mark as posted
```

The middle of that pipeline is the whole point. A captured review is an
**ordinary mention** — same table, same classification, same escalation
eligibility, same drafting, same approval. There is no parallel pipeline for
typed content, because a parallel pipeline is how the guardrails stop applying
to exactly the source that most needs them: this content is unverifiable by
construction.

### What the excerpts endpoint would have bought, and why it is unused

Fusion's `/businesses/{id}/reviews` returns up to three review excerpts. It is
deliberately never called (`tests/yelp-provider.test.ts` asserts the client
never requests it). Truncated text with no stable per-review identity cannot
support classification, cannot be deduplicated across calls, and cannot be
answered accurately — and a method named `listReviews` returning it would put a
promise on the provider interface that every screen above would then have to
remember to qualify.

## 2. Configuration

| Variable | Required | Notes |
| --- | --- | --- |
| `YELP_API_KEY` | To use the feature | Server-only. Never prefix with `NEXT_PUBLIC_`. |
| `LIA_YELP_MODE` | To use the feature | `live` or `mock`. |
| `YELP_MAX_CHECKS_PER_SWEEP` | No | Defaults to 50. |

**`live` is explicit, not inferred.** Unlike Google — where a configured OAuth
client *is* the grant — a Yelp key belongs to a plan, and the plan decides which
endpoints answer. An operator can hold a valid key whose plan does not cover
business matching. So `LIA_YELP_MODE=live` must be set as well as the key, and
turning Yelp on stays a decision somebody took rather than a side effect of
pasting in a credential.

**`mock` is refused in production**, at the environment parse and again in the
resolver. The fabrication this guards against does not look like fabrication:
the mock hands out a review count and a rating, and a production deployment
serving them would not show a fake review — it would tell a customer a real
review had appeared on their real listing and ask them to go and find it.

### Getting a key

1. Create an app at `https://www.yelp.com/developers/v3/manage_app`.
2. Copy the API key. There is no client secret and no OAuth handshake.
3. Confirm the plan covers `/businesses/matches` and `/businesses/{id}`. A plan
   that does not answers `403`, which Lia reports as `plan_restricted` — a
   deliberately different code from `unauthorized`, because the remedy is a
   conversation with Yelp rather than re-pasting the key.

### Rate limits

Yelp meters **per API key**, on a daily allowance that depends on the plan. The
key is Lia's and is shared by every tenant, so the budget is a Lia-level
resource — the same position D79/D85 put the news budget in, and enforced the
same way: above the tenant loop, in `sweepYelpListings`, with the interactive
connect flow living on the remaining headroom. One organization with forty
listings cannot exhaust the day for everybody else.

## 3. Connecting a listing

`/integrations/yelp/connect`. Pick a location, and Lia searches Yelp using that
**location's own stored name and address** — never anything typed into the
browser. A crafted request cannot use Lia's key to enumerate Yelp.

Two searches, in order:

1. `/businesses/matches` — the address-driven question, "is this exact business
   on Yelp".
2. `/businesses/search` — a wider term-and-city fallback, used only when the
   first returns nothing. A strict match that silently comes back empty reads
   to a customer as "my restaurant is not on Yelp" when it plainly is.

Candidates are **ranked and never auto-applied**, and each row shows the address,
the phone number, and the reasons it scored. Two candidates within 0.1 of each
other are both flagged ambiguous — a restaurant group's two nearby branches is
the realistic case, and marking them says the signals did not separate these.

### This is a mapping, not an authorization

A Yelp Places key authenticates **Lia**. It proves nothing about whether the
customer owns the listing they are pointing at. There is no business-owner
OAuth in this integration, and no copy anywhere calls the result a connected
*account*. The connection card, the capability table, and the connect screen all
say so.

### What guarantees what

| Invariant | Enforced by |
| --- | --- |
| One external listing per tenant | `platform_profiles_unique_external` (unique index) |
| One listing per location | Application check in `connectYelpListing` — see [Known limitations](#11-known-limitations) |
| Cross-tenant isolation | Repository scoping + RLS on every table |

## 4. Review-activity detection

A check reads the listing and compares two numbers with the last two Lia saw.

| Situation | What Lia records |
| --- | --- |
| First check | A baseline snapshot. **No activity.** |
| Nothing moved | A snapshot. No occurrence. |
| Count up / down | One occurrence, worded as a count change |
| Rating moved only | One occurrence (this is what an edited review looks like) |
| Both moved | One occurrence |
| Yelp omitted a counter | A snapshot with `null`. **No occurrence.** |
| Yelp failed | A failed run. **No snapshot, no occurrence, baseline untouched.** |

The last two rows are the ones that matter most. A `null` counter is Lia failing
to observe, not the listing moving — treating `128 → null` as a decrease would
announce that every review had been deleted off the back of a provider hiccup.
And a failed check must not move the baseline, or the *next* successful check
reports a change that never happened.

### What "review activity detected" means

It means a number changed. It does not mean a review arrived. The data model
carries no field for a count of new reviews, and that absence is deliberate: a
column called `new_review_count` would be a lie in the schema, quoted back by
every screen and report that ever read it.

### Idempotency and concurrency

Two database guarantees, neither of which is an application check:

- **`platform_sync_runs_one_active (platform_profile_id, resource)`** — at most
  one check per listing at a time. The insert *is* the lock. A concurrent check
  is reported as `skipped`, never as a failure, so one busy listing cannot fail
  a whole sweep. The `resource` column (`listing_activity`) keeps this lock
  separate from a Google review sync of the same profile.
- **`yelp_activity_occurrences_unique_transition`** — at most one occurrence per
  observed pair of snapshots. Two workers that see the same change race to
  insert; one wins, the loser reads the winner's row and reports
  `created: false`, so one change produces one notice and one audit event.

## 5. Manual review capture

From an activity occurrence, or from the listing panel directly.

Captured: source, listing, rating, full text, and optionally a reviewer name, a
review date, and a link. Stamped by the server and unreachable from the request:
`capture_method = 'manual_entry'`, the capturing actor, and the capture instant.

**A sync can never relabel a typed review as retrieved, or the reverse.** The
provenance columns are absent from `IngestMentionInput` and from
`SOURCE_OWNED_MENTION_FIELDS`, and `mentions_capture_actor_pairing` refuses the
combinations that would misrepresent them.

### The deduplication contract

`mentions_unique_external (platform_connection_id, source_type, external_id)`
is what prevents a duplicate, and it is `not null` — so a captured review needs
an external id that Yelp never gave. Two derivations, in preference order:

1. **A normalised review URL**, when supplied. A real Yelp-assigned identifier,
   canonicalised so two people pasting the same review from different places
   produce one key.
2. **Otherwise a documented fingerprint** over `rating + normalised text +
   normalised author + review date`. Case-, punctuation-, and smart-quote
   insensitive. Author and date are in it because two diners writing "Great!" is
   the realistic collision.

A match is reported as an **outcome, not an error**: the interface shows the
review Lia already holds and offers an explicit override. Nothing merges
silently, and the override is recorded in the audit event.

Deliberately conservative: a review captured once with a URL and once without
produces two keys. Under-merging is recoverable by a person; over-merging
silently folds one customer's complaint into another's.

## 6. Drafting

Unchanged. The existing brand-voice drafting path handles a captured Yelp review
exactly as it handles a Google one — there is no second AI path.

Yelp's response policy applies to what gets drafted: no marketing offers, no
requests to join a mailing list, nothing abusive, professional and individual,
and no claims unsupported by the review or the business context.

## 7. Assisted posting

Three controls on an approved draft, and the distinctions between them are the
feature:

| Control | What it does | What it changes |
| --- | --- | --- |
| **Copy response** | Clipboard write | **Nothing.** No server action exists. |
| **Open in Yelp** | Anchor to a validated URL | **Nothing.** |
| **Mark as posted** | Records your confirmation | `approved` → `published` |

**Copying and opening cannot publish**, and the guarantee is structural: there
is no code path from either to a status change.

**Open in Yelp** resolves the most specific trusted destination — the review's
own URL if one was captured, otherwise the connected listing — re-validated
against the Yelp host allowlist at the last moment before it becomes a link, and
rendered with `rel="noopener noreferrer"`. No trusted URL means no link and a
sentence saying so, rather than a guessed page: sending somebody to the wrong
restaurant's Yelp page to post a reply is worse than sending them nowhere.

### What "marked as posted" records, and what it does not

It records: the confirming person, the moment, and
`publication_method = 'manual_external'`.

It does not record, and cannot: any acknowledgement from Yelp.
`external_response_id` stays null permanently on this path, enforced by
`response_drafts_external_id_requires_provider` — a provider-assigned identifier
can only come from a provider publication. That constraint is what stops a
user-confirmed publication ever being read as provider-verified.

Confirmation is **idempotent** (guarded on `status = 'approved'` in the WHERE
clause, so a second click matches no rows) and **correctable** — see below.

### Correcting a mistake

"Not posted after all" returns the draft to `approved` and clears the
provenance. It requires a reason, which is recorded.

This is deliberately **not** a retraction. A retraction means a published reply
was taken down from the platform; this means the reply was never posted and
Lia's record was wrong. Naming them the same thing would put "we removed a bad
reply" and "somebody mis-clicked" in one bucket, and the first is the one that
has to be provable later. The correction path also refuses to touch a
`provider_api` publication, so a real publication can never be rewritten as a
mistake.

## 8. Security and tenancy

| Concern | How |
| --- | --- |
| API key secrecy | `Authorization` header built per request, never in a URL, a log, an error, or a returned value. Asserted in `tests/yelp-provider.test.ts`. |
| Provider text leakage | Every stored error is a Lia-authored sentence from `YELP_ERROR_MESSAGES`, keyed by code. Yelp's 400 body quotes the request back, and a match request carries a customer's address. |
| Tenant isolation | Every repository method takes an `OrganizationScope`; RLS on both new tables; the sweep builds a scope from each row's own organization id (D88). |
| Fabricated evidence | `yelp_listing_snapshots` and `yelp_activity_occurrences` are select-only for `authenticated`. A member who could insert either could plant a baseline or invent activity. |
| External URLs | Allowlisted hosts, `https` only, no credentials, query and fragment dropped. Validated at write **and** at render. |
| Input size | Review text capped at 5,000 characters; every field bounded at the schema. |
| Unbounded work | Sweep bounded by `YELP_MAX_CHECKS_PER_SWEEP`; terminal provider failures abort the pass rather than writing forty identical failure rows. |
| Disconnect safety | Marks the profile `disconnected`. Destroys no mention, snapshot, occurrence, draft, or audit row. |

### Permissions

| Action | Permission | Roles |
| --- | --- | --- |
| Connect / disconnect a listing | `integration.manage_profiles` | owner, admin, communications lead |
| Check a listing now | `monitoring.poll_now` | owner, admin, communications lead |
| Add a review, dismiss activity | `mention.capture_manual` | owner, admin, communications lead |
| Mark as posted / withdraw | `response.confirm_publication` | owner, admin, communications lead |

`mention.capture_manual` is its own permission rather than a reuse of
`integration.sync_reviews`: relaying what a provider returned and asserting
content nothing can verify are different acts, and the obvious future
divergence — a location manager adding their own restaurant's review — is
something an organization-wide sync permission could never express.

`response.confirm_publication` is deliberately not the same list as
`response.decide`. The separation between signing text off and being the sole
witness that it went public would be hollow if the approver held both.

## 9. Operational runbook

### Invalid or rotated API key

**Symptom.** Every check fails with `unauthorized`. The sweep aborts early.
**Do.** Update `YELP_API_KEY` and redeploy. Nothing is lost: baselines are
intact, and the next successful check compares against the last good snapshot,
so a change that happened during the outage is still detected.

### Plan restriction

**Symptom.** `plan_restricted` rather than `unauthorized` — a `403`.
**Do.** Check what the Yelp plan covers. Re-pasting the key will not help; this
is a commercial limit, not a credential problem.

### Rate limited

**Symptom.** `rate_limited`; the sweep aborts early with `aborted_early: true`.
**Do.** Nothing urgent — it clears by itself. If it recurs daily, lower
`YELP_MAX_CHECKS_PER_SWEEP` or raise the Yelp plan. Baselines are untouched.

### Listing removed or merged

**Symptom.** One listing fails with `business_not_found` while others succeed.
**Do.** Look the business up on Yelp. If it was merged, disconnect the old
listing and connect the surviving one — captured reviews, responses, and audit
history stay on the location regardless. If it was removed, disconnect it.

### A previously connected business stops being returned

Same signature as above and the same first step. If Yelp still shows the page
but the API does not return it, the plan or the business id has changed; check
the id on the connection panel against the URL on Yelp.

### Repeated check failures

**Do.** Read `platform_sync_runs` filtered to `resource = 'listing_activity'`.
Every attempt is recorded with a normalised `error_code` — a run history is what
distinguishes "nothing is happening at this restaurant" from "checks have been
failing for a week".

```sql
select started_at, status, error_code, error_message
  from public.platform_sync_runs
 where resource = 'listing_activity'
   and platform_profile_id = '…'
 order by started_at desc
 limit 20;
```

### Conflicting location mapping

**Symptom.** Connecting is refused: the location already has a listing.
**Do.** Disconnect the existing one first. If two locations appear to share a
listing, `platform_profiles_unique_external` should have prevented it — treat
that as a bug and capture the rows before changing anything.

### A customer disputes a manually confirmed publication

The honest answer is that **Lia never verified it**, and the record says so.

```sql
select rd.id, rd.published_at, rd.publication_method, rd.published_by_user_id
  from public.response_drafts rd
 where rd.id = '…';

select occurred_at, actor_user_id, event_type, metadata
  from public.audit_events
 where entity_type = 'response_draft' and entity_id = '…'
 order by occurred_at;
```

`publication_method = 'manual_external'` with a null `external_response_id` means
a named person stated they posted it. `response.publication_confirmed` names who
and when; a later `response.publication_unconfirmed` names who withdrew it and
why. Nothing in that trail claims Yelp confirmed anything — by construction,
because the schema has nowhere to put such a claim on this path.

## 10. Rollout

The scheduled sweep exists (`/api/cron/yelp-listing-check`) and is **not in
`vercel.ts`**. The hosting account is on Vercel's Hobby plan, which caps both
cron frequency and the number of cron jobs per project, and two are already
scheduled; adding a third would fail the deploy at config validation rather than
at runtime.

Until the account moves to Pro, checks run from the **Check for activity**
control on the integration screen — the same service, the same lock, the same
idempotency, only a different trigger. That is why the control is a first-class
part of the UI rather than a developer affordance: the two paths cannot drift
apart while one of them waits on a billing change.

**To turn the schedule on**, add one line to `vercel.ts`:

```ts
{ path: "/api/cron/yelp-listing-check", schedule: "0 7 * * *" },
```

Nothing else changes. `CRON_SECRET` already guards the route.

### Rollback

Migrations are additive with safe defaults; every existing row reads as
`capture_method = 'provider_api'`, which is true of all of them.

1. **Feature off, data intact.** Unset `LIA_YELP_MODE`. The integration screen
   says Yelp is not configured, no checks run, and everything already captured
   stays in the inbox. This is the first move for any problem.
2. **Forward-repair.** This repository has no down migrations. Removing the
   schema means a new migration that drops `yelp_activity_occurrences` and
   `yelp_listing_snapshots` and restates the previous `audit_events` check
   constraint. Postgres cannot remove an enum value, so
   `audit_entity_type.yelp_activity_occurrence` simply stops being written.
3. **Keep the `mentions` and `response_drafts` columns.** Dropping them destroys
   capture provenance and publication provenance for records that still exist —
   the reviews somebody typed in would silently become indistinguishable from
   imported ones.

## 11. Known limitations

- **One-listing-per-location is an application check, not a constraint.** A
  partial unique index would need `platform = 'yelp'` in its predicate, and the
  platform lives on `platform_connections` — Postgres refuses a subquery in an
  index predicate, so the only route to an index is denormalising `platform`
  onto `platform_profiles`, a table three other integrations share. The
  direction that actually matters (one external listing per tenant) *is*
  database-enforced. Revisit if a second assisted provider wants the same rule.
- **The live Yelp API has never been called from this repository.** Same
  position workflow 02 was in with Google: every test stubs `fetch`.
- **Location phone numbers are not compared.** `locations` still has no phone
  column. The weight is wired and tested in `scoreYelpCandidate`, waiting on the
  column — it is the strongest signal Yelp returns.
- **Snapshots accumulate with no retention policy.** Two integers per listing
  per check. A sweep will be wanted eventually; the mechanism does not exist yet
  (the same posture D169 took for generation snapshots).
- **The seed's three published drafts carry fabricated `gbp-reply-*`
  identifiers**, which assert a Google publishing capability Lia does not have.
  That predates this feature; the publication-method derivation in
  `dataset.ts` makes the assertion visible rather than creating it, and it is
  worth revisiting separately.

## 12. The upgrade path

A licensed Partner integration adds capability; it does not replace anything
here.

| Future capability | What changes |
| --- | --- |
| Business-owner OAuth | A real `external_account_id` on the existing connection, and credentials in the existing vault. The connection row, its profiles, and every mapping survive. |
| Claimed-location discovery | A new method on `YelpPlacesProvider`. The connect flow gains a "listings you own" path beside the search. |
| Full review ingestion | `canReadFullText` becomes true; reviews arrive through `mentions.ingest` with `capture_method = 'provider_api'`. Captured reviews stay `manual_entry` forever, which is what keeps the two distinguishable. |
| Review webhooks | `supportsWebhooks` becomes true. Activity occurrences become redundant for listings that receive them and can be left to lapse per listing rather than removed. |
| Direct publishing | `canPublishResponses` becomes true, so `resolvePublishingMode` returns `direct` and the assisted panel stops rendering — no code deleted. New publications write `publication_method = 'provider_api'` with a real `external_response_id`. |
| Provider-confirmed publication | Already expressible. `RESPONSE_PUBLICATION_METHODS` has carried `provider_api` from the start for exactly this. |

Nothing above requires migrating a captured review, re-mapping a listing, or
discarding a manual publication record. The two publication methods coexist
permanently, because the history of what a person confirmed by hand stays true
after the API arrives.

## 13. Sources

- [Yelp Fusion API documentation](https://docs.developer.yelp.com/docs/fusion-intro)
- [Business Match endpoint](https://docs.developer.yelp.com/reference/v3_business_match)
- [Yelp Partner APIs](https://www.yelp.com/developers/v3/manage_app) — the
  Respond to Reviews capability Lia does not hold
