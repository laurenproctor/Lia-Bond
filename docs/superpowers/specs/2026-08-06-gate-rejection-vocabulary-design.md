# Gate rejection vocabulary

Split `gate_rejection_reason` so a rejected news candidate records *why* it was
rejected, rather than three different answers wearing one label.

Reporting only. The relevance gate admits and rejects exactly what it does
today; nothing about that changes here.

## The problem

`evaluateCandidate` in `src/lib/monitoring/gate.ts` returns
`reason: "below_threshold"` from three places:

| Line | Case | Score |
| --- | --- | --- |
| 255 | No keyword matched at all | always `0` |
| 297 | A lone ambiguous term with no corroboration | real, often high |
| 318 | Genuinely scored under the query's threshold | real, under threshold |

Case 1 is separable by its zero score. Cases 2 and 3 are not separable at all
without re-reading the query's `relevance_threshold` at display time, which no
reader does — `poll-run-history.tsx:126` renders
`GATE_REJECTION_REASON_LABELS[candidate.reason]` as a badge and nothing else.

The first live GNews poll made the cost concrete. A probe query for a real
brand returned five articles about a genuine salmonella outbreak. Four were
rejected at score `0.7` against a threshold of `0.35` — by the ambiguity rule,
because only the eight-character brand name matched — and every one of them
was filed as "below relevance threshold". Only the article whose headline
carried the full two-word company name was admitted.

**This is not a cosmetic mislabelling.** `AMBIGUOUS_TERM_MAX_LENGTH`'s own
comment accepts the short-brand-name trade-off *on the express grounds* that
"the rejection is logged with its reason (D64) and is therefore discoverable
and tunable". It is not discoverable. An operator reads `below_threshold` at
`0.7`, concludes the threshold logic is broken, lowers the threshold — and
nothing changes, because the corroboration rule never consulted it. The table
D64 created to make the gate falsifiable currently cannot distinguish
"irrelevant" from "on topic but uncorroborated", which is the one distinction
it exists to record.

A second consequence: ambiguity is checked before syndication, so four
near-identical wire copies of the same story were each stored as
`below_threshold` rather than `probable_syndication`. The dedupe rule never
ran on the clearest syndication case the live poll produced. Fixing the
labelling does not fix that ordering, but it does make it visible — which is
the precondition for deciding whether the ordering is wrong.

## The vocabulary

Six values. Each of the three current meanings gets its own, because each maps
to a different thing an operator would do next:

| Value | Emitted at | What it tells the operator |
| --- | --- | --- |
| `excluded_term` | unchanged | The query's own exclusion list did this. |
| `probable_syndication` | unchanged | Real story, already seen. |
| `domain_denied` | unchanged | Publisher is on the deny list. |
| `no_keyword_match` | gate.ts:255 | **New.** Nothing matched. The keywords are wrong, or the provider is returning noise. Nothing to tune in the gate. |
| `below_threshold` | gate.ts:318 | **Narrowed.** Scored, and scored too low. Tune the threshold or the weights. |
| `ambiguous_uncorroborated` | gate.ts:297 | **New.** On topic by name, but the name is short and nothing else corroborated it. Add a second keyword, allow-list the publisher, or revisit `AMBIGUOUS_TERM_MAX_LENGTH`. The score is *not* the lever. |

Splitting all three rather than only the ambiguity case also retires an
implicit convention. Today "score `0` means nothing matched" is load-bearing
and documented only in a comment; after this, the reason says it.

## Changes

**Migration** — `supabase/migrations/20260807000800_gate_rejection_reason_vocabulary.sql`.
Two statements, following the form already used in `20260807000100`:

```sql
alter type gate_rejection_reason add value if not exists 'no_keyword_match';
alter type gate_rejection_reason add value if not exists 'ambiguous_uncorroborated';
```

`if not exists` for idempotency, matching the existing precedent rather than
`20260806000300`'s bare `add value`.

**The number is provisional.** Onboarding work in flight at the time of
writing already holds `20260808000100` and `20260808000200`, unapplied. If
those land first, this one is renumbered above them rather than slotted
underneath — a version earlier than the last applied migration is the exact
shape of the collision D80 was written about, and the cost of renumbering is
nil while nothing has been pushed. Confirm against `supabase migration list`
immediately before applying, not against the filenames on disk.

**No backfill, and this is the moment that is true.** `news_rejected_candidates`
holds zero rows: the only rejections it ever held came from verification polls
that were cleaned up afterwards. Every existing row would otherwise have needed
a guess about which of the three cases produced it, and the score alone cannot
recover that — a `0.2` could be case 1 or case 3. The migration asserts the
table is empty rather than assuming it, so that if this ships against a
database that has since accumulated rows, it fails loudly instead of leaving
them mislabelled and indistinguishable.

**Domain** — two values appended to `GATE_REJECTION_REASONS` in
`src/domain/enums.ts`. Ordered to match the migration.

**Gate** — three one-line changes to the `reason` in existing return
statements. No condition moves, no weight changes, no reordering. The comments
at 249–255 and 271–299 that currently explain why one reason covers several
cases are rewritten to describe the split, and `AMBIGUOUS_TERM_MAX_LENGTH`'s
"discoverable and tunable" justification becomes accurate rather than
aspirational.

**Labels** — two entries in `GATE_REJECTION_REASON_LABELS`
(`src/lib/labels.ts`), sentence case per `CLAUDE.md`:

- `no_keyword_match` → "No keyword match"
- `ambiguous_uncorroborated` → "Ambiguous name, not corroborated"

`poll-run-history.tsx` needs no change: it indexes the map, and the map is
typed `Record<GateRejectionReason, string>`, so a missing label is a compile
error rather than an `undefined` badge.

## Testing

**Updated** — the assertions in `tests/relevance-gate.test.ts` that currently
expect `below_threshold` for the no-match and ambiguity cases. These are
re-pointed, not deleted; the admit/reject verdicts they assert stay identical,
which is the evidence that this change is labelling-only.

**New — the case that was missing.** A candidate that clears the threshold on
score and is still rejected by the ambiguity rule, asserting both
`admitted: false` and `reason: "ambiguous_uncorroborated"` and a score strictly
greater than the query's threshold. Nothing in the 42 existing gate tests
covers a high-scoring ambiguity rejection, which is why a live poll had to find
it. Modelled on the real case: an eight-character brand name matching in title
and description, scoring `0.7` against a `0.35` threshold.

**New — drift.** `tests/audit-vocabulary-migrations.test.ts` already parses the
migrations and pins `AUDIT_EVENT_TYPES` and `AUDIT_ENTITY_TYPES` against them.
It gains a third case for `gate_rejection_reason` against
`GATE_REJECTION_REASONS`. This is the test that would have caught the audit
vocabulary defect the branch merge introduced, and `gate_rejection_reason` is
currently outside its coverage for no reason other than that nobody added it.

## Out of scope

Named explicitly, because the live poll surfaced them together and they are
easy to conflate with this:

- `AMBIGUOUS_TERM_MAX_LENGTH` and whether eight characters is the right cut.
- The weights (`TITLE_MATCH`, `DESCRIPTION_MATCH`, `MULTI_KEYWORD_BONUS`,
  `LOCAL_OUTLET_BONUS`).
- Whether a strong title match should corroborate on its own.
- The ambiguity-before-syndication ordering.

All four are gate-*tuning* decisions that change what reaches a customer's
inbox. Every one of them wants real rejection data to judge against, and that
data is unreadable until this lands. That ordering is the argument for doing
this first and separately.

## Verification

Beyond the suite: apply the migration to the hosted project, run a live poll
against a query that reproduces the ambiguity case, and confirm
`news_rejected_candidates` now distinguishes the three. The previous live run
is the baseline — the same articles should be rejected, with different labels.
