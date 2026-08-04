# Brand voice configuration

Design document. Written 2026-08-04, before implementation.

## Summary

Promote brand voice from a typed fixture to a real, editable, persisted
configuration: a `brand_voice_profiles` table with row-level security, a
repository method on both adapters, a permission, an audited server action, and
an editable screen.

**This does not generate a single word of customer-facing text.** Response
generation does not exist yet. This makes the settings real and stores them; the
payoff arrives with drafting.

## Why now, and what it supersedes

Decision D34 deferred this table on the grounds that "promoting it now would
ship a table nothing queries; it becomes real in workflow 05, where it drives
generation."

That reasoning was sound and is now partly overtaken. The screen at
`/brand-voice` presents itself as configuration — five sliders, two phrase
lists, a "Save changes" button — and none of it does anything. Every control is
a static `<span>`; the save button has no handler. A configuration screen that
silently discards input is a worse artifact than a table with one reader, and
the honest alternatives were to make it work or to remove it.

The concession to D34 stands in one respect: this ships **no** generation. The
`AiProvider` boundary keeps its single method, and `draftResponse()` remains
workflow 05's to shape.

**This document supersedes D34.** `docs/architecture/current-state.md` is
maintained precisely enough that leaving the contradiction unrecorded would be
worse than the change.

## Decisions taken

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

## Data model

### Migration `20260806000100_brand_voice.sql`

```sql
create table public.brand_voice_profiles (
  id                  uuid primary key default gen_random_uuid(),
  organization_id     uuid not null unique
                        references public.organizations(id) on delete cascade,
  name                text not null,

  axis_warmth         smallint not null default 45 check (axis_warmth between 0 and 100),
  axis_detail         smallint not null default 40 check (axis_detail between 0 and 100),
  axis_formality      smallint not null default 55 check (axis_formality between 0 and 100),
  axis_confidence     smallint not null default 44 check (axis_confidence between 0 and 100),
  axis_hospitality    smallint not null default 35 check (axis_hospitality between 0 and 100),

  approved_phrases    text[] not null default '{}'
                        check (public.brand_voice_phrases_valid(approved_phrases)),
  prohibited_phrases  text[] not null default '{}'
                        check (public.brand_voice_phrases_valid(prohibited_phrases)),

  version             integer not null default 1 check (version > 0),
  updated_by_user_id  uuid references public.users(id),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
```

The `unique` on `organization_id` is the enforcement of D61: a second profile
is a constraint violation rather than a silent ambiguity about which one wins.

Array bounds hold for any writer, not only the ones that go through the zod
schema — at most 20 phrases per list, each 1 to 80 characters. A check
constraint may not contain a subquery, so the per-item test lives in an
immutable helper declared ahead of the table:

```sql
create function public.brand_voice_phrases_valid(phrases text[])
  returns boolean
  language sql
  immutable
  parallel safe
as $$
  select cardinality(phrases) <= 20
     and not exists (
       select 1 from unnest(phrases) as p
       where length(p) < 1 or length(p) > 80
     );
$$;
```

Postgres does not re-validate existing rows if that function is later changed,
so tightening the limits means an explicit `alter table ... validate
constraint` rather than an edit in place. Recorded because a check constraint
calling a function looks like it enforces the current definition and does not.

### RLS — `20260806000200_brand_voice_rls.sql`

Follows the `analysis_runs` shape exactly:

- `select` — any active member. Knowing how the product is configured to speak
  is not a privileged question.
- `insert` and `update` — `owner`, `admin`, `communications_lead` via
  `has_organization_role`, restating D65 in SQL rather than trusting the
  application to be the only writer.
- No `delete` policy, and `delete` is revoked. There is no product action that
  removes a voice; resetting means saving defaults, which keeps the audit trail.

### Seed

`src/lib/seed/dataset.ts` gains one profile for the demo organization, carrying
the values currently in `src/lib/fixtures/brand-voice.ts`. `supabase/seed.sql`
is regenerated with `npm run db:seed:generate` — never hand-edited (D3).

`src/lib/fixtures/brand-voice.ts` is deleted. Its type moves to the domain.

## Domain

`src/domain/entities/brand-voice.ts`:

- `BRAND_VOICE_AXES` — the single declaration of the five axis keys and their
  pole labels. The form, the summary, and the eventual prompt all read it, so
  adding an axis cannot leave one of the three behind.
- `brandVoiceProfileSchema` — the record as stored.
- `updateBrandVoiceInputSchema` — what the action accepts.
- `DEFAULT_BRAND_VOICE` — the starting point for an organization with no row
  (D64).

Input validation rejects four things:

1. An axis value outside 0–100, or not an integer.
2. A phrase that is empty after trimming, or over 80 characters.
3. Duplicate phrases within a list, compared case-insensitively after trimming.
4. A phrase present in both lists (D68).

Phrases are trimmed and deduplicated before storage, so the same input always
produces the same row.

## Derivation

`src/lib/brand-voice/summary.ts` — a pure function from axis values to
plain-language lines. No I/O, no framework imports, unit-testable as itself.
Each axis contributes one line chosen by band, and the bands are declared as
data next to the axis definition rather than as a chain of conditionals.

## Repository

```ts
brandVoice: {
  get(scope: OrganizationScope): Promise<BrandVoiceProfile | null>;
  save(scope: OrganizationScope, input: UpdateBrandVoiceInput): Promise<BrandVoiceProfile>;
}
```

Scoped like every other method: there is no way to ask for a profile without
naming an organization.

`save` is an upsert on `organization_id`. It compares the incoming values
against the stored row and, when nothing differs, returns the existing row
unchanged — no `version` bump, no `updated_at` change (D63). Both adapters
implement the same comparison, and the demo adapter is where it is tested.

## Save service and server action

Split in two, following `analyzeMentions` rather than
`setAutomationRuleEnabledAction`. The reason is testability: nothing under
`tests/` imports `@/app/actions`, and the repository has no mocking
infrastructure at all, so logic inside an action is logic no test can reach. The
service takes an already-authorized context and is the tested unit; the action
authorizes, calls it, and revalidates.

```text
updateBrandVoiceAction                       src/app/actions/brand-voice.ts
  └─ runAction("brand_voice.update")
       └─ updateBrandVoiceInputSchema.parse(input)   ← before the role check
       └─ authorize("brand_voice.update")
       └─ saveBrandVoice(context, input)      src/lib/brand-voice/save.ts
            └─ brandVoice.get()               ← previous state, for the diff
            └─ brandVoice.save()
            └─ recordAuditEvent()             ← skipped when nothing changed
       └─ revalidatePath("/brand-voice")
```

Parsing precedes the role check so malformed input is reported as a validation
error whoever sends it, rather than as "forbidden" for a payload that was never
valid.

The audit event carries the previous and new state. Phrase lists are
organization-authored configuration, not customer data, so they are recorded in
full — the rules keeping review text and reviewer names out of audit events are
not engaged here.

## User interface

The page stays a server component. It reads the profile (or defaults), reads
the connected platforms for the channel card, and passes both down. Extraction
keeps it far below the 300-line limit.

| Component | Kind | Responsibility |
| --- | --- | --- |
| `brand-voice/voice-form.tsx` | client | Owns all editable state, dirty tracking, submission |
| `brand-voice/axis-slider.tsx` | client | One labelled `<input type="range">` |
| `brand-voice/phrase-editor.tsx` | client | Add and remove chips; used twice |
| `brand-voice/voice-summary.tsx` | client | Derived lines, recomputed as sliders move |
| `brand-voice/channel-scope.tsx` | server | Read-only connected platforms (D67) |

Sliders are real `<input type="range">` elements, so keyboard operation and
screen-reader announcement come from the platform rather than from a
reimplementation. Each carries a visible value and an accessible label naming
both poles.

Three changes to what is on screen today:

1. **Save moves from the page header into a sticky bar inside the form**,
   reading "Unsaved changes — Discard / Save changes". The header button cannot
   observe the client form's dirty state without lifting that state above the
   form or introducing context for one control. A configuration screen that
   cannot tell you it has unsaved edits is the more common failure anyway.
2. **"Preview responses" is removed** (D69).
3. **The "these settings are not stored yet" notice is deleted**, because it
   stops being true. The live-preview card remains a placeholder, with copy
   stating that generation has not arrived rather than implying it has.

## Error handling

The action returns `ActionResult`, as every action does. The form surfaces
three cases distinctly, because the remedies differ:

- **Validation** — field-level messages, no request made.
- **Permission** — the form renders read-only for a role without
  `brand_voice.update`, so the failure is prevented rather than reported. The
  server still authorizes; the read-only render is an affordance, not the check.
- **Failure** — an inline message with the edits preserved. Losing somebody's
  tuning because a request failed is not an acceptable outcome for a screen
  whose entire purpose is accumulating small adjustments.

## Testing

`npm run verify` (lint, typecheck, vitest, build) and `npm run db:validate` for
migration parsing.

### Pure, no I/O

- `tests/brand-voice-domain.test.ts` — axis bounds, trimming, case-insensitive
  dedupe, the both-lists contradiction, defaults.
- `tests/brand-voice-summary.test.ts` — band boundaries, and that every axis in
  `BRAND_VOICE_AXES` contributes a line.
- `tests/permissions.test.ts` — extended for the `brand_voice.update` row,
  including that analysts and viewers hold it nowhere.

### Repository round-trip

- `tests/repositories.test.ts` — extended: absent row reads as `null`, first
  save inserts at version 1, a changed save bumps to 2, a no-op save leaves
  both `version` and `updated_at` alone.

### Save service

- `tests/brand-voice-save.test.ts` — a successful save persists and records
  exactly one attributed audit event; the event carries only the fields that
  moved; a no-op save records none and leaves the version alone; a creation
  records a null previous state; one organization's trail stays out of
  another's.

The role check is **not** tested here. It lives in the action, via
`authorize()`, and the matrix behind it is covered by `tests/permissions.test.ts`
— the same boundary every other action in the repository has.

## Non-goals

- Response generation, and any `draftResponse()` method on `AiProvider`.
- A working live preview. The card stays a placeholder.
- Per-location voice overrides (D61).
- Voice versioning history or rollback. `version` is a counter for draft
  provenance, not a revision log.
- Backfilling `response_drafts.brand_voice_version` for existing rows. They
  were generated by no voice at all, and writing a version into them would
  claim provenance that does not exist.

## Known risks

- **The Supabase write path will only have been exercised against the demo
  adapter**, the same position the sync and analysis writes are in. The RLS
  policies are verifiable with `npm run db:verify-rls`.
- **The axis taxonomy is a guess** until generation reads it. Five paired
  sliders are inherited from the fixture and the reference screens; whether they
  are the right five is unanswerable before a prompt consumes them. Named
  columns make changing the set a migration, which is a visible cost rather than
  a silent one.
- **Nothing reads the table yet.** This is D34's objection, accepted with open
  eyes: the alternative was leaving a screen that discards input.

## The boundary for workflow 05

Generation reads the profile through `dataSource.brandVoice.get(scope)`, stamps
`response_drafts.brand_voice_version` with the profile's `version`, and adds
`draftResponse()` to `AiProvider`. Nothing in this document constrains the
shape of that prompt.
