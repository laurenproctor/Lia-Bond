# Composer Save Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make composer edits real — `finalText` saved explicitly, carried atomically by approval, locked after a decision, gated by a new `response.edit` permission, and audited as `response.edited`.

**Architecture:** Bottom-up through the existing layers: domain vocabulary and schemas plus the audit-constraint migration first, then the repository method on both adapters, then the server actions and permission, then the composer and its three consumers. Each layer's task is TDD-able in the node-only vitest suite except the final UI wiring, which is gated by typecheck/lint/suite.

**Tech Stack:** Next.js 16 App Router, React 19, Supabase Postgres (SQL migration), vitest node environment, TypeScript strict.

Spec: `docs/superpowers/specs/2026-08-06-composer-save-design.md` (decisions D107–D115).

## Global Constraints

- TypeScript strict; no `any` without a justifying comment.
- Sentence case for all UI copy.
- The publish button stays exactly as it is: disabled, honest copy (D104 carries over). Nothing may imply publishing.
- Audit events carry lengths only, never draft text (D111): `previousState`/`newState` are `{ finalTextLength: number | null }`.
- Editing statuses = deciding statuses (`draft`, `awaiting_approval`) — one vocabulary (D108).
- Tests: node-environment vitest only; repository tests run against the demo adapter via `freshDataSource()` from `tests/helpers/scope.ts`; action tests mock `@/lib/actions/guard` and `next/cache` (pattern: `tests/monitoring-actions.test.ts`).
- Verify suite: `npm run verify`. Commit only files each task names.
- End every commit message with a blank line then `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Domain vocabulary, schemas, and the audit migration

**Files:**
- Modify: `src/domain/enums.ts` (add `response.edited` to `AUDIT_EVENT_TYPES`)
- Modify: `src/domain/entities/response.ts` (new schema, extended schema, editable-status helpers)
- Create: `supabase/migrations/20260808000500_response_edited_audit_event.sql`
- Test: `tests/response-editing-domain.test.ts`

**Interfaces:**
- Consumes: existing `APPROVABLE_DRAFT_STATUSES`, `canDecideOnDraft`, `uuidSchema`.
- Produces (used by Tasks 2–4):
  - `saveResponseDraftInputSchema` / `SaveResponseDraftInput` — `{ responseDraftId: string; finalText: string }`
  - `decideResponseDraftInputSchema` gains optional `finalText?: string`
  - `EDITABLE_DRAFT_STATUSES`, `canEditDraft(status: ResponseDraft["status"]): boolean`
  - `"response.edited"` as a legal `AuditEventType`

- [ ] **Step 1: Write the failing test**

```ts
// tests/response-editing-domain.test.ts
import { describe, expect, it } from "vitest";
import {
  canDecideOnDraft,
  canEditDraft,
  decideResponseDraftInputSchema,
  EDITABLE_DRAFT_STATUSES,
  saveResponseDraftInputSchema,
} from "@/domain";
import { AUDIT_EVENT_TYPES, RESPONSE_DRAFT_STATUSES } from "@/domain/enums";

const DRAFT_ID = "5b3f8a52-7c1d-4e2a-9f6b-1a2b3c4d5e6f";

describe("canEditDraft", () => {
  it("mirrors canDecideOnDraft across every status", () => {
    for (const status of RESPONSE_DRAFT_STATUSES) {
      expect(canEditDraft(status)).toBe(canDecideOnDraft(status));
    }
  });

  it("exposes the same status set as deciding", () => {
    expect(EDITABLE_DRAFT_STATUSES).toEqual(["draft", "awaiting_approval"]);
  });
});

describe("saveResponseDraftInputSchema", () => {
  it("accepts an id and non-empty text", () => {
    const parsed = saveResponseDraftInputSchema.parse({
      responseDraftId: DRAFT_ID,
      finalText: "Thank you for letting us know.",
    });
    expect(parsed.finalText).toBe("Thank you for letting us know.");
  });

  it("refuses empty text", () => {
    expect(() =>
      saveResponseDraftInputSchema.parse({ responseDraftId: DRAFT_ID, finalText: "" }),
    ).toThrow();
  });

  it("refuses text over 5000 characters", () => {
    expect(() =>
      saveResponseDraftInputSchema.parse({
        responseDraftId: DRAFT_ID,
        finalText: "x".repeat(5001),
      }),
    ).toThrow();
  });
});

describe("decideResponseDraftInputSchema", () => {
  it("still parses without finalText", () => {
    const parsed = decideResponseDraftInputSchema.parse({
      responseDraftId: DRAFT_ID,
      decision: "approved",
    });
    expect(parsed.finalText).toBeUndefined();
  });

  it("carries finalText when provided", () => {
    const parsed = decideResponseDraftInputSchema.parse({
      responseDraftId: DRAFT_ID,
      decision: "approved",
      finalText: "Amended before approval.",
    });
    expect(parsed.finalText).toBe("Amended before approval.");
  });
});

describe("audit vocabulary", () => {
  it("includes response.edited", () => {
    expect(AUDIT_EVENT_TYPES).toContain("response.edited");
  });
});
```

Check that `RESPONSE_DRAFT_STATUSES` is exported from `@/domain/enums` (it should exist beside the other vocabularies); if the exported name differs, use the actual name.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/response-editing-domain.test.ts`
Expected: FAIL — `canEditDraft`, `EDITABLE_DRAFT_STATUSES`, `saveResponseDraftInputSchema` not exported; `response.edited` missing.

- [ ] **Step 3: Implement the domain changes**

In `src/domain/enums.ts`, add to `AUDIT_EVENT_TYPES` directly after `"response.rejected"`:

```ts
  // A person changed a draft's final text. `previousState`/`newState` carry
  // text lengths only — response text embeds customer situations, and the
  // trail records that an edit happened, not the prose.
  "response.edited",
```

In `src/domain/entities/response.ts`, after `canDecideOnDraft`:

```ts
/**
 * Statuses whose text may still change.
 *
 * Deliberately the same set as deciding (D108): an approval keeps meaning
 * what was signed off, so the moment a draft leaves the decidable states its
 * text is frozen too. One vocabulary, no second lifecycle.
 */
export const EDITABLE_DRAFT_STATUSES = APPROVABLE_DRAFT_STATUSES;

export function canEditDraft(status: ResponseDraft["status"]): boolean {
  return (EDITABLE_DRAFT_STATUSES as readonly string[]).includes(status);
}

export const saveResponseDraftInputSchema = z.object({
  responseDraftId: uuidSchema,
  finalText: z.string().min(1).max(5000),
});

export type SaveResponseDraftInput = z.infer<typeof saveResponseDraftInputSchema>;
```

Extend `decideResponseDraftInputSchema` with:

```ts
  finalText: z.string().min(1).max(5000).optional(),
```

Confirm `src/domain/index.ts` re-exports everything from `entities/response` (it re-exports the entity modules wholesale; only add an export line if it does not).

- [ ] **Step 4: Write the migration**

Create `supabase/migrations/20260808000500_response_edited_audit_event.sql`. Follow the format of `20260807000700_audit_vocabulary_merge.sql`: drop `audit_events_known_event_type`, re-add it with the **complete** current value list — every string in `AUDIT_EVENT_TYPES` as it stands after Step 3 (including `response.edited`), in the same order, each quoted. Postgres cannot extend a check constraint, so the redefinition must be total; a partial list silently drops values (that migration's header comment tells the story — read it and carry a shortened version of the warning). Start the file with a comment:

```sql
-- Add `response.edited` to the audit vocabulary (D111/D112).
--
-- Redefines `audit_events_known_event_type` in full: Postgres has no "add a
-- value to a check constraint" statement, and a partial redefinition silently
-- drops every value it omits (see 20260807000700_audit_vocabulary_merge.sql).
-- `tests/audit-vocabulary-migrations.test.ts` pins this list against
-- `AUDIT_EVENT_TYPES` in `src/domain/enums.ts`.
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/response-editing-domain.test.ts tests/audit-vocabulary-migrations.test.ts`
Expected: PASS — the mirror test proves the migration list matches the enum exactly. If the mirror test fails, the migration list is wrong; fix the SQL, not the test.

Then run the full suite once: `npm run test` — no regressions.

- [ ] **Step 6: Commit**

```bash
git add src/domain/enums.ts src/domain/entities/response.ts supabase/migrations/20260808000500_response_edited_audit_event.sql tests/response-editing-domain.test.ts
git commit -m "Add response editing vocabulary and audit event"
```

---

### Task 2: Repository `saveFinalText` and decide-with-text

**Files:**
- Modify: `src/lib/data/types.ts` (interface)
- Modify: `src/lib/data/demo/index.ts` (demo adapter)
- Modify: `src/lib/data/supabase/index.ts` (Supabase adapter)
- Test: `tests/response-editing-repository.test.ts`

**Interfaces:**
- Consumes: `canEditDraft`, `canDecideOnDraft` from `@/domain` (Task 1); demo-adapter internals `draftsIn(scope)`, `replaceRow`, `nowIso()`, `conflict`/`notFound` from `@/lib/data/errors` — all already used by the neighboring methods.
- Produces (used by Task 3):
  - `ResponseDraftRepository.saveFinalText(scope, draftId, finalText): Promise<ResponseDraft>`
  - `ResponseDraftRepository.decide(scope, draftId, decision, decidedByUserId, decisionNote?, finalText?)` — one new trailing optional parameter.

- [ ] **Step 1: Write the failing test**

```ts
// tests/response-editing-repository.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { freshDataSource, ushg } from "./helpers/scope";
import type { LiaDataSource } from "@/lib/data/types";
import type { ResponseDraft } from "@/domain";

let data: LiaDataSource;

beforeEach(() => {
  data = freshDataSource();
});

async function editableDraft(): Promise<ResponseDraft> {
  const drafts = await data.responseDrafts.list(ushg.admin(), {
    statuses: ["draft", "awaiting_approval"],
  });
  const draft = drafts[0];
  if (!draft) throw new Error("Seed dataset has no editable draft");
  return draft;
}

async function lockedDraft(): Promise<ResponseDraft> {
  const drafts = await data.responseDrafts.list(ushg.admin(), {
    statuses: ["approved", "published"],
  });
  const draft = drafts[0];
  if (!draft) throw new Error("Seed dataset has no decided draft");
  return draft;
}

describe("saveFinalText", () => {
  it("persists the text and bumps updatedAt", async () => {
    const draft = await editableDraft();
    const saved = await data.responseDrafts.saveFinalText(
      ushg.admin(),
      draft.id,
      "A hand-tuned reply.",
    );
    expect(saved.finalText).toBe("A hand-tuned reply.");
    expect(saved.status).toBe(draft.status);

    const reread = await data.responseDrafts.get(ushg.admin(), draft.id);
    expect(reread?.finalText).toBe("A hand-tuned reply.");
  });

  it("refuses once the draft is decided", async () => {
    const draft = await lockedDraft();
    await expect(
      data.responseDrafts.saveFinalText(ushg.admin(), draft.id, "Too late."),
    ).rejects.toMatchObject({ code: "conflict" });
  });

  it("refuses an unknown draft", async () => {
    await expect(
      data.responseDrafts.saveFinalText(
        ushg.admin(),
        "00000000-0000-4000-8000-000000000000",
        "Nobody home.",
      ),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("decide with finalText", () => {
  it("applies text and status in one write", async () => {
    const draft = await editableDraft();
    const { draft: decided } = await data.responseDrafts.decide(
      ushg.admin(),
      draft.id,
      "approved",
      ushg.admin().userId,
      undefined,
      "Approved exactly as amended.",
    );
    expect(decided.status).toBe("approved");
    expect(decided.finalText).toBe("Approved exactly as amended.");
  });

  it("leaves finalText untouched when not provided", async () => {
    const draft = await editableDraft();
    const { draft: decided } = await data.responseDrafts.decide(
      ushg.admin(),
      draft.id,
      "approved",
      ushg.admin().userId,
    );
    expect(decided.finalText).toBe(draft.finalText);
  });
});
```

Check `tests/helpers/scope.ts` for the scope helper's actual shape (`ushg.admin()` returning an `OrganizationScope` with `userId`); adjust the `decidedByUserId` argument if the helper exposes ids differently. Check `responseDraftFilterSchema` supports `statuses` (it does — `src/domain/entities/response.ts:51`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/response-editing-repository.test.ts`
Expected: FAIL — `saveFinalText` is not a function; the six-argument `decide` ignores the text (type error at compile).

- [ ] **Step 3: Extend the interface**

In `src/lib/data/types.ts`, inside `ResponseDraftRepository` (before `decide`):

```ts
  /**
   * Persist a human's edit to the draft's final text.
   *
   * Refuses outside the editable statuses (the same set that can be decided
   * on, D108) — an approved response's text is frozen with its approval.
   * Deliberately not a general `update`: every transition is its own method
   * so illegal writes are unrepresentable.
   */
  saveFinalText(
    scope: OrganizationScope,
    draftId: string,
    finalText: string,
  ): Promise<ResponseDraft>;
```

And extend `decide`'s signature with a trailing `finalText?: string` (update its doc comment: "When `finalText` is provided, it is applied in the same write as the decision — the approver approves exactly what they saw (D107).").

- [ ] **Step 4: Implement the demo adapter**

In `src/lib/data/demo/index.ts`, beside the existing `decide`:

```ts
      async saveFinalText(scope, draftId, finalText) {
        const draft = draftsIn(scope).find((row) => row.id === draftId);
        if (!draft) throw notFound("Response draft");

        if (!canEditDraft(draft.status)) {
          throw conflict(
            `A response that is already ${draft.status.replace(/_/g, " ")} can no longer be edited.`,
          );
        }

        return replaceRow(store().responseDrafts, {
          ...draft,
          finalText,
          updatedAt: nowIso(),
        });
      },
```

In the demo `decide`, add the parameter and apply it in the same object:

```ts
      async decide(scope, draftId, decision, decidedByUserId, decisionNote, finalText) {
        // …existing guard clauses unchanged…
        const updatedDraft: ResponseDraft = {
          ...draft,
          finalText: finalText ?? draft.finalText,
          status: decision === "approved" ? "approved" : "draft",
          // …rest unchanged…
        };
```

Import `canEditDraft` alongside the existing `canDecideOnDraft` import.

- [ ] **Step 5: Implement the Supabase adapter**

In `src/lib/data/supabase/index.ts`, beside the existing `decide` (matching its style — `this.get` precheck, scoped update with an optimistic status guard, `toResponseDraft`):

```ts
      async saveFinalText(scope, draftId, finalText) {
        const current = await this.get(scope, draftId);
        if (!current) throw notFound("Response draft");

        if (!canEditDraft(current.status)) {
          throw conflict(
            `A response that is already ${current.status.replace(/_/g, " ")} can no longer be edited.`,
          );
        }

        const { data, error } = await client
          .from("response_drafts")
          .update({ final_text: finalText })
          .eq("organization_id", scope.organizationId)
          .eq("id", draftId)
          // Optimistic guard: if a decision landed in the meantime, the status
          // moved out of the editable set and this update affects no rows.
          .eq("status", current.status)
          .select("*")
          .maybeSingle();

        if (error) fail(error, "save the draft");
        if (!data) throw conflict("This response was decided while you were editing.");
        return toResponseDraft(data as Row);
      },
```

In the Supabase `decide`, add the trailing `finalText` parameter and extend the update payload:

```ts
          .update({
            ...(finalText !== undefined ? { final_text: finalText } : {}),
            status: decision === "approved" ? "approved" : "draft",
            // …rest unchanged…
          })
```

Verify the column name by checking `toResponseDraft`/the mappers for how `finalText` maps (expect `final_text`); use whatever the mapper reads.

- [ ] **Step 6: Run the tests**

Run: `npx vitest run tests/response-editing-repository.test.ts`
Expected: PASS. Then `npm run typecheck && npm run test` — clean, no regressions.

- [ ] **Step 7: Commit**

```bash
git add src/lib/data/types.ts src/lib/data/demo/index.ts src/lib/data/supabase/index.ts tests/response-editing-repository.test.ts
git commit -m "Add saveFinalText and decide-with-text to the draft repositories"
```

---

### Task 3: Permission and server actions

**Files:**
- Modify: `src/lib/auth/permissions.ts`
- Modify: `src/app/actions/responses.ts`
- Test: `tests/response-actions.test.ts`

**Interfaces:**
- Consumes: `saveResponseDraftInputSchema`, extended decide schema, `canEditDraft` (Task 1); `saveFinalText`, decide-with-text (Task 2); `authorize`, `runAction`, `diff`, `recordAuditEvent`, `notFound` — all already imported or importable in the actions file.
- Produces (used by Task 4):
  - `"response.edit"` permission: owner, admin, communications_lead, approver
  - `saveResponseDraftAction(input: unknown): Promise<ActionResult<ResponseDraft>>`
  - `decideResponseDraftAction` accepting `finalText` in its input.

- [ ] **Step 1: Write the failing test**

Model the harness on `tests/monitoring-actions.test.ts`: mock `@/lib/actions/guard` so `authorize` returns a context built around `freshDataSource()`, and mock `next/cache`'s `revalidatePath` as a no-op. Read that file first and copy its `contextFor`/mock-reset structure exactly; the assertions below are what matter.

```ts
// tests/response-actions.test.ts — assertions to include (harness per monitoring-actions.test.ts)
import { beforeEach, describe, expect, it, vi } from "vitest";
// …mocks for @/lib/actions/guard and next/cache, contextFor helper…
import {
  decideResponseDraftAction,
  saveResponseDraftAction,
} from "@/app/actions/responses";
import { can } from "@/lib/auth/permissions";

describe("response.edit permission", () => {
  it("grants owner, admin, communications lead, and approver — nobody else", () => {
    expect(can("owner", "response.edit")).toBe(true);
    expect(can("admin", "response.edit")).toBe(true);
    expect(can("communications_lead", "response.edit")).toBe(true);
    expect(can("approver", "response.edit")).toBe(true);
    expect(can("analyst", "response.edit")).toBe(false);
    expect(can("viewer", "response.edit")).toBe(false);
    expect(can("location_manager", "response.edit")).toBe(false);
  });
});

describe("saveResponseDraftAction", () => {
  it("authorizes response.edit, saves, and records a lengths-only audit event", async () => {
    // arrange: context for an admin; pick an editable draft from the data source
    // act: saveResponseDraftAction({ responseDraftId, finalText: "Edited." })
    // assert: result.ok is true and result.data.finalText === "Edited."
    // assert: authorizeMock was called with "response.edit"
    // assert: auditEvents.list(scope, { entityType: "response_draft", entityId })
    //   contains one "response.edited" whose newState is { finalTextLength: 7 }
    //   and whose previousState carries a number-or-null finalTextLength —
    //   and neither state object contains the text itself
  });

  it("surfaces the conflict when the draft is already decided", async () => {
    // act on an approved draft; assert result.ok is false and the message
    // mentions it can no longer be edited
  });
});

describe("decideResponseDraftAction with finalText", () => {
  it("applies the text and records both events", async () => {
    // approve an editable draft passing finalText different from the stored one
    // assert: draft approved with that finalText
    // assert: audit trail for the draft contains "response.approved" AND
    //   "response.edited" (lengths only)
  });

  it("records no edit event when the text did not change", async () => {
    // approve passing finalText identical to existing.finalText ?? draftText…
    // actually: pass no finalText at all; assert only "response.approved" recorded
  });
});
```

Write these as real tests, not comments — the comments above specify the arrange/act/assert content; the harness details come from the monitoring-actions file. If that file's mock shape does not transplant (different guard export, no reusable `contextFor`), stop and report NEEDS_CONTEXT rather than inventing a new harness style.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/response-actions.test.ts`
Expected: FAIL — `response.edit` is not a `Permission`; `saveResponseDraftAction` does not exist.

- [ ] **Step 3: Add the permission**

In `src/lib/auth/permissions.ts`: add `"response.edit"` to `PERMISSIONS` (beside the other response entries) and to the matrix:

```ts
  // Writing response text and signing it off stay separate jobs, but the
  // roles that own the text — and the approver amending as part of a
  // decision (D107) — must not need a ticket to fix a typo. Location
  // managers are absent because drafts carry no location to scope them to.
  "response.edit": ["owner", "admin", "communications_lead", "approver"],
```

- [ ] **Step 4: Implement the actions**

In `src/app/actions/responses.ts`, following the existing two actions' shape exactly:

```ts
/** Persist a human's edit to a draft's final text. */
export async function saveResponseDraftAction(
  input: unknown,
): Promise<ActionResult<ResponseDraft>> {
  return runAction("response.save", async () => {
    const { responseDraftId, finalText } =
      saveResponseDraftInputSchema.parse(input);

    const context = await authorize("response.edit");

    const existing = await context.dataSource.responseDrafts.get(
      context.scope,
      responseDraftId,
    );
    if (!existing) throw notFound("Response draft");

    const updated = await context.dataSource.responseDrafts.saveFinalText(
      context.scope,
      responseDraftId,
      finalText,
    );

    // Lengths only, never the text (D111): the trail records that an edit
    // happened, not the prose.
    await recordAuditEvent(context, {
      eventType: "response.edited",
      entityType: "response_draft",
      entityId: responseDraftId,
      previousState: { finalTextLength: existing.finalText?.length ?? null },
      newState: { finalTextLength: updated.finalText?.length ?? null },
    });

    revalidatePath("/responses");
    revalidatePath("/mentions");
    return updated;
  });
}
```

(Check `runAction`'s first argument semantics in `src/lib/actions/result.ts` — the existing actions pass the permission-like slug; use `"response.save"` unless the helper requires a registered value, in which case match its expectations.)

In `decideResponseDraftAction`: parse now yields `finalText`; pass it through as the sixth argument to `decide`, and after the existing approve/reject audit event, record the edit when text actually changed:

```ts
    const { draft } = await context.dataSource.responseDrafts.decide(
      context.scope,
      responseDraftId,
      decision,
      context.userId,
      decisionNote,
      finalText,
    );
    // …existing decision audit event unchanged…

    if (finalText !== undefined && finalText !== existing.finalText) {
      await recordAuditEvent(context, {
        eventType: "response.edited",
        entityType: "response_draft",
        entityId: responseDraftId,
        previousState: { finalTextLength: existing.finalText?.length ?? null },
        newState: { finalTextLength: finalText.length },
      });
    }
```

Add `saveResponseDraftInputSchema` to the domain import.

- [ ] **Step 5: Run the tests**

Run: `npx vitest run tests/response-actions.test.ts`
Expected: PASS. Then `npm run typecheck && npm run test` — clean.

- [ ] **Step 6: Commit**

```bash
git add src/lib/auth/permissions.ts src/app/actions/responses.ts tests/response-actions.test.ts
git commit -m "Add response.edit permission and draft save action"
```

---

### Task 4: Composer wiring and consumers

**Files:**
- Modify: `src/components/responses/response-composer.tsx`
- Modify: `src/lib/view-models/workspace.ts` (add `canEdit`)
- Modify: `src/app/(app)/reviews/google/[id]/page.tsx` (pass `canEdit`)
- Modify: `src/components/responses/response-detail-pane.tsx` (accept + pass `canEdit`)
- Modify: `src/app/(app)/responses/page.tsx` (compute + pass `canEdit`)

**Interfaces:**
- Consumes: `saveResponseDraftAction`, extended `decideResponseDraftAction` (Task 3); `canEditDraft` (Task 1); `can(role, "response.edit")`.
- Produces: `ResponseComposerProps` gains `canEdit: boolean` (role-level; the composer combines it with `canEditDraft(draft.status)` itself); `ResponseDetailPaneProps` gains `canEdit: boolean`; `WorkspaceData` gains `canEdit: boolean`.

- [ ] **Step 1: Rework the composer**

In `src/components/responses/response-composer.tsx`:

Props:

```tsx
export interface ResponseComposerProps {
  draft: ResponseDraft;
  /** What the source connector actually permits. Drives the primary action. */
  publishing: PublishingMode;
  /** False for roles that may read a draft but not decide on it. */
  canDecide: boolean;
  /** Role-level edit permission; the composer also checks the status itself. */
  canEdit: boolean;
  className?: string;
}
```

Inside the component:

```tsx
  const stored = draft.finalText ?? draft.draftText;
  const dirty = content !== stored;
  const editable = canEdit && canEditDraft(draft.status);
```

(`canEditDraft` imported from `@/domain` — a pure function, fine in a client component. Keep `useState(draft.finalText ?? draft.draftText)` as is; after a successful save the server re-renders with the new `draft`, `stored` catches up, and `dirty` returns to false without touching local state.)

Save handler beside `decide()`:

```tsx
  function save() {
    setError(null);
    startTransition(async () => {
      const result = await saveResponseDraftAction({
        responseDraftId: draft.id,
        finalText: content,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOutcome("Draft saved.");
    });
  }
```

`decide()` carries the visible text on approval only (D107; reject never rewrites):

```tsx
      const result = await decideResponseDraftAction({
        responseDraftId: draft.id,
        decision,
        ...(decision === "approved" && dirty ? { finalText: content } : {}),
      });
```

Textarea: add `readOnly={!editable || pending}` and, when the lock is status-driven, one line under the character count:

```tsx
        {canEdit && !canEditDraft(draft.status) ? (
          <p className="mt-1 text-[12px] text-gray-500">
            Approved responses can no longer be edited.
          </p>
        ) : null}
```

Save button (replacing the hard-disabled one; the publish button stays byte-for-byte identical):

```tsx
          <Button
            variant="secondary"
            icon={pending ? Loader2 : PencilLine}
            disabled={pending || !editable || !dirty || content.trim().length === 0}
            onClick={save}
          >
            Save draft
          </Button>
```

Import `saveResponseDraftAction` and `canEditDraft`.

- [ ] **Step 2: Thread `canEdit` through the consumers**

`src/lib/view-models/workspace.ts` — add to `WorkspaceData`:

```ts
  canEdit: boolean;
```

and to the return object:

```ts
    canEdit: can(context.role, "response.edit"),
```

`src/app/(app)/reviews/google/[id]/page.tsx` — destructure `canEdit` from `loadWorkspace`'s result and pass `canEdit={canEdit}` to `ResponseComposer`.

`src/components/responses/response-detail-pane.tsx` — add `canEdit: boolean` to `ResponseDetailPaneProps` (doc: "Role-level edit permission, threaded to the composer.") and pass it to the embedded `ResponseComposer`.

`src/app/(app)/responses/page.tsx` — pass `canEdit={can(role, "response.edit")}` to `ResponseDetailPane` (the page already has `role` and imports `can`).

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: clean, no regressions.

Then confirm in the running app (`npm run dev`), as the seeded admin: edit a draft on `/responses` → Save draft enables → saves, button disables again; approve with edited text → approved draft shows the amended text and the pane's "Original AI draft" section appears; an approved draft's textarea is read-only with the explanation line.

- [ ] **Step 4: Commit**

```bash
git add src/components/responses/response-composer.tsx src/lib/view-models/workspace.ts "src/app/(app)/reviews/google/[id]/page.tsx" src/components/responses/response-detail-pane.tsx "src/app/(app)/responses/page.tsx"
git commit -m "Wire composer saving, approve-with-text, and the edit lock"
```

---

### Task 5: Full verification, remote migration note, and ledger update

**Files:**
- Modify: `docs/architecture/current-state.md`

- [ ] **Step 1: Run the full verify suite**

Run: `npm run verify`
Expected: lint, typecheck, all tests, and `next build` pass.

- [ ] **Step 2: Update the current-state ledger**

In `docs/architecture/current-state.md`, find the claims that composer edits are discarded and Save draft is disabled (grep for `Save draft`, `finalText`, `composer`). Update them in the document's voice to record: final text persists via `saveFinalText` (statuses `draft`/`awaiting_approval` only), approve carries the composer's text atomically, `response.edit` gates editing, `response.edited` lands in the audit trail with lengths only, and the migration `20260808000500_response_edited_audit_event.sql` **has not been applied to the hosted project yet** — flag it the way the doc flags other pending operational steps so the next `npm run db:migrate`/deploy applies it. Publishing remains unbuilt; do not touch those claims.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture/current-state.md
git commit -m "Record persisted composer edits in the current-state ledger"
```
