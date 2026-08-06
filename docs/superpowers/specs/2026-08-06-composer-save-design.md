# Composer edits that actually persist

Design document. Written 2026-08-06, before implementation.

## Summary

The response composer's textarea is fully editable, and everything typed into
it is discarded: "Save draft" is hard-disabled, and approve sends only
`{responseDraftId, decision}`. This sub-project makes edited text real —
saved explicitly, carried atomically by approval, locked once a decision is
made, and audited.

Publishing stays untouched: the publish button remains disabled and no
publishing capability is implied anywhere (the existing capability copy is
already honest about this).

## What exists and is reused

- `ResponseDraft.finalText` — the column already exists and the UI already
  reads it (`hasHumanEdit`, the responses pane's "Original AI draft" section,
  the "Human-edited" metric). Nothing writes it.
- `APPROVABLE_DRAFT_STATUSES` (`draft`, `awaiting_approval`) and
  `canDecideOnDraft()` — the exact status set that should also gate editing.
- The action pattern in `src/app/actions/responses.ts`: zod-parse →
  `authorize(permission)` → repository method → `diff()` + audit event →
  `revalidatePath`.
- The audit-vocabulary mirror: `AUDIT_EVENT_TYPES` in `src/domain/enums.ts`
  and the DB check constraint, pinned together by
  `tests/audit-vocabulary-migrations.test.ts`.
- The permission matrix (`src/lib/auth/permissions.ts`) — pure, one table.

## Decisions taken

| # | Decision | Reason |
| --- | --- | --- |
| D107 | Approve carries the composer's current text: `decideResponseDraftAction` accepts an optional `finalText`, applied in the same repository write as the decision | What the approver saw in the confirmation dialog is exactly what gets approved. The alternative — blocking approve until an explicit save — adds a step and a new failure mode to the product's most important action. |
| D108 | Editing is legal only in the statuses that can be decided on (`draft`, `awaiting_approval`); the repository refuses otherwise and the textarea renders read-only | An approval keeps meaning what was signed off. Reusing `APPROVABLE_DRAFT_STATUSES` keeps "editable" and "decidable" the same set — one vocabulary, no second lifecycle to reason about. |
| D109 | New permission `response.edit`: owner, admin, communications_lead, approver | Writing and deciding stay separate jobs (the matrix's own precedent), but the roles that own response text — and the approver amending as part of a decision — must not need a ticket to fix a typo. Analysts and viewers stay absent, preserving the matrix's read-only invariant. Location managers are absent because drafts have no location-scoping check to constrain them with. |
| D110 | Persistence is a purpose-built repository method `saveFinalText(scope, draftId, finalText)`, not a general `update(patch)` | The repository interface's own comment: every transition is its own method so illegal writes are unrepresentable. `saveFinalText` enforces D108 centrally, whichever adapter runs. |
| D111 | New audit event `response.edited`; `previousState`/`newState` carry text lengths only (`{ finalTextLength }`), never the text | The audit vocabulary's standing rule is that events carry counts and codes, not content. Response text embeds customer situations; lengths make the edit visible in the trail without copying prose into an append-only table. Requires the vocabulary migration (D112). |
| D112 | One migration redefines `audit_events_known_event_type` in full — the existing union plus `response.edited` | Postgres cannot extend a check constraint; the merge migration's history shows partial redefinitions silently drop values. The mirror test fails until the SQL and `AUDIT_EVENT_TYPES` agree, so drift is a build failure. |
| D113 | Decide-with-text authorizes `response.decide` only | Every role that may decide (owner, admin, approver) also holds `response.edit` under D109, so a second check would never change an outcome — it would only complicate the action. The standalone save action authorizes `response.edit`. |
| D114 | "Save draft" enables only when the textarea differs from the stored text, shows a saving/saved state, and never auto-saves | An explicit-save composer matches how approvals read the text (deliberate snapshots), unlike brand voice's autosave (D70), where the form *is* the record. A disabled button when there is nothing to save is the honest state. |
| D115 | Saving sets `finalText` even when the new text equals `draftText`; clearing back to the exact original stores that text, not null | Reverting an edit by hand is still a human decision worth recording. `hasHumanEdit` already treats `finalText === draftText` as "not edited", so metrics stay correct without a special case. |

## The pieces

### Domain

`src/domain/entities/response.ts`:

- `saveResponseDraftInputSchema = z.object({ responseDraftId: uuidSchema, finalText: z.string().min(1).max(5000) })` and its type.
- `decideResponseDraftInputSchema` gains `finalText: z.string().min(1).max(5000).optional()`.
- A named export for the editable statuses: `EDITABLE_DRAFT_STATUSES = APPROVABLE_DRAFT_STATUSES` with `canEditDraft(status)` — an alias made explicit so call sites read as what they mean.

`src/domain/enums.ts`: `response.edited` added to `AUDIT_EVENT_TYPES` with a
comment noting the lengths-only metadata rule (D111).

### Data layer

`ResponseDraftRepository.saveFinalText(scope, draftId, finalText)` →
`Promise<ResponseDraft>`:

- Throws the repository's standard invalid-transition error when the draft's
  status is not editable (D108) or the draft is not in scope.
- Demo adapter: in-memory update; Supabase adapter: scoped `update … returning`.
- `decide(...)` gains an optional `finalText` parameter applied in the same
  write as the status change (D107) — both adapters.

### Migration

`supabase/migrations/<timestamp>_response_edited_audit_event.sql`: drop and
re-add `audit_events_known_event_type` with the full current union plus
`response.edited`, following the merge migration's format and warning comment.
The mirror test verifies it.

### Actions

`src/app/actions/responses.ts`:

- New `saveResponseDraftAction`: parse → `authorize("response.edit")` → get →
  `saveFinalText` → audit `response.edited` with
  `previousState: { finalTextLength: <old length or null> }`,
  `newState: { finalTextLength: <new length> }` → revalidate `/responses`
  and `/mentions`, the same paths the decide action revalidates.
- `decideResponseDraftAction`: when the parsed input carries `finalText`,
  pass it through to `decide`. When the text actually changed, record
  `response.edited` (lengths only) alongside the existing approve/reject
  event, so the trail shows the amendment and the decision as the two things
  that happened.

### Permissions

`response.edit` added to `PERMISSIONS` and the matrix (D109), with a comment
in the matrix's voice explaining the role set.

### Composer (`src/components/responses/response-composer.tsx`)

- `canEdit` prop (computed by pages as `can(role, "response.edit") && canEditDraft(draft.status)`).
- Textarea `readOnly` when `!canEdit`, with a one-line explanation under it
  when the lock is due to status ("Approved responses can no longer be
  edited.").
- "Save draft" wired to `saveResponseDraftAction`, enabled only when
  `content !== (draft.finalText ?? draft.draftText)` and `canEdit`; pending
  spinner; success/error through the composer's existing outcome/error rows.
- Approve/reject confirm flow passes `finalText: content` when it differs
  from the stored text (D107). The reject path passes nothing — sending a
  draft back does not silently rewrite it.
- The publish button remains exactly as it is: disabled, honest copy.

### Pages

The three consumers of the composer (`/reviews/google/[id]` workspace,
responses pane) pass the new `canEdit` prop. No other page changes.

## Error handling

- Saving a draft whose status changed underneath (approved by someone else
  mid-edit): the repository refuses (D108) and the composer surfaces the
  action's error message; the user re-loads to see the new state.
- Concurrent saves last-write-wins on `finalText` — same shape as the known
  brand-voice race, accepted for the same reason: single-field, low-traffic,
  and visible in the audit trail lengths.
- Empty textarea: schema `min(1)` refuses; the composer disables Save when
  the trimmed content is empty rather than round-tripping a validation error.

## Testing

Node-environment vitest, matching house precedent (pure modules and
repository behavior; no component tests):

- Domain: `canEditDraft` mirrors `canDecideOnDraft`; schema accepts/refuses
  the new inputs.
- Repositories (demo adapter, the pattern `tests/repositories.test.ts` uses):
  `saveFinalText` persists; refuses on `approved`/`published`/`failed`;
  `decide` with `finalText` applies text and status atomically; without it,
  leaves `finalText` untouched.
- Actions (the pattern `tests/monitoring-actions.test.ts` uses if it mocks
  the guard): save action authorizes `response.edit`, records lengths-only
  audit metadata; decide action with changed text records both events.
- The existing audit-vocabulary mirror test covers the migration by
  construction.

## Out of scope

Publishing (button stays disabled), response generation (sub-project 3),
approval-request creation, draft creation, composer relocation or redesign,
autosave.
