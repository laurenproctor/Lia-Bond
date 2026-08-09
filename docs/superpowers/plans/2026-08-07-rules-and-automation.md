# Rules and Automation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the Rules page placeholders with a trustworthy rule-authoring and simulation workspace (Phase 1, independently releasable), and design — without yet building — the execution engine that later makes rules real (Phase 2).

**Architecture:** Pure rule logic (evaluator, readiness, capabilities, sentence) lives in a new `src/lib/rules/` module with zero I/O, following the house rule that testable logic never lives in a server action. Persistence extends `AutomationRuleRepository` identically in both adapters with a revision counter that doubles as the optimistic-concurrency token and the simulation-staleness marker. The UI moves to dedicated routes (`/rules`, `/rules/new`, `/rules/[ruleId]`) so the builder gets a full page instead of an undersized panel.

**Tech Stack:** Next.js App Router (server components + server actions), Zod 4, Vitest (node env only — no DOM tests), Supabase Postgres + RLS, demo in-memory adapter.

## Global Constraints

- TypeScript strict mode; no `any` without a justifying comment (CLAUDE.md).
- Server components by default; client components only where interactivity requires them (CLAUDE.md).
- Sentence case throughout the interface (CLAUDE.md).
- No page component over ~300 lines (CLAUDE.md).
- Route-level loading and error states (CLAUDE.md).
- "Keep platform capabilities explicit. Never imply direct publishing where the source does not support it." (CLAUDE.md:14)
- "Make high-risk actions approval-first." (CLAUDE.md:15)
- Product spec: "Positive, low-risk, routine review responses may become auto-publishable. Reddit and media engagement should default to approval-first. High-risk content must always be escalated." (docs/product-spec.md:106-108)
- No role check outside `can()`/`canForLocation()`; every mutation flows `parse input → authorize → repository → recordAuditEvent` (src/lib/actions/guard.ts, README pattern).
- Audit vocabulary is a closed Postgres check constraint; every new event type requires a migration that redefines the **entire** list, pinned by `tests/audit-vocabulary-migrations.test.ts` (D93).
- Audit events carry counts, codes, and configuration — never review text, reviewer names, or customer content (D111 and the constraint comment).
- Every repository method takes `OrganizationScope`; no `listAll()` (src/lib/data/types.ts:58-69).
- New `automation_rules` columns must be added to `scripts/seed-sql-columns.ts` or `tests/seed-generator-columns.test.ts` fails.
- Verification: `npm run verify` (lint + typecheck + vitest + next build), `npm run db:validate` (libpg-query parse), `npm run db:verify-rls` where a local stack exists.
- No new external dependencies.

---

## 1. Current-state findings and corrections

Everything below was verified against the working tree on 2026-08-07 (branch `master`, HEAD `57e8a0d`).

### Confirmed as described in the request

| Claim | Verdict | Evidence |
|---|---|---|
| Rules page lists rules, placeholders for builder/templates/simulation | Confirmed | `src/app/(app)/rules/page.tsx:132-151` — three `SectionPlaceholder`s |
| Status tabs display counts but do not filter | Confirmed | `rules/page.tsx:100-108` — `SegmentedTabs` gets no `onChange`; the component is uncontrolled (`segmented-tabs.tsx` holds its own `useState`) |
| Repository supports `list`, `get`, `setEnabled` only | Confirmed | `src/lib/data/types.ts:620-628` — no create/update/delete/simulate/recordRun |
| One server action, enable/disable | Confirmed | `src/app/actions/automation.ts:17-51` |
| Only `automation_rule.toggle` permission exists | Confirmed | `src/lib/auth/permissions.ts:21,81` — held by owner, admin, communications_lead |
| Typed condition/action unions stored as JSON | Confirmed | `src/domain/entities/automation.ts:25-85`; jsonb columns with array checks in DDL |
| Seeded rules active with fictional last-run dates | Confirmed | 8 seeded rules (6 active, 1 inactive, 1 draft); active ones carry `lastRunAt` between `hoursAgo(4)` and `daysAgo(1)` (`src/lib/seed/dataset.ts:1816-1922`) — no code anywhere writes `last_run_at` |
| No evaluator, executor, execution log, retry model, or analysis-pipeline hookup | Confirmed | No module evaluates `conditions`; `src/lib/analysis/` never imports automation |
| Flat condition arrays, no AND/OR model | Confirmed | `z.array(ruleConditionSchema)`; the AND is implicit and undocumented in the UI |
| `isAutoPublishSafe` weaker than the spec | Confirmed, worse than described | It accepts `at_most: "medium"` (medium risk), ignores sentiment and source entirely, **and is never called anywhere** — its doc comment says "enforced wherever rules execute", which is currently nowhere (`src/domain/entities/automation.ts:129-143`). Its only consumer is a seed-data test. |
| Audit diff stringifies arrays/objects | Confirmed | `src/lib/audit/record.ts` `toJson` falls through to `String(value)`: an array becomes `"a,b,c"`, an object `"[object Object]"`. Comparison is `===`, so array fields always register as changed. |

### Corrections and additions the request did not anticipate

1. **High/critical escalation already happens outside rules.** `analyzeOne` auto-creates an open, unassigned escalation for high/critical risk (`src/lib/analysis/normalize.ts:27-29,134-154`; `src/lib/analysis/analyze.ts:133-159`; decision D38) and `escalations.create` dedupes per mention (`types.ts:603-606`, returns `{ escalation, created }`). The guardrail is a hardcoded product behavior, not a rule. This is the reconciliation anchor for Phase 2: a rule-driven `escalate` on the same mention returns `created: false` — no duplicate.
2. **`Mention` has no `platform` column, no assignee, no tags.** Platform is reachable only through `platformConnectionId` → `platformConnections.list(scope)`. There is no assignee field or `assign` repo method on mentions, and no tag storage anywhere in the schema. The `assign` and `tag` rule actions therefore have **no target entity at all** — they are not merely unimplemented, they are undefined.
3. **`escalate`'s `assigneeUserId` is unimplementable as specced.** `CreateEscalationInput` deliberately omits an assignee — "an escalation raised by an analysis has no owner yet, and picking one is a human decision" (`src/domain/entities/escalation.ts:38-49`). The rule action's assignee field contradicts a standing product decision.
4. **`require_approval` has no creation path.** Approvals exist and can be *decided* (`responseDrafts.decide`), but nothing can create a pending approval or move a draft to `awaiting_approval`.
5. **No draft generation, no publishing, no notifications.** `AiProvider` has exactly one method, `analyzeMention` ("Workflow 05 adds a `draftResponse()` sibling", `src/ai/provider.ts:17-18,45-57`). Every connector capability sets `canPublishResponses: false`; there is no publish method on the connector interface; no code writes `published`/`publishing` statuses. Email exists only for the help form and early access; there is no in-app notification entity.
6. **Brand voice is one profile per organization** (`BrandVoiceRepository.get/save`, `types.ts:638-647`). The seeded `generate_draft.voiceProfile: "maison-laurent"` slug references nothing — there is no voice-profile lookup by slug anywhere.
7. **Both adapters already refuse to enable drafts with copy promising simulation** — "Finish and simulate this draft rule before enabling it." (`demo/index.ts:2048-2052`, `supabase/index.ts:2406-2408`). The product already promises the feature this plan builds.
8. **No DELETE policy on `automation_rules`.** RLS grants select to members, insert/update to owner/admin/communications_lead only (`20260801000200_row_level_security.sql:273-293`). Deletion is impossible for `authenticated` — which pushes V1 toward archiving, not deletion.
9. **`docs/data-model.md:116-123` is stale**: it describes `enabled` (boolean) and `lastSimulatedAt`; the shipped table has a three-value `status` enum and `last_run_at`.
10. **Simulation can run off denormalized mention columns.** `status`, `sentiment`, `riskLevel`, `relevanceScore`, `rating`, `sourceType`, `locationId` all live on the mention row (analysis outcomes are copied down; `types.ts:98-104`). No join to `mention_analyses` is needed — which sidesteps the missing batch "mention + latest analysis" read entirely. `MentionFilter.limit` caps at 200, so simulation needs its own slim read method.
11. **Test/infra contracts that constrain this work:** vitest is node-env only, `.test.tsx` isn't matched, and nothing tests components; actions are tested by mocking `@/lib/actions/guard` (`tests/monitoring-actions.test.ts:28-56` is the house pattern); `tests/permissions.test.ts:26-29` pins analysts/viewers to zero permissions; `scripts/seed-sql-columns.ts:112-115` pins the `automation_rules` column list; `tests/audit-vocabulary-migrations.test.ts` pins the audit constraint against `AUDIT_EVENT_TYPES`; `supabase/tests/rls-verification.sql` already probes `automation_rules` cross-tenant reads and writes (lines 116-117, 167-174).
12. **`DataTable` supports `rowHref`/`rowLabel`/`selectedKey` but not `onRowClick`**; the link is an absolutely-positioned overlay on the first cell and the row is `relative` — any interactive cell content must itself be `relative` to stay clickable. `RuleToggle`'s wrapper is not (`rule-toggle.tsx:49`), so wiring `rowHref` without fixing the toggle would make the switch unclickable.
13. **The DB default for `priority` is 100 while `status` defaults to `'draft'`** — the very status the app then refuses to enable. Harmless, but worth knowing when writing `create`.

### Unsupported assumptions to drop

- "Existing brand-voice data" as a builder selector: there is nothing to select — one profile per org. `generate_draft` should reference *the* brand voice (value `null`), not a slug.
- Rule-authored assignment/tagging of mentions: no entity supports it. These actions are removed from the builder, not merely disabled.
- Any notion that a rule has ever run: `lastRunAt` has no writer. All seeded values are fabrications.

---

## 2. Phase 1 objective and non-goals

**Objective.** Authorized users can filter and inspect rules; create drafts; edit draft/inactive rules; duplicate; build conditions and actions in plain language with contextual selectors; read the rule back as a sentence; simulate against the last 30 days with zero side effects and no AI calls; see exactly why a rule cannot be activated; enable only rules whose actions Lia's existing services could genuinely execute; and see a truthful audit trail. The page states plainly that **rules are not yet applied to incoming mentions** — Phase 1 is authoring and simulation, and the UI never claims otherwise.

**Non-goals for Phase 1** (per the request, all confirmed as not-already-supported): nested AND/OR trees; scheduled/time-based rules; webhooks; custom scripts; a notification platform; workflow orchestration; automatic publishing; SLA management; destructive deletion of execution history; unbounded rule analytics; new dependencies. Also explicitly out: rule execution of any kind, `lastRunAt` writes, and any change to the analysis pipeline.

---

## 3. Phase 2 objective and prerequisites

**Objective.** Connect enabled rules to real behavior: a pure condition evaluator (built in Phase 1 and reused unchanged), a deterministic ordering strategy, a normalized subject, an action-executor registry, idempotent execution records, retries, per-rule outcomes, real `lastRunAt`, and failure visibility.

**Hard prerequisites — Phase 2 must not start until each is true:**

1. **Draft generation service exists** (workflow 05: `AiProvider.draftResponse` + `responseDrafts.create`) before `generate_draft` becomes executable.
2. **Approval-request creation path exists** (a way to create a pending `Approval` and move a draft to `awaiting_approval`) before `require_approval` becomes executable.
3. **A notification decision is made** (build in-app notifications, or scope `notify` to email, or drop it) before `notify` becomes executable.
4. **A publishing connector exists** (`canPublishResponses: true` somewhere, a connector publish method, a publish server action) before `auto_publish` is even activatable — and then only through the strengthened safety gate.
5. **Escalation reconciliation is written down**: rule-driven `escalate` piggybacks on `escalations.create`'s per-mention dedupe so the D38 auto-escalation and a customer rule can never double-escalate; a customer rule can *add* escalations for lower-risk conditions but can never suppress the built-in high/critical escalation (there is deliberately no rule action that could).
6. **Job boundary chosen**: execution runs inside the existing analysis sweep (`/api/cron/analyze-mentions`, after `applyAnalysisOutcome`, using `getServiceDataSource()` + per-org scope, D88 system actor) — never from a page request.

Phase 2 design (data model, semantics, ordered tasks) is in the Phase 2 section near the end of this plan. It deliberately stays at design resolution; it must be re-planned against the codebase after Phase 1 ships and prerequisites 1–4 land, because each prerequisite reshapes an executor.

---

## 4. Recommended UX and route structure

**Dedicated routes, not a side panel.** The builder has ~10 interactive sub-areas (identity, priority, conditions list, actions list, sentence, validation, readiness, simulation, audit trail); the reference layout's 5-column panel cannot hold it, and CLAUDE.md's route list fixes `/rules` while permitting subroutes (precedent: `/integrations/google-business-profile/setup`).

- **`/rules`** — list. URL-backed status filter `?status=active|inactive|draft` (anything else, including absent, = all). Counts computed from the unarchived rule set, so they stay accurate regardless of filter. Row click (via `DataTable.rowHref`) navigates to `/rules/[ruleId]`. The enable switch stays independently operable (toggle wrapper becomes `relative` so it sits above the row-link overlay; it is separately tabbable, so keyboard users reach both row and switch). "1 / 2 actions" becomes "1 condition · 2 actions". A persistent truthfulness note replaces the current blurb: rules are recorded and simulated; Lia does not yet apply them to incoming mentions. "New rule" is a link-button to `/rules/new` for `automation_rule.manage` holders; for other roles it renders disabled with the sentence "Your role can view rules but not create them."
- **`/rules/new`** — the builder in create mode. Saving creates a draft and navigates to `/rules/[ruleId]`.
- **`/rules/[ruleId]`** — one rule: plain-language sentence, builder (editable when draft/inactive and the caller holds `manage`; read-only otherwise, with "Disable this rule to edit it" on active rules), activation-readiness checklist, simulation panel, duplicate/archive controls, and the rule's audit trail (`auditEvents.list(scope, { entityType: "automation_rule", entityId })` rendered with `Timeline`). Unknown, cross-tenant, or archived-and-purged IDs → `get` returns `null` → `notFound()`. Browser history, refresh, and direct URLs all work because state *is* the URL.

Keyboard: rows are tabbable anchors (DataTable already renders them), the toggle is a `role="switch"` button, and every builder control is a native form element; condition/action reordering uses up/down buttons rather than drag.

---

## 5. Rule lifecycle and activation state machine

Statuses stay `draft | inactive | active` (no enum migration). Two new concepts: **revision** (integer, bumped by every structural edit; the optimistic-concurrency token) and **simulatedRevision** (the revision that was last simulated). Archival is a nullable `archivedAt` timestamp, not a status.

```
                 create / duplicate / template
                            │
                            ▼
                        ┌───────┐  update (revision++)
             ┌────────► │ draft │ ◄────────────┐
             │          └───┬───┘              │ (self)
             │              │ simulate         │
             │              ▼  (simulatedRevision = revision)
             │          draft, simulation-fresh
             │              │ enable — only if activationProblems() = []
             │              ▼
        disable         ┌────────┐
             │          │ active │   structural edit REFUSED
             │          └───┬────┘   ("Disable this rule to edit it.")
             │              │ disable
             │              ▼
             │         ┌──────────┐  update (revision++ ⇒ simulation stale)
             └─────────┤ inactive │ ◄─── (self)
                       └────┬─────┘
                            │ enable — same gate: activationProblems() = []
                            ▼
                          active

draft or inactive ──archive──► archivedAt set (recoverable; hidden from list;
                               audit history preserved; active rules cannot be archived)
```

Rules, stated precisely:

- New rules (create, duplicate, template) start as `draft`, `revision 1`, `simulatedRevision null`.
- Drafts may be incomplete: empty conditions and empty actions are saveable. The entity schema drops `actions.min(1)`; completeness is an **activation** requirement, not a save requirement.
- Every structural update (name/description/priority/conditions/actions) bumps `revision`. Because activation requires `simulatedRevision === revision`, an edit automatically invalidates the previous simulation — no separate flag to forget.
- Active rules cannot be structurally edited: the update action and both repositories refuse. The flow is disable → edit → re-simulate → enable. Saving an edit can never silently change live policy.
- `setEnabled(true)` — in the action *and* as a backstop in both adapters — requires `activationProblems(rule)` to be empty (Section 7 defines the checks). Re-enabling an untouched inactive rule passes without re-simulating, because its `simulatedRevision` still equals its `revision`.
- `lastRunAt` is written by nothing in Phase 1 and only by real execution in Phase 2. Saves, previews, and simulations never touch it.
- Archive replaces delete: draft and inactive rules only, `archivedAt = now()`, excluded from the default list, `get` still returns them (rendered read-only with an "Archived" badge), audit history intact. No hard delete exists (RLS has no DELETE policy, and that stays true).
- Optimistic concurrency: `update` carries `expectedRevision`; a mismatch is a `conflict` — "Someone else changed this rule since you loaded it. Reload to see the latest version."

---

## 6. Exact condition semantics

**V1 combination model: all conditions must match (AND), stated visibly in the builder as "Match when all of the following are true". No nesting** — no product decision requires OR groups, and the ledger's minimal-boundary discipline (D9/D35/D78) argues against speculative expression trees. A rule with **zero conditions never matches anything** at evaluation time, and activation separately requires ≥ 1 condition, so "match everything" cannot be created by accident.

Field-by-field, using a dedicated ascending rank (`low 0 < medium 1 < high 2 < critical 3` — deliberately not reusing `RISK_LEVEL_SEVERITY`, which is worst-first for queue sorting):

| Field | Operators | Subject source | Null handling |
|---|---|---|---|
| `platform` | is, is_not | connection lookup via `platformConnectionId` | unresolvable connection ⇒ no match |
| `source_type` | is, is_not | `mention.sourceType` | never null |
| `sentiment` | is, is_not | `mention.sentiment` (denormalized) | `"unknown"` is a real value, matchable |
| `risk_level` | is, is_not, at_least, at_most | `mention.riskLevel` (denormalized) | never null (defaults `low`) |
| `rating` | is, greater_than, less_than | `mention.rating` | null (non-review sources) ⇒ **no match, any operator** |
| `relevance_score` | greater_than, less_than | `mention.relevanceScore` | null ⇒ no match |
| `location` | is, is_not | `mention.locationId` | null ⇒ no match, **including is_not** |
| `mention_status` | is, is_not | `mention.status` | never null |

**The null rule, uniformly: a condition never matches a subject whose field is unknown, whatever the operator — including `is_not`.** Rationale: `is_not` firing on unknown data would let rules act on mentions the author never reasoned about. This is documented in the evaluator and pinned by tests.

Comparisons are strict (`greater_than` is `>`, not `>=`); boundary tests pin this. `at_least`/`at_most` are inclusive rank comparisons. Duplicate or mutually-contradictory conditions are legal to save (they simply never match); contradiction *warnings* are deferred work.

---

## 7. Action capability and conflict table

One source of truth: `src/lib/rules/capabilities.ts`. Nothing else — not Zod validity, not the UI — decides activatability.

| Action | Semantics resolved | Configurable in builder | Simulatable | Executable today | Why / blocker |
|---|---|---|---|---|---|
| `set_status` | Sets the mention's status | Yes | Yes | **Yes** | `mentions.updateStatus` exists |
| `escalate` | Creates an open, **unassigned** escalation for the mention (dedupes per mention) | Yes — with no assignee field; the schema's `assigneeUserId` is always `null` in V1 (D38: picking an owner is a human decision) | Yes | **Yes** | `escalations.create` exists |
| `generate_draft` | Would draft a reply in the organization's brand voice; `voiceProfile` becomes `null` = "the brand voice" (slugs reference nothing) | Shown disabled | Yes (projected) | No | No `AiProvider.draftResponse`, no `responseDrafts.create` |
| `require_approval` | Would create a pending approval on the mention's draft | Shown disabled | Yes (projected) | No | Approvals can only be decided, never raised |
| `notify` | Would deliver an in-app/email notification | Shown disabled | Yes (projected) | No | No notification system; email is help-form only |
| `auto_publish` | Would publish an approved-safe reply without a human | Shown disabled | Yes (projected, always reported blocked) | No | No connector publishes (`canPublishResponses` false everywhere); additionally gated by the strengthened safety check below |
| `assign` | **Undefined** — mentions have no assignee | **Hidden** | No | No | No target entity; existing rules containing it render read-only with an "unsupported action" note and cannot activate |
| `tag` | **Undefined** — nothing has tags | **Hidden** | No | No | Same |

**Strengthened `isAutoPublishSafe`** (replaces the current body; same export so `tests/seed-dataset.test.ts` keeps importing it). A rule containing `auto_publish` passes only if **all** hold:

1. A `sentiment is positive` condition exists.
2. A risk condition restricted to **low only**: `risk_level is low` or `at_most low`. `at_most medium` — today's bug — fails.
3. A `source_type is <routine review source>` condition exists (`google_review`, `yelp_review`, `trustpilot_review`, `tripadvisor_review`). Reddit/news/comments can never auto-publish (spec: approval-first).
4. No `escalate` and no `require_approval` action on the same rule — approval wins every conflict, so the combination is invalid rather than silently reordered.

Runtime requirements (working publishing implementation, connected + authorized platform, `canPublishResponses`, platform-required human approval) belong to the capability registry and to Phase 2's per-execution subject — today they all fail, so `auto_publish` is not activatable regardless. Facts-requiring-verification is an analysis-level concern recorded as deferred work (the analysis output has no such flag yet).

**Guardrails enforced at activation (`activationProblems`):**

- ≥ 1 condition, ≥ 1 action.
- Every action executable per the registry.
- `isAutoPublishSafe` (as above).
- `require_approval` + `auto_publish` together: refused.
- Two `set_status` actions: refused (contradictory writes).
- **High-risk non-overridability:** a rule whose actions include a terminal status (`set_status` to `dismissed` or `no_action_recommended`) is refused unless its conditions provably exclude high/critical risk — i.e. include `risk_level is low`, `is medium`, `at_most low`, or `at_most medium`. A customer rule can therefore never quietly dismiss what D38 escalates. (There is no rule action that can touch escalations' status at all, so suppression/downgrade of an existing escalation is structurally impossible.)
- Fresh simulation: `simulatedRevision === revision`.

Refused activations return the full problem list as a sentence **and** write an `automation_rule.activation_refused` audit event with the problem codes in metadata.

---

## 8. Data-model and migration changes

**One migration, no new tables:** `supabase/migrations/20260809000100_automation_rule_authoring.sql`

```sql
-- Rule authoring: revisions, simulation readiness, recoverable archiving,
-- and the authoring/simulation audit vocabulary.

alter table public.automation_rules
  add column revision integer not null default 1
    check (revision >= 1),
  add column last_simulated_at timestamptz,
  add column simulated_revision integer
    check (simulated_revision is null or simulated_revision >= 1),
  add column archived_at timestamptz;

comment on column public.automation_rules.revision is
  'Bumped on every structural edit. Optimistic-concurrency token; simulated_revision must equal it for activation.';
comment on column public.automation_rules.last_simulated_at is
  'When the rule was last simulated. Display only; readiness is simulated_revision = revision.';
comment on column public.automation_rules.simulated_revision is
  'The revision that was simulated. Editing bumps revision, which makes a prior simulation stale.';
comment on column public.automation_rules.archived_at is
  'Recoverable archive. Archived rules are hidden from the default list; history is preserved. There is no delete.';

-- Audit vocabulary: redefine in full (Postgres cannot extend a check
-- constraint; see 20260807000700_audit_vocabulary_merge.sql).
-- tests/audit-vocabulary-migrations.test.ts pins this list against
-- AUDIT_EVENT_TYPES in src/domain/enums.ts.
alter table public.audit_events
  drop constraint audit_events_known_event_type;

alter table public.audit_events
  add constraint audit_events_known_event_type check (
    event_type in (
      -- << the ENTIRE current AUDIT_EVENT_TYPES list from src/domain/enums.ts,
      --    copied verbatim (54 entries after this change), including the six new: >>
      'automation_rule.created',
      'automation_rule.updated',
      'automation_rule.duplicated',
      'automation_rule.archived',
      'automation_rule.simulated',
      'automation_rule.activation_refused'
      -- (plus all 48 existing entries — the vocabulary test fails if any is dropped)
    )
  );

comment on constraint audit_events_known_event_type on public.audit_events is
  'Closed list, mirroring AUDIT_EVENT_TYPES in src/domain/enums.ts. No event may carry tokens, prompts, review text, reviewer names, article titles, URLs, or publisher names in metadata.';
```

- **No RLS changes needed for correctness**: existing `automation_rules_insert`/`automation_rules_update` policies (owner/admin/communications_lead) already cover create, update, archive (an UPDATE), and simulation recording; select stays member-wide; there is deliberately still no DELETE policy. `supabase/tests/rls-verification.sql` gains a section asserting a communications lead **can** insert a rule in their own org and an analyst **cannot** (same shape as its section 8).
- **Domain entity** gains `revision`, `lastSimulatedAt`, `simulatedRevision`, `archivedAt`; `actions` loses `.min(1)`; `generate_draft.voiceProfile` becomes `.nullable()` (null = the organization's brand voice); `escalate.assigneeUserId` stays in the schema for backward compatibility but the builder always writes `null`.
- **`scripts/seed-sql-columns.ts`** `automation_rules` entry gains `"revision", "lastSimulatedAt", "simulatedRevision", "archivedAt"` (camelCase, matching the existing convention), keeping `tests/seed-generator-columns.test.ts` green; `supabase/seed.sql` is regenerated.
- **Execution-log table:** Phase 2 only (Section "Phase 2 design").

---

## 9. File-by-file change map

**Create — pure logic (`src/lib/rules/`, no I/O, fully unit-tested):**
- `src/lib/rules/evaluate.ts` — `RuleSubject`, `RISK_RANK`, `matchesCondition`, `matchesRule`
- `src/lib/rules/capabilities.ts` — the action capability registry
- `src/lib/rules/readiness.ts` — `activationProblems`, `admitsHighRisk`, draft-vs-activation validation
- `src/lib/rules/sentence.ts` — plain-language rendering
- `src/lib/rules/fields.ts` — builder metadata: per-field operator lists, value-input kinds, labels
- `src/lib/rules/templates.ts` — typed immutable templates
- `src/lib/rules/simulate.ts` — simulation service (reads via repositories, computes with `evaluate`)
- `src/lib/rules/search-params.ts` — `parseRuleStatusParam`

**Create — UI:**
- `src/app/(app)/rules/new/page.tsx`, `src/app/(app)/rules/[ruleId]/page.tsx` (+ `loading.tsx` for `[ruleId]`, `error.tsx` under `/rules`)
- `src/components/rules/rule-status-tabs.tsx` (client; URL-backed tabs)
- `src/components/rules/rule-builder.tsx` (client), `condition-editor.tsx`, `action-editor.tsx`
- `src/components/rules/readiness-checklist.tsx` (server), `simulation-panel.tsx` (client), `rule-templates-panel.tsx` (server + small client instantiate button), `rule-row-actions.tsx` (client: duplicate/archive with `ConfirmDialog`)

**Create — tests:** `tests/rules-evaluate.test.ts`, `tests/rules-readiness.test.ts`, `tests/rules-capabilities.test.ts`, `tests/rules-sentence.test.ts`, `tests/rules-templates.test.ts`, `tests/rules-simulation.test.ts`, `tests/rules-search-params.test.ts`, `tests/automation-repositories.test.ts`, `tests/automation-actions.test.ts`

**Create — migration:** `supabase/migrations/20260809000100_automation_rule_authoring.sql`

**Modify:**
- `src/domain/entities/automation.ts` — entity/new input schemas, strengthened `isAutoPublishSafe`
- `src/domain/enums.ts` — six new `AUDIT_EVENT_TYPES` entries
- `src/domain/index.ts` — export new schemas/types
- `src/lib/labels.ts` — six new `AUDIT_EVENT_LABELS` entries (compiler forces this: the record is exhaustive)
- `src/lib/auth/permissions.ts` — add `automation_rule.manage`
- `src/lib/audit/record.ts` — JSON-aware `toJson` + deep comparison in `diff`
- `src/lib/data/types.ts` — extended `AutomationRuleRepository`, `SimulationCandidate`, `MentionRepository.listSimulationCandidates`
- `src/lib/data/demo/index.ts`, `src/lib/data/supabase/index.ts`, `src/lib/data/supabase/mappers.ts` — implement all of the above in both adapters
- `src/app/actions/automation.ts` — five new actions + hardened toggle
- `src/app/(app)/rules/page.tsx` — filter wiring, columns, banner, links
- `src/components/rules/rule-toggle.tsx` — `relative` fix, draft tooltip copy
- `src/components/ui/segmented-tabs.tsx` — optional controlled `activeTabId` prop (backward compatible)
- `src/components/ui/button.tsx` — extract `buttonClassName()`; add `ButtonLink`
- `src/lib/seed/dataset.ts` — truthful seed remediation; `scripts/seed-sql-columns.ts`; regenerate `supabase/seed.sql`
- `supabase/tests/rls-verification.sql` — authoring role probes
- `tests/repositories.test.ts`, `tests/organization-isolation.test.ts`, `tests/permissions.test.ts`, `tests/audit.test.ts`, `tests/seed-dataset.test.ts` — updates described per task
- `docs/data-model.md`, `docs/architecture/current-state.md` — Section 15

---

## 10. Ordered implementation tasks

Notation: every code step shows the real content; run steps show the exact command and expected outcome. UI tasks (node-only test env) verify via `npm run lint && npm run typecheck && npm run build` plus the manual criteria in Section 12.

### Task 1: Domain schema — revisions, archival, honest inputs

**Files:**
- Modify: `src/domain/entities/automation.ts`
- Modify: `src/domain/index.ts` (re-export new schemas/types; it currently `export *`s entities — verify and only add if exports are explicit)
- Test: `tests/seed-dataset.test.ts` (existing round-trip keeps passing), new assertions come in Task 13

**Interfaces (Produces):**
```ts
// Entity gains:
revision: number;                    // int ≥ 1
lastSimulatedAt: Timestamp | null;
simulatedRevision: number | null;
archivedAt: Timestamp | null;
// actions: z.array(ruleActionSchema)  — .min(1) removed
// generate_draft: { type: "generate_draft"; voiceProfile: string | null }

export const automationRuleConfigSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().max(1000).nullable().default(null),
  priority: z.number().int().min(0).max(1000).default(100),
  conditions: z.array(ruleConditionSchema).max(20).default([]),
  actions: z.array(ruleActionSchema).max(10).default([]),
});
export type AutomationRuleConfig = z.infer<typeof automationRuleConfigSchema>;

export const createAutomationRuleInputSchema = automationRuleConfigSchema;
export const updateAutomationRuleInputSchema = z.object({
  automationRuleId: uuidSchema,
  expectedRevision: z.number().int().min(1),
  config: automationRuleConfigSchema,
});
export const duplicateAutomationRuleInputSchema = z.object({ automationRuleId: uuidSchema });
export const archiveAutomationRuleInputSchema = z.object({ automationRuleId: uuidSchema });
export const simulateAutomationRuleInputSchema = z.object({ automationRuleId: uuidSchema });
// automationRuleFilterSchema gains: includeArchived: z.boolean().optional()
```

- [ ] **Step 1:** Apply the schema changes above. Keep `isAutoPublishSafe`'s current body for now (Task 3 replaces it — separate commit so the safety change is reviewable alone).
- [ ] **Step 2:** `npm run typecheck` — expect failures only in `seed/dataset.ts` (missing new fields) and the supabase mapper. Add the four fields to the mapper (`revision: row.revision`, `lastSimulatedAt: isoOrNull(row.last_simulated_at)`, `simulatedRevision: row.simulated_revision ?? null`, `archivedAt: isoOrNull(row.archived_at)`) and give every seeded rule `revision: 1, lastSimulatedAt: null, simulatedRevision: null, archivedAt: null` as a mechanical stopgap (Task 13 does the real remediation). `voiceProfile` values become `null`.
- [ ] **Step 3:** `npm run typecheck && npm run test` — green (seed round-trip now parses the new shape).
- [ ] **Step 4:** Commit: `feat(domain): rule revisions, simulation readiness, archival, authoring input schemas`

### Task 2: Pure evaluator

**Files:** Create `src/lib/rules/evaluate.ts`; Test `tests/rules-evaluate.test.ts`

**Produces:**
```ts
export const RISK_RANK: Record<RiskLevel, number> = { low: 0, medium: 1, high: 2, critical: 3 };
export interface RuleSubject {
  mentionId: string;
  platform: Platform | null;
  sourceType: MentionSourceType;
  locationId: string | null;
  rating: number | null;
  status: MentionStatus;
  sentiment: Sentiment;
  riskLevel: RiskLevel;
  relevanceScore: number | null;
}
export function matchesCondition(subject: RuleSubject, condition: RuleCondition): boolean;
export function matchesRule(subject: RuleSubject, conditions: readonly RuleCondition[]): boolean;
```

- [ ] **Step 1: failing tests.** Table-driven over every field × operator, plus boundaries and nulls:

```ts
import { describe, expect, it } from "vitest";
import { matchesCondition, matchesRule, RISK_RANK, type RuleSubject } from "@/lib/rules/evaluate";
import type { RuleCondition } from "@/domain";

const subject = (overrides: Partial<RuleSubject> = {}): RuleSubject => ({
  mentionId: "m1", platform: "google_business_profile", sourceType: "google_review",
  locationId: "loc-1", rating: 4, status: "analyzed", sentiment: "positive",
  riskLevel: "low", relevanceScore: 0.8, ...overrides,
});

// [condition, subject overrides, expected]
const CASES: Array<[RuleCondition, Partial<RuleSubject>, boolean]> = [
  [{ field: "platform", operator: "is", value: "reddit" }, { platform: "reddit" }, true],
  [{ field: "platform", operator: "is", value: "reddit" }, {}, false],
  [{ field: "platform", operator: "is_not", value: "reddit" }, {}, true],
  [{ field: "platform", operator: "is_not", value: "reddit" }, { platform: null }, false], // null never matches
  [{ field: "source_type", operator: "is", value: "google_review" }, {}, true],
  [{ field: "source_type", operator: "is_not", value: "news_article" }, {}, true],
  [{ field: "sentiment", operator: "is", value: "unknown" }, { sentiment: "unknown" }, true],
  [{ field: "risk_level", operator: "at_least", value: "high" }, { riskLevel: "high" }, true],      // inclusive
  [{ field: "risk_level", operator: "at_least", value: "high" }, { riskLevel: "critical" }, true],
  [{ field: "risk_level", operator: "at_least", value: "high" }, { riskLevel: "medium" }, false],
  [{ field: "risk_level", operator: "at_most", value: "medium" }, { riskLevel: "medium" }, true],   // inclusive
  [{ field: "risk_level", operator: "at_most", value: "medium" }, { riskLevel: "high" }, false],
  [{ field: "risk_level", operator: "is_not", value: "low" }, { riskLevel: "low" }, false],
  [{ field: "rating", operator: "greater_than", value: 3 }, { rating: 3 }, false],                  // strict
  [{ field: "rating", operator: "greater_than", value: 3 }, { rating: 3.5 }, true],
  [{ field: "rating", operator: "less_than", value: 2 }, { rating: 2 }, false],
  [{ field: "rating", operator: "is", value: 5 }, { rating: 5 }, true],
  [{ field: "rating", operator: "less_than", value: 5 }, { rating: null }, false],                  // null
  [{ field: "relevance_score", operator: "less_than", value: 0.3 }, { relevanceScore: 0.3 }, false],
  [{ field: "relevance_score", operator: "greater_than", value: 0.7 }, { relevanceScore: null }, false],
  [{ field: "location", operator: "is", value: "loc-1" }, {}, true],
  [{ field: "location", operator: "is_not", value: "loc-2" }, { locationId: null }, false],         // null
  [{ field: "mention_status", operator: "is", value: "escalated" }, { status: "escalated" }, true],
];

describe("matchesCondition", () => {
  it.each(CASES)("%j on %j → %s", (condition, overrides, expected) => {
    expect(matchesCondition(subject(overrides), condition)).toBe(expected);
  });
  it("orders risk ascending low<medium<high<critical", () => {
    expect(RISK_RANK.low).toBeLessThan(RISK_RANK.medium);
    expect(RISK_RANK.medium).toBeLessThan(RISK_RANK.high);
    expect(RISK_RANK.high).toBeLessThan(RISK_RANK.critical);
  });
});

describe("matchesRule", () => {
  it("requires every condition (AND)", () => {
    const conditions: RuleCondition[] = [
      { field: "sentiment", operator: "is", value: "positive" },
      { field: "risk_level", operator: "is", value: "low" },
    ];
    expect(matchesRule(subject(), conditions)).toBe(true);
    expect(matchesRule(subject({ riskLevel: "medium" }), conditions)).toBe(false);
  });
  it("never matches with zero conditions", () => {
    expect(matchesRule(subject(), [])).toBe(false);
  });
});
```

*(In the real file, extend `CASES` until every field has every operator covered, including `platform is` with `platform: null`, `location is` mismatch, `source_type is` mismatch, `sentiment is_not`, `mention_status is_not`, `risk_level is`, and `rating is` mismatch — the grid in Section 6 is the checklist.)*

- [ ] **Step 2:** `npx vitest run tests/rules-evaluate.test.ts` — FAIL (module not found).
- [ ] **Step 3: implement** — an exhaustive `switch` on `condition.field` (TypeScript exhaustiveness via `condition satisfies never` in the default), each enum field handling `is`/`is_not` with the null-never-matches rule first, `risk_level` comparing `RISK_RANK` values, numeric fields returning `false` on null then strict comparisons. `matchesRule` = `conditions.length > 0 && conditions.every(...)`. Module doc comment states the null rule and that Phase 2 execution must use this exact module.
- [ ] **Step 4:** `npx vitest run tests/rules-evaluate.test.ts` — PASS.
- [ ] **Step 5:** Commit: `feat(rules): pure condition evaluator with explicit null semantics`

### Task 3: Capability registry, readiness, strengthened auto-publish

**Files:** Create `src/lib/rules/capabilities.ts`, `src/lib/rules/readiness.ts`; Modify `src/domain/entities/automation.ts` (replace `isAutoPublishSafe` body + doc comment); Tests `tests/rules-capabilities.test.ts`, `tests/rules-readiness.test.ts`

**Produces:**
```ts
// capabilities.ts
export type RuleActionType = RuleAction["type"];
export interface ActionCapability {
  type: RuleActionType;
  label: string;                       // sentence-case builder label
  executable: boolean;
  showInBuilder: boolean;              // false = hidden (assign, tag)
  blockedReason: string | null;        // precise sentence when not executable
}
export const ACTION_CAPABILITIES: Record<RuleActionType, ActionCapability>;
export function isActionExecutable(type: RuleActionType): boolean;

// readiness.ts
export interface ActivationProblem { code: string; message: string }
export function admitsHighRisk(conditions: readonly RuleCondition[]): boolean;
export function activationProblems(rule: Pick<AutomationRule,
  "conditions" | "actions" | "revision" | "simulatedRevision">): ActivationProblem[];

// automation.ts — same export, new body
export function isAutoPublishSafe(rule: { conditions: RuleCondition[]; actions: RuleAction[] }): boolean;
```

- [ ] **Step 1: failing tests.**

```ts
// tests/rules-capabilities.test.ts
import { ACTION_CAPABILITIES, isActionExecutable } from "@/lib/rules/capabilities";
import { ruleActionSchema } from "@/domain/entities/automation";

it("covers every action type in the schema", () => {
  const schemaTypes = ruleActionSchema.options.map((o) => o.shape.type.value).sort();
  expect(Object.keys(ACTION_CAPABILITIES).sort()).toEqual(schemaTypes);
});
it("only set_status and escalate are executable today", () => {
  const executable = Object.values(ACTION_CAPABILITIES).filter((c) => c.executable).map((c) => c.type).sort();
  expect(executable).toEqual(["escalate", "set_status"]);
});
it("assign and tag are hidden; every blocked action explains itself", () => {
  expect(ACTION_CAPABILITIES.assign.showInBuilder).toBe(false);
  expect(ACTION_CAPABILITIES.tag.showInBuilder).toBe(false);
  for (const c of Object.values(ACTION_CAPABILITIES)) {
    if (!c.executable) expect(c.blockedReason).toMatch(/\w{10,}/);
  }
});
it("auto_publish is not executable until a publishing connector exists", () => {
  expect(isActionExecutable("auto_publish")).toBe(false);
});
```

```ts
// tests/rules-readiness.test.ts — the essential cases
const ready = { conditions: [RISK_LOW], actions: [ESCALATE], revision: 3, simulatedRevision: 3 };
// where RISK_LOW = { field:"risk_level", operator:"is", value:"low" },
//       ESCALATE = { type:"escalate", assigneeUserId: null },
//       SET_DISMISSED = { type:"set_status", status:"dismissed" }

it("a complete, simulated, executable rule has no problems", () =>
  expect(activationProblems(ready)).toEqual([]));
it("refuses zero conditions and zero actions", () => {
  expect(codes({ ...ready, conditions: [] })).toContain("no_conditions");
  expect(codes({ ...ready, actions: [] })).toContain("no_actions");
});
it("refuses unexecutable actions with the action named", () =>
  expect(codes({ ...ready, actions: [{ type: "notify", channel: "email" }] }))
    .toContain("unexecutable_action:notify"));
it("refuses stale simulation", () =>
  expect(codes({ ...ready, simulatedRevision: 2 })).toContain("stale_simulation"));
it("refuses never-simulated", () =>
  expect(codes({ ...ready, simulatedRevision: null })).toContain("stale_simulation"));
it("refuses terminal statuses that admit high risk", () => {
  expect(codes({ ...ready, conditions: [{ field: "relevance_score", operator: "less_than", value: 0.3 }],
    actions: [SET_DISMISSED] })).toContain("high_risk_terminal_status");
  expect(codes({ ...ready, conditions: [RISK_LOW,
    { field: "relevance_score", operator: "less_than", value: 0.3 }], actions: [SET_DISMISSED] }))
    .not.toContain("high_risk_terminal_status");
});
it("is_not high does not count as excluding high risk (critical still admitted)", () =>
  expect(admitsHighRisk([{ field: "risk_level", operator: "is_not", value: "high" }])).toBe(true));
it("refuses approval + auto-publish together and two set_status actions", () => { /* codes as in Section 7 */ });

// isAutoPublishSafe (import from @/domain):
it("rejects at_most medium — the current bug", () =>
  expect(isAutoPublishSafe({ conditions: [{ field: "risk_level", operator: "at_most", value: "medium" }],
    actions: [{ type: "auto_publish" }] })).toBe(false));
it("requires positive sentiment AND low-only risk AND a routine review source", () => { /* each missing leg fails; all present passes */ });
it("passes any rule without auto_publish", () =>
  expect(isAutoPublishSafe({ conditions: [], actions: [ESCALATE] })).toBe(true));
```

- [ ] **Step 2:** Run both files — FAIL.
- [ ] **Step 3: implement.** Registry entries exactly per the Section 7 table (reasons as full sentences, e.g. `auto_publish`: "Lia cannot publish replies to any platform yet. When publishing ships, auto-publish will also require positive, low-risk, routine review conditions."). `admitsHighRisk` returns false only when some condition is `risk_level is low|medium` or `at_most low|medium`. `activationProblems` checks in the order listed in Section 7 and appends `stale_simulation` last ("Simulate this rule before enabling it." — must keep matching the existing `/simulate/i` test). New `isAutoPublishSafe` per Section 7 with `ROUTINE_REVIEW_SOURCES` const.
- [ ] **Step 4:** Run — PASS. Also `npx vitest run tests/seed-dataset.test.ts` — the auto-publish guardrail test may FAIL until Task 13 fixes the seed (auto-positive currently lacks nothing — it has positive+low+google_review and no conflicting action, so it should still pass; verify).
- [ ] **Step 5:** Commit: `feat(rules): action capability registry, activation readiness, strengthened auto-publish safety`

### Task 4: Plain-language sentence + builder field metadata

**Files:** Create `src/lib/rules/sentence.ts`, `src/lib/rules/fields.ts`; Test `tests/rules-sentence.test.ts`

**Produces:**
```ts
// fields.ts — drives the builder UI, single source for operator/value editors
export interface ConditionFieldMeta {
  field: RuleCondition["field"];
  label: string;                                   // "Risk level"
  operators: { value: string; label: string }[];   // exactly the schema's operators
  input: "platform" | "source_type" | "sentiment" | "risk_level" | "mention_status"
       | "location" | "rating" | "relevance_score";
}
export const CONDITION_FIELDS: ConditionFieldMeta[];

// sentence.ts
export interface SentenceContext {
  locationNames: ReadonlyMap<string, string>;      // id → name
}
export function ruleSentence(config: Pick<AutomationRuleConfig, "conditions" | "actions">,
  context: SentenceContext): string;
```

- [ ] **Step 1: failing tests.** Pin the exact copy so it can't drift silently:

```ts
const names = new Map([["loc-1", "Maison Laurent"]]);
it("renders conditions and actions as one sentence", () => {
  expect(ruleSentence({
    conditions: [
      { field: "source_type", operator: "is", value: "google_review" },
      { field: "rating", operator: "greater_than", value: 3 },
      { field: "risk_level", operator: "is", value: "low" },
    ],
    actions: [{ type: "escalate", assigneeUserId: null }, { type: "set_status", status: "monitoring" }],
  }, { locationNames: names })).toBe(
    "When the source is a Google review, the rating is above 3, and the risk is low — escalate it and set its status to Monitoring.",
  );
});
it("names locations and survives unknown ids", () => { /* "the location is Maison Laurent"; unknown id → "a specific location" */ });
it("describes incompleteness honestly", () => {
  expect(ruleSentence({ conditions: [], actions: [] }, { locationNames: names }))
    .toBe("This rule has no conditions yet, so it would never match anything.");
});
it("renders generate_draft with a null voice as the brand voice", () => { /* "draft a reply in your brand voice" */ });
```

- [ ] **Step 2:** Run — FAIL. **Step 3:** Implement using `SOURCE_TYPE_LABELS`, `PLATFORM_LABELS`, `SENTIMENT_LABELS`, `RISK_LEVEL_LABELS`, `MENTION_STATUS_LABELS` from `src/lib/labels.ts`; Oxford-comma-free "a, b, and c" joiner; per-action phrases (escalate → "escalate it", set_status → "set its status to X", require_approval → "hold it for approval", generate_draft → "draft a reply in your brand voice", auto_publish → "publish the reply automatically", notify → "send a notification", assign/tag → "apply an unsupported action (assign/tag)"). `CONDITION_FIELDS` mirrors the Zod union exactly (a test asserts field/operator parity with `ruleConditionSchema.options`).
- [ ] **Step 4:** PASS. **Step 5:** Commit: `feat(rules): plain-language rule sentences and builder field metadata`

### Task 5: Audit — six new event types + structured serialization

**Files:** Modify `src/domain/enums.ts`, `src/lib/labels.ts` (AUDIT_EVENT_LABELS is exhaustive — compiler enforces), `src/lib/audit/record.ts`; Test additions in `tests/audit.test.ts`

- [ ] **Step 1: failing tests** in `tests/audit.test.ts`:

```ts
it("serialises arrays and objects as JSON values, not strings", () => {
  const before = { conditions: [{ field: "risk_level", operator: "is", value: "low" }], priority: 10 };
  const after  = { conditions: [{ field: "risk_level", operator: "is", value: "high" }], priority: 10 };
  const { previousState, newState } = diff(before, after, ["conditions", "priority"]);
  expect(previousState.conditions).toEqual([{ field: "risk_level", operator: "is", value: "low" }]);
  expect(newState.conditions).toEqual([{ field: "risk_level", operator: "is", value: "high" }]);
  expect(previousState.priority).toBeUndefined();   // deep-equal fields stay out of the diff
});
it("treats deep-equal arrays as unchanged", () => {
  const value = [{ type: "escalate", assigneeUserId: null }];
  const { previousState } = diff({ actions: value }, { actions: structuredClone(value) }, ["actions"]);
  expect(previousState).toEqual({});
});
```

- [ ] **Step 2:** FAIL (today both come back as strings / always-changed).
- [ ] **Step 3: implement.** In `record.ts`: `toJson` recurses (primitives pass through; arrays map; plain objects map entries; anything else — Date, class instance — still `String(value)` with a comment saying why); `diff` compares primitives with `===` and non-primitives with `JSON.stringify(a) === JSON.stringify(b)` (key order is stable here because both sides come from the same Zod-parsed shapes). Add the six event types to `AUDIT_EVENT_TYPES` in `enums.ts` with a comment: "Rule authoring. previousState/newState carry the rule's own configuration — conditions, actions, priority — never mention content. `automation_rule.simulated` metadata carries counts only." Add the six `AUDIT_EVENT_LABELS` ("Rule created", "Rule updated", "Rule duplicated", "Rule archived", "Rule simulated", "Rule activation refused").
- [ ] **Step 4:** `npx vitest run tests/audit.test.ts` — PASS; `npx vitest run tests/audit-vocabulary-migrations.test.ts` — **FAIL** (constraint out of date). That failure is correct and is fixed by Task 6; commit anyway with the note, or fold Steps into Task 6's commit if the execution harness requires green commits — preferred: do Task 6 immediately and commit both together.
- [ ] **Step 5:** Commit (with Task 6): see below.

### Task 6: Migration + seed column contract

**Files:** Create `supabase/migrations/20260809000100_automation_rule_authoring.sql` (full SQL in Section 8 — the audit constraint body must be the verbatim, complete `AUDIT_EVENT_TYPES` list, all 54 entries); Modify `scripts/seed-sql-columns.ts` (add the four camelCase columns), `supabase/tests/rls-verification.sql` (new section: communications lead inserts a rule successfully; analyst insert refused — copy the become/check shape of its section 8)

- [ ] **Step 1:** Write the migration and script changes.
- [ ] **Step 2:** `npm run db:validate` — PASS (parses). `npx vitest run tests/audit-vocabulary-migrations.test.ts tests/seed-generator-columns.test.ts` — **seed-generator FAILS** until the seed emits the new columns; regenerate: run the seed generation script (see `package.json` — the generator is `scripts/generate-seed-sql.ts`; use its existing npm script) → both PASS.
- [ ] **Step 3:** `npm run test` — green. Commit: `feat(db): rule authoring columns and audit vocabulary for rule lifecycle events`

### Task 7: Permission `automation_rule.manage`

**Files:** Modify `src/lib/auth/permissions.ts`; Test `tests/permissions.test.ts`

- [ ] **Step 1: failing tests:**

```ts
it("automation_rule.manage matches the RLS write roles exactly", () => {
  expect(can("owner", "automation_rule.manage")).toBe(true);
  expect(can("admin", "automation_rule.manage")).toBe(true);
  expect(can("communications_lead", "automation_rule.manage")).toBe(true);
  for (const role of ["location_manager", "approver", "analyst", "viewer"] as const)
    expect(can(role, "automation_rule.manage")).toBe(false);
});
it("communications_lead can toggle rules", () =>
  expect(can("communications_lead", "automation_rule.toggle")).toBe(true));
```

- [ ] **Step 2:** FAIL. **Step 3:** Add `"automation_rule.manage"` to `PERMISSIONS` and the matrix with roles `["owner", "admin", "communications_lead"]` and this comment: "Structural rule changes. Same roles as `automation_rule.toggle` today — and as the `automation_rules_insert`/`update` RLS policies — but a distinct name, because writing organizational policy and arming it are different acts, and the day the product wants approvers to activate rules they did not author, that is a one-line edit here." The analysts/viewers-hold-nothing invariant (`tests/permissions.test.ts:26-29`) stays green by construction.
- [ ] **Step 4:** PASS. Commit: `feat(auth): automation_rule.manage permission for structural rule changes`

### Task 8: Repository contract + demo adapter

**Files:** Modify `src/lib/data/types.ts`, `src/lib/data/demo/index.ts`; Test `tests/automation-repositories.test.ts` (new), update `tests/repositories.test.ts`, `tests/organization-isolation.test.ts`

**Produces (the contract both adapters implement):**
```ts
export interface AutomationRuleRepository {
  list(scope: OrganizationScope, filter?: AutomationRuleFilter): Promise<AutomationRule[]>;
  get(scope: OrganizationScope, ruleId: string): Promise<AutomationRule | null>;
  create(scope: OrganizationScope, input: AutomationRuleConfig): Promise<AutomationRule>;
  /**
   * Structural edit. Refused (conflict) when the rule is active or archived, or
   * when expectedRevision no longer matches. Bumps revision.
   */
  update(scope: OrganizationScope, ruleId: string, input: AutomationRuleConfig,
    expectedRevision: number): Promise<AutomationRule>;
  /** Draft/inactive only. Sets archivedAt; never deletes. */
  archive(scope: OrganizationScope, ruleId: string): Promise<AutomationRule>;
  /** Marks the given revision simulated. Refused when the revision is not current. */
  recordSimulation(scope: OrganizationScope, ruleId: string, revision: number): Promise<AutomationRule>;
  /** Enabling requires activationProblems(rule) to be empty — enforced here as backstop. */
  setEnabled(scope: OrganizationScope, ruleId: string, enabled: boolean): Promise<AutomationRule>;
}

// MentionRepository gains:
listSimulationCandidates(scope: OrganizationScope,
  input: { publishedAfter: Timestamp; limit: number }): Promise<SimulationCandidate[]>;

export interface SimulationCandidate {
  id: string; platformConnectionId: string; locationId: string | null;
  sourceType: MentionSourceType; rating: number | null; status: MentionStatus;
  sentiment: Sentiment; riskLevel: RiskLevel; relevanceScore: number | null;
  publishedAt: Timestamp; excerpt: string;
}
```

- [ ] **Step 1: failing tests** (`freshDataSource()` + `ushg`/`harbor` scope helpers from `tests/helpers/scope.ts`):
  - `create` returns a draft with `revision 1`, `simulatedRevision null`, and the row appears in `list`.
  - `create` with a duplicate name → `conflict` (demo enforces the unique-name-per-org constraint the DB has).
  - `update` bumps `revision`, replaces config; with a wrong `expectedRevision` → `conflict` matching `/changed .* reload/i` and the row is untouched (the optimistic-concurrency test: two "administrators" both `get` at revision 1, first update succeeds, second gets conflict).
  - `update` on an active rule → `conflict` `/disable/i`; on an archived rule → `conflict`.
  - `archive` on a draft sets `archivedAt`, removes it from default `list`, keeps it in `list(scope, { includeArchived: true })` and in `get`; on an active rule → `conflict`.
  - `recordSimulation(ruleId, rule.revision)` sets `simulatedRevision`/`lastSimulatedAt`; with a stale revision → `conflict`.
  - `setEnabled(true)` succeeds for a draft whose simulation is fresh and whose actions are executable, and refuses (message listing the problems, still matching `/simulate/i` when that's the gap) otherwise — including a rule containing `notify`.
  - Tenant isolation for every new method: `harbor` scope on a ushg rule id → `notFound`/null (mirror the existing isolation tests).
  - `listSimulationCandidates` respects `publishedAfter`, `limit`, and scope, and carries no full mention body (only `excerpt`).
- [ ] **Step 2:** FAIL. **Step 3: implement in the demo adapter.** `create`: validate via `automationRuleConfigSchema.parse` (reparse at the boundary, house style), reject duplicate names case-insensitively, `id: crypto.randomUUID()`, timestamps via the adapter's existing `nowIso()`. `update`: find → status/archival/revision guards → write with `revision + 1`. `setEnabled(true)`: replace the current draft-guard with `const problems = activationProblems(rule); if (problems.length > 0) throw conflict("This rule can't be enabled yet: " + problems.map(p => p.message).join(" "))`. `listSimulationCandidates`: filter org mentions by `publishedAt >= publishedAfter`, sort desc, slice to limit, map to the slim shape (`excerpt` = existing mention excerpt/body first 140 chars — reuse whatever excerpt field `Mention` already carries).
- [ ] **Step 4:** New suite PASS. Update the two existing suites: `tests/repositories.test.ts` "re-enables an inactive rule" must now use a rule that passes readiness — disable `escalate-high-risk` then re-enable it; add "refuses to re-enable a rule with unexecutable actions" using `media-watch` (notify). (These depend on Task 13's seed shape — if executing strictly in order, mark the media-watch case `it.todo` until Task 13, or reorder Tasks 8↔13; preferred: land Task 13's seed remediation **before** this task's Step 4. The commit sequence in Section 13 reflects that ordering.)
- [ ] **Step 5:** Commit: `feat(data): full automation rule CRUD, simulation readiness, and candidates in the demo adapter`

### Task 9: Supabase adapter parity

**Files:** Modify `src/lib/data/supabase/index.ts`, `src/lib/data/supabase/mappers.ts`

- [ ] **Step 1:** Implement the same seven methods with identical guard messages. Specifics: `create` → `.insert({ organization_id, name, description, priority, conditions, actions, status: 'draft', revision: 1 }).select("*").single()`, translating `23505` → conflict "A rule with this name already exists." via the adapter's existing `fail()`. `update` → guards from a fresh `get`, then `.update({...config columns, revision: expectedRevision + 1}).eq("organization_id", ...).eq("id", ...).eq("revision", expectedRevision).select("*").maybeSingle()`; a null row after a non-null `get` = lost race → conflict. `recordSimulation` → `.update({ last_simulated_at: new Date().toISOString(), simulated_revision: revision }).eq("revision", revision)` same pattern. `archive` → guards + `.update({ archived_at: ... })`. `setEnabled` → same `activationProblems` backstop before the write. `list` adds `.is("archived_at", null)` unless `includeArchived`. `listSimulationCandidates` → `client.from("mentions").select("id, platform_connection_id, location_id, source_type, rating, status, sentiment, risk_level, relevance_score, published_at, excerpt").eq("organization_id", scope.organizationId).gte("published_at", publishedAfter).order("published_at", { ascending: false }).limit(limit)` — one query, no N+1 (adjust the excerpt column name to whatever the mentions DDL actually calls it; check `20260801000100_initial_schema.sql` before writing).
- [ ] **Step 2:** `npm run typecheck && npm run test && npm run build` — green (no live-DB test exists for this adapter; parity is by construction and reviewed against the demo tests).
- [ ] **Step 3:** Commit: `feat(data): automation rule authoring in the supabase adapter`

### Task 10: Simulation service

**Files:** Create `src/lib/rules/simulate.ts`; Test `tests/rules-simulation.test.ts`

**Produces:**
```ts
export const SIMULATION_WINDOW_DAYS = 30;
export const SIMULATION_CANDIDATE_LIMIT = 500;
export interface SimulationResult {
  ruleId: string; revision: number; windowDays: number;
  evaluated: number; matched: number; matchRate: number;        // 0–1
  truncated: boolean;                                           // hit the candidate limit
  breakdowns: {
    sourceType: Record<string, number>; locationId: Record<string, number>;
    sentiment: Record<string, number>; riskLevel: Record<string, number>;
    rating: Record<string, number>;                             // "1".."5" | "unrated"
  };
  projectedActions: { type: RuleActionType; count: number; blocked: boolean; blockedReason: string | null }[];
  sample: { mentionId: string; sourceType: MentionSourceType; riskLevel: RiskLevel; excerpt: string }[]; // ≤ 5, excerpt ≤ 140 chars
}
export async function simulateRule(
  deps: { dataSource: LiaDataSource; scope: OrganizationScope },
  rule: AutomationRule,
  now: Date,                                                     // injected for testability
): Promise<SimulationResult>;
```

- [ ] **Step 1: failing tests** against `freshDataSource()` and the seeded corpus (22 USHG mentions):
  - Matched counts are correct for a hand-built rule (`sentiment is negative` + `source_type is google_review` → assert the exact count from the seed corpus; compute it in the test from `SEED_DATASET`, not as a magic number).
  - **Zero side effects:** `JSON.stringify` snapshots of mentions, drafts, escalations, and audit-event rows before/after `simulateRule` are identical; the rule row itself is untouched (the *service* does not write — `recordSimulation` is the action's separate step).
  - Platform conditions resolve through connections (rule on `platform is reddit` matches only reddit-connection mentions).
  - Window: a mention published 31 days before `now` is excluded.
  - `projectedActions` marks non-executable actions blocked with the registry's reason; executable ones unblocked.
  - `sample.length ≤ 5` and every excerpt ≤ 140 chars.
  - No AI: nothing in `src/lib/rules/` imports `@/ai` (assert via the module's design; the side-effect snapshot is the behavioral pin).
- [ ] **Step 2:** FAIL. **Step 3: implement.** `publishedAfter = new Date(now.getTime() - 30 * 864e5).toISOString()`; fetch `listSimulationCandidates` (limit `SIMULATION_CANDIDATE_LIMIT`, `truncated = candidates.length === limit`) and `platformConnections.list(scope)` in `Promise.all`; build `Map<connectionId, platform>`; map candidates → `RuleSubject`; evaluate with `matchesRule`; aggregate breakdowns; project actions from the registry.
- [ ] **Step 4:** PASS. Commit: `feat(rules): side-effect-free 30-day simulation service`

### Task 11: Server actions

**Files:** Modify `src/app/actions/automation.ts`; Test `tests/automation-actions.test.ts` (mock `@/lib/actions/guard` + `next/cache` per the house pattern in `tests/monitoring-actions.test.ts:28-56`)

**Produces** (all `(input: unknown) => Promise<ActionResult<...>>`):
- `createAutomationRuleAction` — parse `createAutomationRuleInputSchema` → `authorize("automation_rule.manage")` → `automationRules.create` → audit `automation_rule.created` (previousState null, newState = `{ name, priority, conditions, actions }`, metadata `{ ruleName }`) → `revalidatePath("/rules")` → returns the rule (UI navigates to `/rules/[id]`).
- `updateAutomationRuleAction` — parse update schema → authorize manage → `get` (notFound) → **action-level refusals with clear copy** for active ("Disable this rule to edit it.") and archived → `automationRules.update(..., expectedRevision)` → audit `automation_rule.updated` with `diff(existing, updated, ["name", "description", "priority", "conditions", "actions"])` (now JSON-structured per Task 5) → revalidate `/rules` and `/rules/${id}`.
- `duplicateAutomationRuleAction` — authorize manage → `get` source → derive a free name (`"${name} (copy)"`, then `" (copy 2)"`… up to 5, then conflict) → `create` with the source's config as a fresh draft → audit `automation_rule.duplicated` on the **new** rule, metadata `{ sourceRuleId, sourceRuleName }`.
- `archiveAutomationRuleAction` — authorize manage → `get` → `archive` → audit `automation_rule.archived`.
- `simulateAutomationRuleAction` — authorize manage → `get` (refuse archived) → `simulateRule(context, rule, new Date())` → `automationRules.recordSimulation(scope, ruleId, rule.revision)` → audit `automation_rule.simulated`, metadata `{ ruleName, evaluated, matched, truncated }` (counts only — never sample content) → revalidate `/rules/${id}` → returns `SimulationResult`.
- `setAutomationRuleEnabledAction` (**modified**) — after `get`, when enabling: `const problems = activationProblems(existing)`; if non-empty, audit `automation_rule.activation_refused` (metadata `{ ruleName, reasons: problems.map(p => p.code) }`) and return `failure("This rule can't be enabled yet: " + problems.map(p => p.message).join(" "))` **without** calling the repository; otherwise proceed as today.

- [ ] **Step 1: failing tests:** happy path + audit event emitted for each action (inspect `dataSource.auditEvents.list`); permission refusal for analyst/viewer/approver/location_manager on every manage action (mock `authorize` to throw the forbidden `DataError` when `can()` is false for the given role — follow the monitoring-actions harness exactly); toggle-refusal writes `activation_refused` with reason codes and no state change; update on active rule fails `/disable/i`; concurrency conflict surfaces the reload message; duplicate produces `"... (copy)"` as a draft with `simulatedRevision null`.
- [ ] **Step 2:** FAIL. **Step 3:** Implement. **Step 4:** PASS.
- [ ] **Step 5:** Commit: `feat(actions): rule authoring, simulation, and honest activation refusals`

### Task 12: Seed remediation (truthfulness)

**Files:** Modify `src/lib/seed/dataset.ts`; regenerate `supabase/seed.sql`; update `tests/seed-dataset.test.ts`

*(Execution note: land this immediately after Task 7 if Task 8's Step 4 needs the new seed shape — see Section 13's commit order.)*

The remediated seed, rule by rule (all escalate `assigneeUserId` → `null`; all `voiceProfile` → `null`; **every `lastRunAt` → `null`** — nothing has ever run):

| Rule | Status after | Actions after | Description after (no unsupported promises) |
|---|---|---|---|
| `escalate-high-risk` | **active**, `revision 1`, `simulatedRevision 1`, `lastSimulatedAt: daysAgo(2)` | `[escalate]` (drop notify, require_approval) | "Anything classified high or critical risk is escalated for a person to handle." |
| `food-safety-hold` | **active**, simulated as above | `[escalate]` (drop tag) | "Critical-risk mentions escalate immediately, ahead of everything else." |
| `harbor-escalate` (Harbor) | **active**, simulated as above | `[escalate]` | "Any critical mention is escalated to the team immediately." |
| `auto-positive` | **draft**, never simulated | unchanged `[generate_draft(null), auto_publish]` | "Would draft and publish replies to happy Google reviews. Stays a draft until Lia can generate drafts and publish replies." |
| `reddit-approval` | **draft** | unchanged | "Would hold every Reddit reply for a named approver. Stays a draft until drafting and approval routing are automated." |
| `assign-negative` | **draft** | unchanged | "Would route negative Google reviews to the right person. Stays a draft until mention assignment exists." |
| `media-watch` | inactive (as now) | unchanged `[notify]` | "Would flag high-relevance news coverage. Inactive until Lia can send notifications." |
| `dismiss-irrelevant` | draft (as now) | unchanged | unchanged — it deliberately demos an activation refusal (`high_risk_terminal_status` + never simulated) |

Rationale: the three active rules carry only executable actions (`escalate`) and fresh simulations, so they pass `activationProblems` — they are truthfully "armed", the page banner says rules are not yet applied, and "Last run: Never" is accurate. Every draft's description says *why* it is a draft. No fabricated history remains. The seeded `automation_rule.disabled` audit event for media-watch stays (it describes a toggle, which is real functionality).

- [ ] **Step 1:** Update `tests/seed-dataset.test.ts` first (failing): every rule has `lastRunAt: null`; every **active** rule has `activationProblems(rule).length === 0`; every rule still parses; `isAutoPublishSafe` still holds for all (auto-positive keeps positive + low + google_review and gains no conflicting action, so the strengthened check passes); no rule action carries a user id (`JSON.stringify(rule.actions)` contains no `USER_` seed uuid — assert `assigneeUserId === null` / `approverUserId` only on drafts where it remains, and change those to null too for consistency: yes — **all** `approverUserId`/`assigneeUserId` become null).
- [ ] **Step 2:** FAIL → apply the table → regenerate `supabase/seed.sql` → PASS, plus `tests/seed-generator-columns.test.ts` and the full suite.
- [ ] **Step 3:** Commit: `fix(seed): rules stop claiming runs, SLAs, and capabilities that do not exist`

### Task 13: Templates

**Files:** Create `src/lib/rules/templates.ts`; Test `tests/rules-templates.test.ts`

**Produces:**
```ts
export interface RuleTemplate {
  id: string;                       // slug, e.g. "quiet-low-relevance"
  name: string; description: string;
  requiredActionTypes: RuleActionType[];
  available: boolean;               // derived: every required type executable
  unavailableReason: string | null;
  config: AutomationRuleConfig;     // priority + conditions + actions, no org-specific ids
}
export const RULE_TEMPLATES: readonly RuleTemplate[];
```

Five templates (restaurant-honest; **no** location/user/org ids anywhere):
1. **"Quiet low-relevance chatter"** — `[relevance_score less_than 0.3, risk_level at_most low]` → `[set_status dismissed]`. Available.
2. **"Escalate negative news coverage"** — `[source_type is news_article, sentiment is negative]` → `[escalate]`. Available.
3. **"Escalate one-star reviews"** — `[source_type is google_review, rating less_than 2]` → `[escalate]`. Available.
4. **"Approval-first Reddit replies"** — `[platform is reddit]` → `[generate_draft(null), require_approval(null)]`. **Unavailable**: "Needs automated drafting and approval routing, which are manual steps today."
5. **"Auto-publish glowing Google replies"** — `[source_type is google_review, sentiment is positive, risk_level at_most low, rating greater_than 3]` → `[generate_draft(null), auto_publish]`. **Unavailable**: "Needs publishing support Lia does not have yet."

- [ ] **Step 1: failing tests:** every template's `config` parses against `automationRuleConfigSchema`; no serialized config contains a uuid (regex `/[0-9a-f]{8}-[0-9a-f]{4}/`); `available` is true exactly when every `requiredActionTypes` entry `isActionExecutable`; unavailable templates carry a reason; template 5's config passes `isAutoPublishSafe`.
- [ ] **Step 2:** FAIL → implement (derive `available`/`unavailableReason` from the registry at module load) → PASS.
- [ ] **Step 3:** Commit: `feat(rules): five honest starter templates for restaurants`
- Instantiation is just `createAutomationRuleAction` with the template's config and name — templates can never become active automatically because everything created starts as an unsimulated draft. Location/approver resolution ("Ask the user to resolve required members/locations") reduces in V1 to: available templates need none (by design); users edit the draft afterward like any other.

### Task 14: List page — URL-backed filter, honest columns, safe rows

**Files:** Modify `src/app/(app)/rules/page.tsx`, `src/components/rules/rule-toggle.tsx`, `src/components/ui/segmented-tabs.tsx`, `src/components/ui/button.tsx`; Create `src/components/rules/rule-status-tabs.tsx`, `src/lib/rules/search-params.ts`; Test `tests/rules-search-params.test.ts`; Create `src/app/(app)/rules/error.tsx`

- [ ] **Step 1:** `parseRuleStatusParam(value: string | undefined): AutomationRuleStatus | "all"` — exact match against the enum, anything else → `"all"`; failing test with cases `"active"`, `"draft"`, `"ACTIVE"` → all, `undefined` → all, `"archived"` → all. Implement, PASS.
- [ ] **Step 2:** `SegmentedTabs`: add optional `activeTabId?: string`; `const active = activeTabId ?? internal` (existing behavior untouched when the prop is absent — every current consumer keeps working).
- [ ] **Step 3:** `Button`: extract the class-building into `export function buttonClassName(variant, size, iconOnly?)` and add `export function ButtonLink({ href, variant, size, icon, children, ...})` rendering `next/link` with those classes (same visual, real anchor).
- [ ] **Step 4:** `RuleStatusTabs` (client): `useRouter` + props `{ activeStatus, counts }` → renders `SegmentedTabs` controlled, `onChange={(id) => router.replace(id === "all" ? "/rules" : `/rules?status=${id}`, { scroll: false })}`.
- [ ] **Step 5:** Rewrite `rules/page.tsx`: `searchParams: Promise<{ status?: string }>`; fetch `list(scope)` once; counts from the full set; filter in memory; columns — name (+description), status badge, priority, **"N condition(s) · M action(s)"** with real pluralization, "Last run" (unchanged rendering — now truthfully "Never" everywhere), toggle; `rowHref={(rule) => `/rules/${rule.id}`}`, `rowLabel={(rule) => rule.name}`; truthfulness note replacing the current one: *"Rules are recorded, simulated, and audited. Lia does not yet apply rules to incoming mentions — enabling a rule prepares it for when automation execution launches."*; header action = `canManage ? <ButtonLink href="/rules/new" ...>New rule</ButtonLink> : <Button disabled ...>New rule</Button>` plus, for non-managers, the sentence "Your role can view rules but not change them." rendered beside it. Remove the three `SectionPlaceholder`s (templates move to the detail/new flow in Task 15). Keep the page under 300 lines by keeping columns in the existing `buildColumns` helper.
- [ ] **Step 6:** `RuleToggle`: outer `<span>` gains `relative` (stays clickable above the row-link overlay); draft-blocked state gains `title="Open the rule to simulate and enable it"`; everything else unchanged.
- [ ] **Step 7:** `rules/error.tsx` following the shape of `src/app/(app)/integrations/error.tsx`.
- [ ] **Step 8:** `npm run lint && npm run typecheck && npm run build` — green. Manual pass per Section 12 items 1–6.
- [ ] **Step 9:** Commit: `feat(rules): URL-backed status filter, honest counts column, row navigation`

### Task 15: Builder, detail route, simulation panel, readiness, templates panel

**Files:** Create `src/app/(app)/rules/new/page.tsx`, `src/app/(app)/rules/[ruleId]/page.tsx`, `src/app/(app)/rules/[ruleId]/loading.tsx`, `src/components/rules/rule-builder.tsx`, `condition-editor.tsx`, `action-editor.tsx`, `readiness-checklist.tsx`, `simulation-panel.tsx`, `rule-templates-panel.tsx`, `rule-row-actions.tsx`

Component contracts (all props explicit so pages stay thin):

```ts
// rule-builder.tsx ("use client")
interface RuleBuilderProps {
  mode: "create" | "edit";
  rule?: AutomationRule;                       // edit mode
  locations: { id: string; name: string }[];   // from locations.list(scope)
  editable: boolean;                            // manage-holder AND rule not active/archived
  initialConfig?: AutomationRuleConfig;        // template instantiation via /rules/new?template=<id>
}
// condition-editor.tsx: { value: RuleCondition; index, count; onChange, onRemove, onMoveUp, onMoveDown; locations }
// action-editor.tsx: same shape over RuleAction; renders only registry entries with showInBuilder,
//   disabled (with blockedReason as visible text, not a tooltip) when not executable
// readiness-checklist.tsx (server): { rule: AutomationRule } → renders activationProblems() as a
//   checklist: satisfied items with green check, problems with amber text; empty list → "Ready to enable."
// simulation-panel.tsx ("use client"): { rule: AutomationRule; canManage: boolean } → button
//   "Simulate against the last 30 days" → simulateAutomationRuleAction → renders SimulationResult:
//   evaluated/matched/rate KPIs, breakdown rows, projected actions (blocked ones amber with reason),
//   ≤5 sample rows, and the fixed line "This is a preview. No drafts, escalations, or notifications
//   were created."  On truncated: "Evaluated the most recent 500 mentions."  router.refresh() on
//   success so the server-rendered readiness checklist picks up the fresh simulation.
// rule-row-actions.tsx ("use client"): duplicate (→ action, then router.push to the copy) and
//   archive (ConfirmDialog, destructive=false, copy: "Archive this rule? It keeps its history and
//   can be restored by support, but it disappears from this list.")
// rule-templates-panel.tsx: lists RULE_TEMPLATES; available → ButtonLink to /rules/new?template=id;
//   unavailable → disabled button + unavailableReason text
```

Builder behavior requirements (implement exactly):
- Header line above conditions: **"Match when all of the following are true"** — the AND is visible.
- Add condition → appends `{ field: "source_type", operator: "is", value: "google_review" }` (a fully valid default, never a half-empty row); switching field resets operator/value to that field's first valid pair from `CONDITION_FIELDS`.
- Value editors by `input` kind: enum selects with labels from `src/lib/labels.ts`; location select from props; `rating` number input (0–5, step 0.5); `relevance_score` number input (0–1, step 0.05).
- Live sentence (from `ruleSentence`) and live client-side readiness preview (import `activationProblems` — pure module, client-safe) update on every change.
- Save: create mode → `createAutomationRuleAction` → `router.push(`/rules/${id}`)`; edit mode → `updateAutomationRuleAction` with `expectedRevision: rule.revision`; render `fieldErrors` inline and the top-level `error` in a `role="alert"` box (concurrency conflicts land here with the reload message).
- Dirty-state honesty: track `isDirty`; the save button is labeled "Save draft" / "Save changes" and a persistent line under it reads "Changes are not saved until you save." (No autosave, no beforeunload dialog — deferred work.)
- `/rules/[ruleId]/page.tsx` (server): `const { ruleId } = await params;` → `get` → `notFound()` when null; fetch locations + audit events (`auditEvents.list(scope, { entityType: "automation_rule", entityId: ruleId, limit: 20 })`) in `Promise.all`; layout: sentence card → builder (or read-only rendering with the "Disable this rule to edit it." note on active rules; archived rules show an "Archived" badge and no controls) → readiness checklist + enable/disable control (reusing `RuleToggle`) → simulation panel → templates panel is **not** here; it renders on `/rules/new` only → audit trail via `Timeline` with `AUDIT_EVENT_LABELS`.
- `/rules/new/page.tsx`: reads `?template=`, resolves via `RULE_TEMPLATES`, passes `initialConfig`; unknown template id → plain empty builder (fail-safe, no error). Non-manage roles get `notFound()`? No — redirect is hostile; render the page with an `EmptyState` "Your role can view rules but not create them." and no builder.
- [ ] **Steps:** implement → `npm run lint && npm run typecheck && npm run build` → manual pass per Section 12 items 7–18 → Commit: `feat(rules): builder, rule detail route, simulation panel, and readiness checklist`

### Task 16: Full verification + docs

- [ ] **Step 1:** `npm run verify` (lint, typecheck, all tests, build) — green. `npm run db:validate` — green. Where a local Supabase stack exists: `npm run db:verify-rls` — 34 + new checks pass.
- [ ] **Step 2:** Documentation updates per Section 15 (data-model fix, current-state ledger rows, screens note).
- [ ] **Step 3:** Commit: `docs: record rules authoring decisions and correct the automation data model`

---

## 11. Automated tests (summary matrix)

| Requirement (from the request) | Covered by |
|---|---|
| Every condition and operator | `tests/rules-evaluate.test.ts` case table (Task 2) |
| Risk ordering + numeric boundaries | same (inclusive at_least/at_most, strict >/<, 3-vs-3.5, 0.3 boundary) |
| All-condition matching; zero conditions never match | same |
| Invalid field/operator/value combos | Zod discriminated unions reject at parse — `tests/automation-actions.test.ts` asserts `fieldErrors` on a bad payload; `automationRuleConfigSchema` tests in Task 1's suite |
| Draft vs activation validation | `tests/rules-readiness.test.ts` (drafts save empty; activation demands completeness) |
| Auto-publish safety incl. the at_most-medium bug | `tests/rules-readiness.test.ts` |
| High-risk non-overridability | `admitsHighRisk` + `high_risk_terminal_status` cases |
| Action-capability checks | `tests/rules-capabilities.test.ts` |
| Conflicting actions | approval+auto_publish, double set_status cases |
| Simulation zero side effects / no AI | snapshot equality in `tests/rules-simulation.test.ts` |
| Stale simulation invalidation | readiness `stale_simulation` + repository `recordSimulation` revision guard |
| CRUD + duplicate + toggle + archive | `tests/automation-repositories.test.ts`, `tests/automation-actions.test.ts` |
| Optimistic concurrency | two-writer conflict test (Task 8) |
| Permissions across all seven roles | `tests/permissions.test.ts` (Task 7) + per-role action refusals (Task 11) |
| Tenant isolation (demo) | new-method isolation cases (Task 8) + existing `tests/organization-isolation.test.ts` |
| Tenant isolation (Supabase/RLS) | `supabase/tests/rls-verification.sql` new section (Task 6); adapter always filters `organization_id` by construction |
| RLS verification | `npm run db:verify-rls` |
| URL filtering / stale IDs / browser nav | `tests/rules-search-params.test.ts`; stale IDs → `get`→null→`notFound()` (repo-level test + manual criterion 9) |
| Keyboard operation | manual criteria (no DOM test env exists — a deliberate, pre-existing constraint) |
| Existing DataTable consumers | unchanged props (only additive `SegmentedTabs`/`Button` changes); `npm run build` + manual spot-check of escalations/responses |
| Rule ordering & tie-breaking, execution idempotency, retries, real lastRunAt | **Phase 2 tests** (see below) — nothing executes in Phase 1; the seed test pins `lastRunAt === null` everywhere |
| Existing regression suites | `npm run verify` in Task 16; targeted updates in Tasks 8/12 |

## 12. Manual acceptance criteria

1. `/rules?status=draft` shows only drafts; refresh, back/forward, and a pasted URL all preserve the filter; counts never change as the filter changes.
2. Clicking a row opens `/rules/[id]`; clicking the enable switch toggles without navigating.
3. Tab reaches every row link, every switch, and every tab control; tabs move with arrow keys.
4. The conditions column reads "1 condition · 2 actions" style, correctly pluralized.
5. As a viewer or analyst: no New rule affordance beyond the disabled button + explanation; toggles disabled; detail page read-only.
6. The truthfulness note is present on `/rules` and the detail page never claims a rule ran (Last run: Never everywhere in the seed).
7. Create a draft with zero actions — saves fine; readiness lists what's missing; the list toggle stays blocked.
8. Edit the draft → previously fresh simulation (if any) reads stale; simulate → readiness flips; enable → active.
9. Unknown/foreign rule id in the URL → the app's not-found page, no error boundary, no data leak.
10. Active rule: builder read-only with "Disable this rule to edit it."; disable → edit → readiness shows stale simulation.
11. Two tabs: edit the same rule in both, save both — the second save fails with the reload message and overwrites nothing.
12. Simulate "Escalate negative news coverage" from a template: draft created with the template's config, no org ids inside; simulation shows evaluated/matched, source/risk breakdowns, projected `escalate` unblocked, and the "This is a preview" line; the mentions/escalations/responses pages show no new records afterward.
13. A rule containing `notify` (media-watch) refuses to enable, names the reason, and the refusal appears in the rule's audit trail as "Rule activation refused".
14. Duplicate escalate-high-risk → "… (copy)" draft, never simulated, unsaved-work note behaves.
15. Archive a draft via the confirm dialog → gone from the list, still opens by URL as read-only Archived.
16. Rule audit trail shows created/updated/simulated/enabled events with actor and time; updated events show structured before/after conditions (not "[object Object]").
17. Builder actions list: escalate and set-status selectable; draft/approval/notify/auto-publish visibly disabled with their reasons; assign/tag absent.
18. Escalations and responses pages still render and navigate exactly as before (DataTable untouched behaviorally).

## 13. Commit sequence

Small, reviewable, each leaving `npm run verify` green (Tasks 5+6 land together for the vocabulary pin):

1. `feat(domain): rule revisions, simulation readiness, archival, authoring input schemas` (Task 1)
2. `feat(rules): pure condition evaluator with explicit null semantics` (Task 2)
3. `feat(rules): action capability registry, activation readiness, strengthened auto-publish safety` (Task 3)
4. `feat(rules): plain-language rule sentences and builder field metadata` (Task 4)
5. `feat(audit+db): structured audit diffs and rule-lifecycle vocabulary` (Tasks 5+6)
6. `feat(auth): automation_rule.manage permission` (Task 7)
7. `fix(seed): rules stop claiming runs, SLAs, and capabilities that do not exist` (Task 12 — lands before the adapters so their tests target the truthful seed)
8. `feat(data): automation rule CRUD, simulation readiness, candidates — demo adapter` (Task 8)
9. `feat(data): automation rule authoring — supabase adapter` (Task 9)
10. `feat(rules): side-effect-free 30-day simulation service` (Task 10)
11. `feat(actions): rule authoring, simulation, honest activation refusals` (Task 11)
12. `feat(rules): five honest starter templates` (Task 13)
13. `feat(rules): URL-backed status filter and honest list page` (Task 14)
14. `feat(rules): builder, detail route, simulation panel, readiness checklist` (Task 15)
15. `docs: record rules authoring decisions; correct automation data model` (Task 16)

## 14. Risks, tradeoffs, deferred work

**Risks**
- *Supabase adapter is untested against a live DB* (pre-existing: "this adapter has not been executed against a live database"). Mitigation: identical guard logic to the demo adapter, `db:validate` for SQL, RLS script where available; first live run should exercise create/update/archive manually.
- *Hosted DB migration lag*: `current-state.md` records that the hosted project trails migrations; the six new audit events will 23514-fail there until `20260809000100` is applied. Same operational caveat as `response.edited` — call it out in the PR.
- *`diff` change is global*: JSON-aware serialization affects every existing caller. Existing callers diff primitives only (status, role, text lengths), so behavior is unchanged for them; the new tests pin both old and new behavior.
- *Three seeded rules stay active without an engine.* Deliberate tradeoff: they carry only executable actions, fresh simulations, `lastRunAt: null`, and the page banner states rules are not yet applied. The alternative (zero active rules) makes the list page and toggle tests hollow. If the user prefers strictly zero active seeds, flip the three to `inactive` in Task 12 — one-line-per-rule change, and `tests/repositories.test.ts` then enables one in-test via `recordSimulation` + `setEnabled`.

**Tradeoffs**
- Simulation requires a saved rule (no simulate-before-first-save). This keeps staleness tracking on the revision counter instead of a config hash and matches "editing invalidates simulation" with zero extra state. Cost: one extra save click.
- Structural edits refused on active rules (disable-first) instead of a revision/versioning model — far less machinery, and Phase 2's execution records will store `rule_revision` so history stays reconstructible.
- Candidate limit 500 with a visible truncation note, instead of unbounded scans.
- `escalate` keeps `assigneeUserId` in the schema (compat) but always null — removing the field is deferred until a migration-worthy reason exists.

**Deferred work**
- Contradictory-condition warnings (e.g. `rating greater_than 4` AND `less_than 2`).
- "Facts requiring verification" auto-publish leg — needs an analysis output flag that doesn't exist.
- Unsaved-changes navigation guard (beforeunload) in the builder.
- Restore-from-archive UI (data supports it; `update` on archived is refused, so restore needs its own small action when wanted).
- Rule history / performance summary modules from `docs/screens.md` — meaningless before execution exists.
- `assign`/`tag` semantics — blocked on product decisions (mention assignee? tag entity?).

---

## Phase 2 design (build only after prerequisites in Section 3)

**Data model** — new migration pair (`..._automation_execution.sql` + `_rls.sql`):

```sql
create table public.automation_rule_executions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations (id) on delete cascade,
  automation_rule_id uuid not null references public.automation_rules (id) on delete cascade,
  rule_revision integer not null,
  mention_id uuid not null references public.mentions (id) on delete cascade,
  status text not null check (status in ('applied', 'partial', 'blocked', 'failed')),
  -- per-action outcomes: [{ type, outcome: 'applied'|'skipped_duplicate'|'blocked'|'failed', code }]
  outcomes jsonb not null default '[]'::jsonb,
  error_code text,
  executed_at timestamptz not null default now(),
  constraint automation_rule_executions_idempotent
    unique (automation_rule_id, rule_revision, mention_id)
);
-- RLS: select for members; NO insert/update/delete for authenticated —
-- only the service role writes (same posture as audit_events).
```

The unique key **(rule, revision, mention)** is the idempotency guarantee: a retry inserts `on conflict do nothing` and reads the existing record; a re-run after an edit (new revision) is a deliberate new execution.

**Engine shape** (`src/lib/rules/execute.ts`, service like `analyzeMentions`):
1. Runs inside the existing analysis sweep (`/api/cron/analyze-mentions`) per organization, after `applyAnalysisOutcome` — `getServiceDataSource()`, per-org `OrganizationScope` with `SYSTEM_ACTOR_ID` (D88), `actorType: "system"` on all audit events. Never from a page request.
2. Subject = the same `RuleSubject` from Phase 1's evaluator plus `connectionCapabilities` (from the platform registry) — one normalized object per mention.
3. Rules load once per org: active, unarchived, ordered `priority asc, createdAt asc, id asc` (the deterministic tie-breaker; `id` breaks equal timestamps).
4. Executor registry `Record<RuleActionType, ActionExecutor>` containing **only** executable actions; the registry is the same `ACTION_CAPABILITIES` gate, so an action becomes executable in exactly one place.
5. Per mention: evaluate rules in order; collect intended actions; resolve conflicts **before** executing any (two-pass):
   - **Escalation is sticky**: once any rule (or D38 analysis) escalates, no later action may change mention status away from `escalated`; `escalations.create` dedupe makes double-escalation structurally impossible.
   - **Approval blocks auto-publish**: any `require_approval` in the collected set cancels every `auto_publish`.
   - **High-risk guardrail**: subjects with high/critical risk drop `set_status`-to-terminal and `auto_publish` actions unconditionally — the engine enforces it even if a legacy rule slipped through activation.
   - **Draft generation at most once** per (mention, intended response type): skip with `skipped_duplicate` if a draft already exists.
   - **Assignment conflicts** (when assignment exists): first rule by priority wins; later assigns record `skipped_duplicate`.
   - **Notification dedupe** (when notify exists): one per (mention, channel) per sweep.
   - **Status lattice**: `set_status` may not overwrite a "stronger" status; ordering `escalated > needs_approval > draft_ready > responded > monitoring/analyzed > dismissed/no_action_recommended` — a status write is skipped (`blocked`, code `weaker_status`) if the current status ranks higher.
6. Execute survivors; write one execution record per (rule, mention) with per-action outcomes; update the rule's `last_run_at` only when its record's status is `applied` or `partial`.
7. Failure visibility: audit `automation_rule.executed` / `automation_rule.execution_failed` per org sweep with counts (new vocabulary migration then), and the execution table itself surfaces per-mention failures; retry = re-run the sweep, idempotent by the unique key.

**Phase 2 ordered tasks (design resolution — re-plan before building):** ① execution table + RLS + repo (`executions.record`, `executions.listForRule`, `rules.markRun`); ② conflict-resolution pure module + exhaustive tests (every pair in the table above); ③ executor registry with `set_status`/`escalate` only; ④ sweep integration behind an env flag; ⑤ idempotency/retry tests (run sweep twice → identical records, single escalation, single draft); ⑥ per-rule outcome UI on `/rules/[ruleId]` (real Last run, execution list); ⑦ unlock further executors as prerequisites 1–4 land, one per PR with its own conflict tests.

---

## 15. Documentation and decision-ledger updates

- **`docs/data-model.md`**: replace the stale `AutomationRule` block (`enabled`, `lastSimulatedAt`, `conditionsJson`) with the real shape: `status` enum, `priority`, `conditions`, `actions`, `revision`, `lastSimulatedAt`, `simulatedRevision`, `archivedAt`, `lastRunAt`.
- **`docs/architecture/current-state.md`**: append ledger rows (next free D-numbers, continuing from the latest in `docs/superpowers/specs/`): rules lifecycle & disable-to-edit; revision as concurrency token + simulation-staleness marker; capability registry as the single activatability gate; strengthened auto-publish (spec's three legs encoded, at_most-medium bug closed); archive-not-delete (no DELETE policy, deliberately); seed truthfulness (no fabricated `lastRunAt`); JSON-aware audit diffs; `automation_rule.manage` vs `.toggle` split; simulation-requires-save tradeoff; Phase 2 idempotency key design.
- **`docs/screens.md` §10**: mark "Rule history" and "Performance summary" as Phase 2 (execution-dependent).
- **PR description**: note the hosted-DB migration lag caveat for the audit vocabulary.

---

## Self-review record

Checked against the request's 15 required outputs: 1→§1, 2→§2, 3→§3+Phase 2 design, 4→§4, 5→§5, 6→§6, 7→§7, 8→§8, 9→§9, 10→§10, 11→§11 (+ inline test code in tasks), 12→§12, 13→§13, 14→§14, 15→§15. Checked type consistency: `AutomationRuleConfig` naming is uniform across Tasks 1/8/11/13/15; `activationProblems` signature identical in Tasks 3/8/11/15; `SimulationCandidate`/`SimulationResult` consistent across Tasks 8/10/15. Checked constraints: no new dependencies; no execution in Phase 1; no `lastRunAt` writer; audit metadata carries counts/config only.
