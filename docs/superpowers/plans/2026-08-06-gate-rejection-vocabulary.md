# Gate rejection vocabulary implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `gate_rejection_reason` into six values so a rejected news candidate records which of three different rules rejected it, instead of all three reporting `below_threshold`.

**Architecture:** Additive Postgres enum extension plus a matching TypeScript vocabulary, then three one-line changes to the `reason` field of existing `return` statements in the relevance gate. No condition, weight, or ordering in the gate moves — the admit/reject verdict for every input is identical before and after, which is what the unchanged verdict assertions in the existing tests demonstrate.

**Tech Stack:** TypeScript strict, Zod vocabularies, PostgreSQL enums via Supabase migrations, vitest, libpg-query (used by the drift test to parse migrations).

**Spec:** `docs/superpowers/specs/2026-08-06-gate-rejection-vocabulary-design.md`

## Global Constraints

- Sentence case in all user-facing copy, per `CLAUDE.md`.
- TypeScript strict with `noUncheckedIndexedAccess`. No `any` without a justifying comment.
- New values are **appended** to the Postgres type — `add value` without `before`/`after`, so no existing value's position moves. The TypeScript array is ordered for readability instead (the three score-bearing reasons grouped together), which is safe because the drift test compares them as sets, not sequences.
- Migration files use `add value if not exists`, matching `20260807000100`, not `20260806000300`'s bare `add value`.
- The migration number in this plan is `20260808000300`. Before applying, confirm against `supabase migration list` that nothing higher is already applied; if it is, renumber above it (D93).
- No behaviour change: no candidate that is admitted today may be rejected after this, or vice versa.

## File structure

| File | Change | Responsibility |
| --- | --- | --- |
| `supabase/migrations/20260808000300_gate_rejection_reason_vocabulary.sql` | Create | Adds the two enum values; refuses to run if `news_rejected_candidates` holds rows that would be left mislabelled. |
| `src/domain/enums.ts:526-531` | Modify | `GATE_REJECTION_REASONS` gains two values. |
| `src/lib/labels.ts` (`GATE_REJECTION_REASON_LABELS`) | Modify | Two human labels. Typed `Record<GateRejectionReason, string>`, so omitting one is a compile error. |
| `src/lib/monitoring/gate.ts:255,297,318` | Modify | Three `reason` values, plus the comments that currently justify sharing one. |
| `tests/audit-vocabulary-migrations.test.ts` | Modify | Third drift case: `gate_rejection_reason` vs `GATE_REJECTION_REASONS`. |
| `tests/relevance-gate.test.ts` | Modify | Re-point three assertions, rename two tests, add the high-score ambiguity case. |
| `docs/architecture/current-state.md` | Modify | Mark the defect closed; add the decision. |

`src/components/integrations/poll-run-history.tsx` is deliberately **not** in this list. It renders `GATE_REJECTION_REASON_LABELS[candidate.reason]` and needs no change.

---

### Task 1: Extend the vocabulary, driven by a drift test

**Files:**
- Create: `supabase/migrations/20260808000300_gate_rejection_reason_vocabulary.sql`
- Modify: `src/domain/enums.ts:526-531`
- Modify: `src/lib/labels.ts` — `GATE_REJECTION_REASON_LABELS`
- Test: `tests/audit-vocabulary-migrations.test.ts`

**Interfaces:**
- Consumes: `parseMigrations()`, `extractEnumCreation(stmts, typeName)`, `extractEnumAdditions(stmts, typeName)` — all already defined in `tests/audit-vocabulary-migrations.test.ts`.
- Produces: `GateRejectionReason` widens to include `"no_keyword_match" | "ambiguous_uncorroborated"`. Task 2 consumes both.

- [ ] **Step 1: Add the drift test for `gate_rejection_reason`**

Append inside the existing `describe("audit vocabulary vs. the Postgres migrations", ...)` block in `tests/audit-vocabulary-migrations.test.ts`, directly after the `audit_entity_type` test. Add `GATE_REJECTION_REASONS` to the existing `@/domain` import at the top of the file.

```ts
  // gate_rejection_reason is not an audit vocabulary, but it is the same class
  // of closed list with the same failure mode: a value added in TypeScript and
  // forgotten in the migrations type-checks perfectly and then violates an
  // enum constraint at runtime. It was outside this file's coverage for no
  // reason other than that nobody added it.
  it("keeps gate_rejection_reason in sync with GATE_REJECTION_REASONS", async () => {
    const files = await parseMigrations();

    let base: string[] | null = null;
    const additions: string[] = [];

    for (const file of files) {
      const creations = extractEnumCreation(file.stmts, "gate_rejection_reason");
      if (creations.length > 0) {
        if (base !== null) {
          throw new Error(
            "gate_rejection_reason was created more than once across the migrations.",
          );
        }
        base = creations[0] ?? null;
      }
      additions.push(...extractEnumAdditions(file.stmts, "gate_rejection_reason"));
    }

    expect(base).not.toBeNull();

    const final = new Set([...(base ?? []), ...additions]);
    expect(final).toEqual(new Set(GATE_REJECTION_REASONS));
  });
```

- [ ] **Step 2: Run it — it passes, which proves nothing yet**

Run: `npx vitest run tests/audit-vocabulary-migrations.test.ts`
Expected: PASS. Both sides currently hold the same four values, so a passing result here is a characterization, not evidence the check works.

- [ ] **Step 3: Prove the test can fail**

This repository has been bitten by checks that could not fail (the RLS harness needed its own self-test for the same reason). Temporarily add a fifth value to `GATE_REJECTION_REASONS` in `src/domain/enums.ts`:

```ts
  "below_threshold",
  "temporary_proof_value",
] as const;
```

Run: `npx vitest run tests/audit-vocabulary-migrations.test.ts`
Expected: **FAIL**, reporting the sets differ. Now remove `"temporary_proof_value"` again and re-run to confirm PASS before continuing.

- [ ] **Step 4: Add the two real values to the TypeScript vocabulary**

In `src/domain/enums.ts`, replace the `GATE_REJECTION_REASONS` declaration:

```ts
export const GATE_REJECTION_REASONS = [
  "excluded_term",
  "probable_syndication",
  "domain_denied",
  // Nothing in the query matched. The score is always 0, and the keywords —
  // not the threshold — are what an operator would change.
  "no_keyword_match",
  // Scored, and scored too low. The only reason of the three for which the
  // threshold is the lever.
  "below_threshold",
  // A lone short brand name with nothing corroborating it. Rejected
  // regardless of score, so a high score here is expected rather than
  // contradictory — see AMBIGUOUS_TERM_MAX_LENGTH in gate.ts.
  "ambiguous_uncorroborated",
] as const;
```

- [ ] **Step 5: Run the drift test to verify it now fails**

Run: `npx vitest run tests/audit-vocabulary-migrations.test.ts`
Expected: **FAIL** — TypeScript has six values, the migrations still declare four.

- [ ] **Step 6: Write the migration**

Create `supabase/migrations/20260808000300_gate_rejection_reason_vocabulary.sql`:

```sql
-- Split gate_rejection_reason so a rejected candidate records which rule
-- rejected it.
--
-- `below_threshold` was returned from three places in evaluateCandidate: no
-- keyword matched, a lone ambiguous term went uncorroborated, and a real score
-- fell under the query's threshold. Only the first was separable, and only by
-- its zero score. The first live GNews poll rejected four articles about a
-- salmonella outbreak at score 0.7 against a 0.35 threshold — all filed as
-- "below relevance threshold", which is false and points a reader at the one
-- dial that cannot fix it.
--
-- Labelling only. The gate admits and rejects exactly what it did before.

-- No backfill is possible, so refuse rather than mislabel. Every existing row
-- would need a guess at which of the three rules produced it, and the score
-- cannot recover that: 0.2 is equally "nothing matched" and "scored too low".
-- The table is empty as this ships. If it is not empty wherever this runs
-- next, that assumption has expired and the rows need a considered backfill,
-- not a silent one.
do $$
begin
  if exists (select 1 from public.news_rejected_candidates) then
    raise exception
      'news_rejected_candidates is not empty; existing rows cannot be classified into the new reasons. Write a backfill before applying this migration.';
  end if;
end
$$;

alter type gate_rejection_reason add value if not exists 'no_keyword_match';
alter type gate_rejection_reason add value if not exists 'ambiguous_uncorroborated';

comment on type gate_rejection_reason is
  'Lia''s own vocabulary. No provider supplies one of these. Each value maps to a different operator action: fix the keywords, tune the threshold, or revisit the ambiguity rule.';
```

- [ ] **Step 7: Add the two labels**

In `src/lib/labels.ts`, extend `GATE_REJECTION_REASON_LABELS` so it stays exhaustive (it is typed `Record<GateRejectionReason, string>`, so this is a compile error until done):

```ts
export const GATE_REJECTION_REASON_LABELS: Record<GateRejectionReason, string> = {
  excluded_term: "Matched an excluded term",
  probable_syndication: "Probable syndication",
  domain_denied: "Publisher domain not allowed",
  no_keyword_match: "No keyword match",
  below_threshold: "Below relevance threshold",
  ambiguous_uncorroborated: "Ambiguous name, not corroborated",
};
```

- [ ] **Step 8: Verify the vocabulary is consistent**

Run: `npm run db:validate && npx vitest run tests/audit-vocabulary-migrations.test.ts && npm run typecheck`
Expected: migration parses; drift test PASSES (six on both sides); typecheck clean.

- [ ] **Step 9: Commit**

```bash
git add supabase/migrations/20260808000300_gate_rejection_reason_vocabulary.sql \
        src/domain/enums.ts src/lib/labels.ts tests/audit-vocabulary-migrations.test.ts
git commit -m "Add the two missing gate rejection reasons"
```

---

### Task 2: Emit the new reasons from the gate

**Files:**
- Modify: `src/lib/monitoring/gate.ts:255,297,318` and the comments at 249-255 and 271-299
- Test: `tests/relevance-gate.test.ts`

**Interfaces:**
- Consumes: `GateRejectionReason` from Task 1, including `"no_keyword_match"` and `"ambiguous_uncorroborated"`.
- Produces: no new exports. `evaluateCandidate`'s signature is unchanged; only the `reason` string in three existing returns differs.

- [ ] **Step 1: Re-point the three existing assertions and rename two tests**

In `tests/relevance-gate.test.ts`, make exactly these four edits. Line 221 is deliberately untouched — "respects a raised threshold" is the one case that really is `below_threshold`.

Line 167, in `it("rejects an article matching nothing", ...)`:

```ts
    expect(verdict).toMatchObject({ admitted: false, reason: "no_keyword_match" });
```

Lines 296 and 301 — rename the test and re-point it:

```ts
  it("reports ambiguous_uncorroborated with a real score, not a non-match", () => {
    const verdict = evaluateCandidate(
      article({ title: "Bond markets rally", description: "Yields fell." }),
      context({ query: ambiguous }),
    );
    expect(verdict).toMatchObject({
      admitted: false,
      reason: "ambiguous_uncorroborated",
    });
    expect(verdict.score).toBeGreaterThan(0);
  });
```

Lines 483 and 495 — rename and re-point. This article matches no keyword, so it takes the `matched.size === 0` branch:

```ts
  it("reports no_keyword_match, not probable_syndication, for a non-matching article that shares a headline", () => {
```

```ts
    expect(verdict).toMatchObject({ admitted: false, reason: "no_keyword_match" });
```

- [ ] **Step 2: Add the case a live poll had to find**

Append inside the same `describe` block that declares `const ambiguous` at line 226 (so the fixture is in scope), after the test renamed above:

```ts
  // The case no existing test covered, and the reason this change exists. A
  // lone ambiguous term can score well above the threshold and still be
  // rejected, because corroboration is a hard requirement rather than a
  // weight. Reported as `below_threshold` this reads as a contradiction and
  // sends an operator to tune a dial that is not connected to anything.
  //
  // Modelled on the live poll: an eight-character brand name matching in both
  // title and description scored 0.7 against a 0.35 threshold.
  it("rejects a high-scoring ambiguous match without calling it below threshold", () => {
    const verdict = evaluateCandidate(
      article({
        title: "Chipotle pulls jalapeños after outbreak",
        description: "Chipotle removed the peppers from some restaurants.",
      }),
      context({ query: { ...QUERY, keywords: ["Chipotle"] } }),
    );

    expect(verdict.admitted).toBe(false);
    expect(verdict.score).toBeGreaterThan(QUERY.relevanceThreshold);
    expect(verdict).toMatchObject({ reason: "ambiguous_uncorroborated" });
  });
```

- [ ] **Step 3: Run the gate tests to verify they fail**

Run: `npx vitest run tests/relevance-gate.test.ts`
Expected: **FAIL** — four assertions still receive `"below_threshold"`.

- [ ] **Step 4: Change the three reasons in the gate**

In `src/lib/monitoring/gate.ts`, line 255 — replace the return and the comment above it:

```ts
  if (matched.size === 0) {
    // Genuinely nothing matched, and the score is 0 to say so. Its own reason
    // rather than a shared one: the operator action here is to fix the
    // keywords or accept that the provider is returning noise. Nothing about
    // the threshold or the ambiguity rule is involved.
    return { admitted: false, score: 0, reason: "no_keyword_match" };
  }
```

Line 297 — inside the `if (!locallyCorroborated)` block:

```ts
      return { admitted: false, score, reason: "ambiguous_uncorroborated" };
```

Line 318 stays exactly as it is. It is now the only place that returns `below_threshold`, and the only one for which the threshold is the lever.

- [ ] **Step 5: Rewrite the two comments that justified sharing one reason**

The ambiguity block's closing sentence at 283-284 currently reads "the candidate is rejected regardless of the numeric score or threshold, and the rejection carries the real score rather than zero (see above)." Replace that clause with:

```text
   * candidate is rejected regardless of the numeric score or threshold, and
   * the rejection is recorded as `ambiguous_uncorroborated` — its own reason,
   * carrying the real score. It used to share `below_threshold` with two
   * unrelated rules, which made a 0.7 rejection against a 0.35 threshold read
   * as a contradiction and sent operators to a dial that could not fix it. */
```

And in `AMBIGUOUS_TERM_MAX_LENGTH`'s doc comment, the sentence beginning "That is an acceptable v1 position only because the rejection is logged with its reason (D82)" is now true rather than aspirational. Extend it:

```text
 * those legitimate brands need a second keyword or an `allowedDomains` entry
 * to be admitted on their own name. That is an acceptable v1 position only
 * because the rejection is logged with its own reason (D82,
 * `ambiguous_uncorroborated`) and is therefore discoverable and tunable — it
 * must not be read as "short brand names work fine here." A live poll dropped
 * four articles about a salmonella outbreak at a real chain this way.
```

- [ ] **Step 6: Run the gate tests to verify they pass**

Run: `npx vitest run tests/relevance-gate.test.ts`
Expected: PASS, including the new high-score case.

- [ ] **Step 7: Verify no behaviour changed**

Run: `npm run verify`
Expected: lint, typecheck, all tests, and build clean. Every `admitted` assertion across the gate suite is untouched by this task — only `reason` strings changed. If an `admitted` expectation fails, a condition moved and the change is no longer labelling-only. Stop and re-read the diff.

- [ ] **Step 8: Commit**

```bash
git add src/lib/monitoring/gate.ts tests/relevance-gate.test.ts
git commit -m "Report which rule rejected a news candidate"
```

---

### Task 3: Apply to the hosted project and record the outcome

**Files:**
- Modify: `docs/architecture/current-state.md`

**Interfaces:**
- Consumes: the migration from Task 1, the gate behaviour from Task 2.
- Produces: nothing consumed by later tasks. This is the last one.

- [ ] **Step 1: Confirm the migration number is still free**

Run: `supabase migration list`
Expected: `20260808000300` appears in the Local column with an empty Remote column, and nothing numbered above it is already applied. If something is, renumber the file above the highest applied version and re-run `npm run db:validate` before continuing.

- [ ] **Step 2: Dry-run, then apply**

Run: `supabase db push --dry-run`
Expected: exactly one migration listed, `20260808000300_gate_rejection_reason_vocabulary.sql`.

Then run: `supabase db push`
Expected: applied without error. If it raises `news_rejected_candidates is not empty`, the guard has done its job — stop, and write a backfill rather than deleting rows to get past it.

- [ ] **Step 3: Verify the enum in the live database**

This inserts rejection rows directly rather than driving a live poll, which is a
deliberate departure from the spec's Verification note. A poll would prove the
same thing more slowly and less certainly: the GNews free tier rate-limits
aggressively, a poll only produces whichever reasons that day's articles happen
to trigger, and the gate's own emission is already pinned by Task 2's unit
tests. What is unproven after Task 2 is only whether Postgres accepts the two
new values, which is exactly what this probes.

`news_rejected_candidates.news_poll_run_id` is `not null` with a foreign key,
so the probe creates a parent run first and deletes it at the end — the
candidates cascade with it. Write this to a scratch file and run it with
`node --env-file=.env`:

```js
const { createClient } = require("@supabase/supabase-js");
const c = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY,
  { auth: { persistSession: false } },
);

(async () => {
  const { data: q } = await c
    .from("monitoring_queries")
    .select("id, organization_id")
    .limit(1)
    .single();

  // Column defaults give status 'running' with no completed_at and no error,
  // which is what news_poll_runs_running_is_clean requires.
  const { data: run, error: runError } = await c
    .from("news_poll_runs")
    .insert({ organization_id: q.organization_id, monitoring_query_id: q.id })
    .select()
    .single();
  if (runError) throw new Error(`could not create probe run: ${runError.message}`);

  const base = {
    organization_id: q.organization_id,
    monitoring_query_id: q.id,
    news_poll_run_id: run.id,
    url: "https://example.com/probe",
    title: "probe",
    publisher_domain: "example.com",
    score: 0.7,
    published_at: new Date().toISOString(),
  };

  let failures = 0;
  for (const reason of ["no_keyword_match", "ambiguous_uncorroborated", "below_threshold"]) {
    const { error } = await c
      .from("news_rejected_candidates")
      .insert({ ...base, external_id: `probe-${reason}`, reason });
    console.log(`${error ? "FAIL " : "ok   "}${reason}${error ? ` ${error.code}: ${error.message}` : ""}`);
    if (error) failures++;
  }

  const { error: bogus } = await c
    .from("news_rejected_candidates")
    .insert({ ...base, external_id: "probe-bogus", reason: "not_a_reason" });
  console.log(bogus ? `ok   unknown reason still rejected (${bogus.code})` : "FAIL unknown reason ACCEPTED");
  if (!bogus) failures++;

  // Cascades to every candidate above.
  await c.from("news_poll_runs").delete().eq("id", run.id);

  const { count } = await c
    .from("news_rejected_candidates")
    .select("*", { count: "exact", head: true });
  console.log(`\nnews_rejected_candidates rows remaining: ${count}`);
  process.exit(failures === 0 && count === 0 ? 0 : 1);
})();
```

Expected: the three real reasons insert, the invented one is rejected with
`22P02`, and 0 rows remain. `22P02` on a *real* reason means the migration did
not apply — check `supabase migration list` before assuming anything else.

- [ ] **Step 4: Confirm the seeded data is untouched**

The probe wrote to a seeded organization's query. Confirm nothing of it
survived beyond the cascade:

```bash
node --env-file=.env -e "
const {createClient}=require('@supabase/supabase-js');
const c=createClient(process.env.NEXT_PUBLIC_SUPABASE_URL,process.env.SUPABASE_SERVICE_ROLE_KEY,{auth:{persistSession:false}});
Promise.all([
  c.from('news_poll_runs').select('*',{count:'exact',head:true}),
  c.from('news_rejected_candidates').select('*',{count:'exact',head:true}),
  c.from('mentions').select('*',{count:'exact',head:true}),
]).then(([r,rc,m])=>console.log('poll_runs:',r.count,' rejected:',rc.count,' mentions:',m.count));
"
```

Expected: `poll_runs: 0  rejected: 0  mentions: 25` — the seed's mention count, unchanged.

- [ ] **Step 5: Update the architecture doc**

In `docs/architecture/current-state.md`, under "What the first live news poll showed about the gate", the paragraph beginning "**And one thing that is a real defect.**" now describes fixed behaviour. Replace that paragraph and the two that follow it with:

```markdown
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
```

Then add a decision row to the end of the "Decisions made integrating the branches" table:

```markdown
| D95 | Rejection reasons split three ways rather than one added | Only the ambiguity case was mislabelled, but the fix for it also retires an implicit convention: "score 0 means nothing matched" was load-bearing and documented only in a comment. Three reasons for three operator actions costs one extra enum value and makes each return site say what it means. |
```

- [ ] **Step 6: Final verification**

Run: `npm run verify`
Expected: lint, typecheck, all tests, build — all clean.

- [ ] **Step 7: Commit**

```bash
git add docs/architecture/current-state.md
git commit -m "Record the gate rejection vocabulary as applied"
```
