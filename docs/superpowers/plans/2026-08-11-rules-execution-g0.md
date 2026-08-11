# Rules execution G0 (dry-run engine) implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the G0 block of the approved Phase 2 spec — schema, domain vocabulary, transition matrix, repository contract with the full demo-adapter algorithm, the dry-run engine loop, cron integration, and dry-run UI — releasable as internal dry run with zero business mutations.

**Architecture:** A new execution/sweep schema with composite tenant-integrity constraints; a pure transition matrix module; a repository contract whose demo adapter implements the claim/replay/retry unit algorithm in TypeScript (the Supabase RPC twin arrives in the G1 plan); an `executeRules` service called by the existing analysis cron per organization, gated by `RULES_EXECUTION_MODE`. Dry run writes only sweep and projection rows.

**Tech Stack:** Next.js App Router (server components), TypeScript strict, Zod domain schemas, Vitest, Supabase SQL migrations (validated by `npm run db:validate`, applied later).

**Spec:** `docs/superpowers/specs/2026-08-11-rules-execution-phase2-design.md` (v3, approved). Section references (§) below point there.

## Global Constraints

- TypeScript strict; no `any` without a justifying comment; server components by default (CLAUDE.md).
- Sentence case for all UI copy.
- Dry run performs **no business mutations and no audit events**: only `automation_sweeps` and `mode='dry_run'` execution rows (§8).
- `apply` outcomes: `applied | partial | blocked | failed | no_op`; dry-run projections: `would_apply | would_partial | would_block | would_no_op | would_fail_validation`. Never mix vocabularies (§5, §8).
- `set_status` may never target `escalated` — code `escalation_reserved` (§7).
- Deterministic rule order everywhere: `priority asc, createdAt asc, id asc`.
- Idempotency key: `(automation_rule_id, rule_revision, mention_id, trigger_analysis_id, mode)` (§5).
- Migrations are **not** applied to the hosted project in this plan; `npm run db:validate` green is the gate here, `npm run db:verify-rls` (Docker) is Task 12.
- Every commit leaves `npm run verify` green.
- Do not describe execution as enabled, atomic, or idempotent in code comments or UI beyond what the implemented mechanism provides.

---

### Task 1: Tenant-integrity prerequisite migration

**Files:**
- Create: `supabase/migrations/20260811000100_tenant_integrity_prereqs.sql`

**Interfaces:**
- Consumes: existing tables `automation_rules`, `locations`, `mentions`, `mention_analyses` (`20260801000100_initial_schema.sql`).
- Produces: unique constraints later migrations' composite FKs target: `automation_rules_id_org`, `locations_id_org`, `mentions_id_org`, `mentions_id_org_location`, `mention_analyses_id_mention_org`; plus `mentions_location_same_org`.

- [ ] **Step 1: Write the migration**

```sql
-- Composite-key prerequisites for automation execution (Phase 2, G0).
--
-- These uniques exist so same-organization composite foreign keys become
-- expressible. Each is implied by the primary key plus the tenant column;
-- the cost is one index apiece.
--
-- `mentions_location_same_org` closes finding F14 of the Phase 2 spec: a
-- mention's location column was a simple FK to locations(id), so nothing in
-- the database prevented a mention pointing at another organization's
-- location. The pre-flight DO block asserts the constraint is true of
-- existing data — a violation is a live cross-tenant defect to investigate,
-- never data to grandfather.

do $$
declare violating integer;
begin
  select count(*) into violating
  from public.mentions m
  join public.locations l on l.id = m.location_id
  where m.location_id is not null
    and l.organization_id <> m.organization_id;
  if violating > 0 then
    raise exception
      'mentions_location_same_org pre-flight: % cross-organization mention locations exist',
      violating;
  end if;
end $$;

alter table public.automation_rules
  add constraint automation_rules_id_org unique (id, organization_id);

alter table public.locations
  add constraint locations_id_org unique (id, organization_id);

alter table public.mentions
  add constraint mentions_id_org unique (id, organization_id);

-- Proof target for "execution location equals mention location" (spec §5).
alter table public.mentions
  add constraint mentions_id_org_location
    unique (id, organization_id, location_id);

alter table public.mentions
  add constraint mentions_location_same_org
    foreign key (location_id, organization_id)
    references public.locations (id, organization_id);

alter table public.mention_analyses
  add constraint mention_analyses_id_mention_org
    unique (id, mention_id, organization_id);
```

- [ ] **Step 2: Validate**

Run: `npm run db:validate`
Expected: PASS (parses; no duplicate versions).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260811000100_tenant_integrity_prereqs.sql
git commit -m "feat(db): composite tenant-integrity prerequisites for rule execution"
```

---

### Task 2: Domain vocabulary and entities for sweeps and executions

**Files:**
- Create: `src/domain/entities/automation-execution.ts`
- Modify: `src/domain/index.ts` (re-export the new module, following how `entities/automation.ts` is exported)
- Test: `tests/automation-execution-domain.test.ts`

**Interfaces:**
- Consumes: `uuidSchema`, `timestampSchema`, `organizationOwnedSchema`, from `src/domain/primitives.ts`; `ruleActionSchema` from `entities/automation.ts`.
- Produces (exact names later tasks import from `@/domain`):
  - `AUTOMATION_EXECUTION_MODES = ["dry_run", "apply"]`, type `AutomationExecutionMode`
  - `APPLY_EXECUTION_STATUSES = ["applied", "partial", "blocked", "failed", "no_op"]`, type `ApplyExecutionStatus`
  - `DRY_RUN_EXECUTION_STATUSES = ["would_apply", "would_partial", "would_block", "would_no_op", "would_fail_validation"]`, type `DryRunExecutionStatus`
  - `APPLY_ACTION_OUTCOMES = ["applied", "no_op", "blocked", "failed"]`, `DRY_RUN_ACTION_OUTCOMES = ["would_apply", "would_no_op", "would_block", "would_fail_validation"]`
  - `automationSweepSchema` / `AutomationSweep`: `{ id, organizationId, mode, status: "running"|"completed"|"failed", startedAt, completedAt: nullable, counters: SweepCounters, errorCode: nullable }`
  - `sweepCountersSchema` / `SweepCounters`: `{ mentionsEvaluated, rulesMatched, actionsApplied, actionsBlocked, actionsSkipped, actionsFailed, retryableFailures, terminalFailures }` — all `z.number().int().min(0)`
  - `executionActionOutcomeSchema` / `ExecutionActionOutcome`: `{ index: int ≥ 0, type: ruleActionSchema.shape... use z.enum(RULE_ACTION_TYPES), outcome: union of both outcome vocabularies, code: z.string().nullable() }`
  - `automationRuleExecutionSchema` / `AutomationRuleExecution`: `{ id, organizationId, sweepId, automationRuleId, ruleRevision: int ≥ 1, mentionId, triggerAnalysisId, locationId: nullable, mode, status: union of both status vocabularies, outcomes: ExecutionActionOutcome[], outcomeSchemaVersion: int (1), attemptCount: int ≥ 1, lastErrorCode: nullable, errorClass: "retryable"|"terminal"|null, startedAt, completedAt: nullable }`
  - The schema `.superRefine` enforces mode/status pairing: `apply` rows only apply statuses, `dry_run` rows only would-statuses.

- [ ] **Step 1: Write the failing test**

```ts
// tests/automation-execution-domain.test.ts
import { describe, expect, it } from "vitest";
import {
  automationRuleExecutionSchema,
  automationSweepSchema,
} from "@/domain";

const baseExecution = {
  id: "7c9a1f4e-0000-4000-8000-000000000001",
  organizationId: "7c9a1f4e-0000-4000-8000-000000000002",
  sweepId: "7c9a1f4e-0000-4000-8000-000000000003",
  automationRuleId: "7c9a1f4e-0000-4000-8000-000000000004",
  ruleRevision: 1,
  mentionId: "7c9a1f4e-0000-4000-8000-000000000005",
  triggerAnalysisId: "7c9a1f4e-0000-4000-8000-000000000006",
  locationId: null,
  outcomes: [],
  outcomeSchemaVersion: 1,
  attemptCount: 1,
  lastErrorCode: null,
  errorClass: null,
  startedAt: "2026-08-11T00:00:00.000Z",
  completedAt: null,
};

describe("automation execution domain", () => {
  it("accepts an apply row with an apply status", () => {
    expect(
      automationRuleExecutionSchema.safeParse({
        ...baseExecution, mode: "apply", status: "applied",
      }).success,
    ).toBe(true);
  });

  it("rejects an apply row carrying a projected status", () => {
    expect(
      automationRuleExecutionSchema.safeParse({
        ...baseExecution, mode: "apply", status: "would_apply",
      }).success,
    ).toBe(false);
  });

  it("rejects a dry_run row carrying an applied status", () => {
    expect(
      automationRuleExecutionSchema.safeParse({
        ...baseExecution, mode: "dry_run", status: "applied",
      }).success,
    ).toBe(false);
  });

  it("parses a running sweep with zeroed counters", () => {
    expect(
      automationSweepSchema.safeParse({
        id: baseExecution.id,
        organizationId: baseExecution.organizationId,
        mode: "dry_run",
        status: "running",
        startedAt: baseExecution.startedAt,
        completedAt: null,
        errorCode: null,
        counters: {
          mentionsEvaluated: 0, rulesMatched: 0, actionsApplied: 0,
          actionsBlocked: 0, actionsSkipped: 0, actionsFailed: 0,
          retryableFailures: 0, terminalFailures: 0,
        },
      }).success,
    ).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/automation-execution-domain.test.ts`
Expected: FAIL — `automationRuleExecutionSchema` is not exported from `@/domain`.

- [ ] **Step 3: Implement the module**

```ts
// src/domain/entities/automation-execution.ts
import { z } from "zod";
import { uuidSchema, timestampSchema } from "../primitives";
import { RULE_ACTION_TYPES } from "../enums"; // adjust import to wherever the action-type vocabulary lives; if only ruleActionSchema exists, derive: z.enum(["generate_draft","require_approval","assign","escalate","notify","tag","set_status"])

export const AUTOMATION_EXECUTION_MODES = ["dry_run", "apply"] as const;
export type AutomationExecutionMode = (typeof AUTOMATION_EXECUTION_MODES)[number];

export const APPLY_EXECUTION_STATUSES =
  ["applied", "partial", "blocked", "failed", "no_op"] as const;
export type ApplyExecutionStatus = (typeof APPLY_EXECUTION_STATUSES)[number];

export const DRY_RUN_EXECUTION_STATUSES = [
  "would_apply", "would_partial", "would_block", "would_no_op",
  "would_fail_validation",
] as const;
export type DryRunExecutionStatus = (typeof DRY_RUN_EXECUTION_STATUSES)[number];

export const APPLY_ACTION_OUTCOMES =
  ["applied", "no_op", "blocked", "failed"] as const;
export const DRY_RUN_ACTION_OUTCOMES =
  ["would_apply", "would_no_op", "would_block", "would_fail_validation"] as const;

export const sweepCountersSchema = z.object({
  mentionsEvaluated: z.number().int().min(0),
  rulesMatched: z.number().int().min(0),
  actionsApplied: z.number().int().min(0),
  actionsBlocked: z.number().int().min(0),
  actionsSkipped: z.number().int().min(0),
  actionsFailed: z.number().int().min(0),
  retryableFailures: z.number().int().min(0),
  terminalFailures: z.number().int().min(0),
});
export type SweepCounters = z.infer<typeof sweepCountersSchema>;

export const automationSweepSchema = z.object({
  id: uuidSchema,
  organizationId: uuidSchema,
  mode: z.enum(AUTOMATION_EXECUTION_MODES),
  status: z.enum(["running", "completed", "failed"]),
  startedAt: timestampSchema,
  completedAt: timestampSchema.nullable(),
  counters: sweepCountersSchema,
  errorCode: z.string().nullable(),
});
export type AutomationSweep = z.infer<typeof automationSweepSchema>;

export const executionActionOutcomeSchema = z.object({
  /** Position in the executed revision's actions array — the stable action identity. */
  index: z.number().int().min(0),
  type: z.enum(RULE_ACTION_TYPES),
  outcome: z.enum([...APPLY_ACTION_OUTCOMES, ...DRY_RUN_ACTION_OUTCOMES]),
  code: z.string().nullable(),
});
export type ExecutionActionOutcome = z.infer<typeof executionActionOutcomeSchema>;

export const automationRuleExecutionSchema = z
  .object({
    id: uuidSchema,
    organizationId: uuidSchema,
    sweepId: uuidSchema,
    automationRuleId: uuidSchema,
    ruleRevision: z.number().int().min(1),
    mentionId: uuidSchema,
    /** The mention_analyses row that authorized reconsidering this mention. */
    triggerAnalysisId: uuidSchema,
    locationId: uuidSchema.nullable(),
    mode: z.enum(AUTOMATION_EXECUTION_MODES),
    status: z.enum([...APPLY_EXECUTION_STATUSES, ...DRY_RUN_EXECUTION_STATUSES]),
    outcomes: z.array(executionActionOutcomeSchema),
    outcomeSchemaVersion: z.number().int().min(1),
    attemptCount: z.number().int().min(1),
    lastErrorCode: z.string().nullable(),
    errorClass: z.enum(["retryable", "terminal"]).nullable(),
    startedAt: timestampSchema,
    completedAt: timestampSchema.nullable(),
  })
  .superRefine((row, ctx) => {
    const applyStatus = (APPLY_EXECUTION_STATUSES as readonly string[])
      .includes(row.status);
    if (row.mode === "apply" && !applyStatus) {
      ctx.addIssue({ code: "custom", message: "apply rows carry apply statuses" });
    }
    if (row.mode === "dry_run" && applyStatus) {
      ctx.addIssue({ code: "custom", message: "dry_run rows carry projected statuses" });
    }
  });
export type AutomationRuleExecution = z.infer<typeof automationRuleExecutionSchema>;
```

Re-export everything from `src/domain/index.ts` the same way `entities/automation.ts` is re-exported. If `RULE_ACTION_TYPES` does not already exist as an exported const, add it next to `ruleActionSchema` in `entities/automation.ts` as the literal list of the discriminated union's `type` values and use it in both places.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/automation-execution-domain.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/domain tests/automation-execution-domain.test.ts
git commit -m "feat(domain): sweep and execution entities with mode-split outcome vocabularies"
```

---

### Task 3: Rule-activity timestamp swap in the domain, seed, and Phase 1 surfaces

**Files:**
- Modify: `src/domain/entities/automation.ts` (replace `lastRunAt` with three fields)
- Modify: `src/lib/seed/dataset.ts`, `src/lib/data/demo/index.ts`, `src/lib/data/supabase/mappers.ts`, `src/app/(app)/rules/page.tsx`, `src/app/(app)/rules/[ruleId]/page.tsx` (wherever `lastRunAt` renders)
- Test: `tests/seed-dataset.test.ts`, `tests/automation-repositories.test.ts` (update existing pins)

**Interfaces:**
- Produces: `AutomationRule` gains `lastEvaluatedAt`, `lastMatchedAt`, `lastAppliedAt` (all `timestampSchema.nullable()`); `lastRunAt` is gone. UI copy: the list column header becomes "Last applied".

- [ ] **Step 1: Update the domain schema**

In `automationRuleSchema`, replace the `lastRunAt` field with:

```ts
    /**
     * Rule-lifetime activity facts, written only by apply-mode sweeps
     * (spec §9). Monotonic: an older sweep finishing late can never move
     * one backwards. Dry run touches none of them. Revision changes reset
     * nothing — per-revision truth lives in the execution rows.
     */
    lastEvaluatedAt: timestampSchema.nullable(),
    lastMatchedAt: timestampSchema.nullable(),
    lastAppliedAt: timestampSchema.nullable(),
```

- [ ] **Step 2: Chase the compiler**

Run: `npx tsc --noEmit`
Fix every error it reports — seed rows (`lastRunAt: null` becomes the three nulls), demo adapter row construction, supabase mapper (map `last_evaluated_at` / `last_matched_at` / `last_applied_at`; the columns arrive in Task 4's migration), and the two rules pages (render `lastAppliedAt` under the header "Last applied"; keep the em-dash placeholder for null). Search to confirm coverage:

Run: `grep -rn "lastRunAt" src tests`
Expected: zero hits in `src/`; update any remaining test pins in `tests/seed-dataset.test.ts` and `tests/automation-repositories.test.ts` from `lastRunAt` to the three fields, all pinned null in the seed ("no fabricated activity", D143 carried forward).

- [ ] **Step 3: Run the full suite**

Run: `npx vitest run && npx tsc --noEmit`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat(domain): replace lastRunAt with evaluated/matched/applied activity timestamps"
```

---

### Task 4: Execution schema migrations (tables + RLS)

**Files:**
- Create: `supabase/migrations/20260811000200_automation_execution.sql`
- Create: `supabase/migrations/20260811000300_automation_execution_rls.sql`

**Interfaces:**
- Consumes: Task 1's unique constraints.
- Produces: `automation_sweeps`, `automation_rule_executions` exactly as spec §5, plus the `automation_rules` timestamp column swap backing Task 3.

- [ ] **Step 1: Write `20260811000200_automation_execution.sql`**

Copy the two `create table` statements and the three indexes **verbatim from spec §5** ("Sweeps" and "Executions" blocks), including every composite constraint (`execs_sweep_same_org`, `execs_rule_same_org`, `execs_mention_same_org`, `execs_analysis_same_mention`, `execs_location_is_mentions` with `on update cascade`, `execs_idempotent`, `execs_status_by_mode`) and the sweeps partial unique index `automation_sweeps_one_running`. Then append:

```sql
alter table public.automation_rules
  drop column last_run_at,
  add column last_evaluated_at timestamptz,
  add column last_matched_at timestamptz,
  add column last_applied_at timestamptz;

comment on column public.automation_rules.last_applied_at is
  'Written only by apply-mode sweeps via greatest(); dry run never touches it.';
```

Add a table comment on each new table stating writer posture: "Service role writes; authenticated members read per RLS. Rows are operational history: restrict deletes."

- [ ] **Step 2: Write `20260811000300_automation_execution_rls.sql`**

Copy the two select policies (`execs_select_admin`, `execs_select_location_manager`) **verbatim from spec §5**, add `alter table … enable row level security` for both tables, an admin-role select policy for `automation_sweeps` (same `has_organization_role` list, no location arm), and:

```sql
revoke insert, update, delete on public.automation_rule_executions from authenticated;
revoke insert, update, delete on public.automation_sweeps from authenticated;
```

- [ ] **Step 3: Validate and commit**

Run: `npm run db:validate`
Expected: PASS.

```bash
git add supabase/migrations/20260811000200_automation_execution.sql supabase/migrations/20260811000300_automation_execution_rls.sql
git commit -m "feat(db): automation sweeps and executions with composite integrity and location-scoped reads"
```

---

### Task 5: Transition matrix module

**Files:**
- Create: `src/lib/rules/transitions.ts`
- Test: `tests/rules-transitions.test.ts`

**Interfaces:**
- Consumes: `MentionStatus`, `RiskLevel` from `@/domain`; `RISK_RANK` from `src/lib/rules/evaluate.ts`.
- Produces:
  - `type TransitionDecision = { kind: "apply" } | { kind: "no_op" } | { kind: "blocked"; code: "forbidden_transition" | "high_risk_guardrail" | "escalation_reserved" }`
  - `decideSetStatus(current: MentionStatus, target: MentionStatus, risk: RiskLevel): TransitionDecision`
  - `decideEscalate(current: MentionStatus): TransitionDecision`

- [ ] **Step 1: Write the failing test (exhaustive — every cell)**

```ts
// tests/rules-transitions.test.ts
import { describe, expect, it } from "vitest";
import { MENTION_STATUSES, RISK_LEVELS } from "@/domain";
import { decideEscalate, decideSetStatus } from "@/lib/rules/transitions";

const LOW_RISK = ["low", "medium"] as const;
const HIGH_RISK = ["high", "critical"] as const;

describe("decideSetStatus", () => {
  it("never permits targeting escalated, from any status, at any risk", () => {
    for (const from of MENTION_STATUSES) for (const risk of RISK_LEVELS) {
      expect(decideSetStatus(from, "escalated", risk)).toEqual({
        kind: "blocked", code: "escalation_reserved",
      });
    }
  });

  it("returns no_op when target equals current (non-escalated statuses)", () => {
    for (const status of MENTION_STATUSES) {
      if (status === "escalated") continue;
      expect(decideSetStatus(status, status, "low").kind).toBe("no_op");
    }
  });

  it("permits analyzed -> monitoring at any risk", () => {
    for (const risk of RISK_LEVELS) {
      expect(decideSetStatus("analyzed", "monitoring", risk).kind).toBe("apply");
    }
  });

  it("permits resting states from analyzed and monitoring at low/medium only", () => {
    for (const from of ["analyzed", "monitoring"] as const)
      for (const to of ["no_action_recommended", "dismissed"] as const) {
        for (const risk of LOW_RISK)
          expect(decideSetStatus(from, to, risk).kind).toBe("apply");
        for (const risk of HIGH_RISK)
          expect(decideSetStatus(from, to, risk)).toEqual({
            kind: "blocked", code: "high_risk_guardrail",
          });
      }
  });

  it("refuses every source the engine may not move", () => {
    for (const from of ["escalated", "responded", "needs_approval",
                        "draft_ready", "new"] as const)
      for (const to of MENTION_STATUSES) {
        if (to === from) continue;
        const decision = decideSetStatus(from, to, "low");
        expect(decision.kind).toBe("blocked");
      }
  });

  it("refuses every unlisted combination (full sweep)", () => {
    // The permitted set, spelled out; everything else must be blocked/no_op.
    const permitted = new Set([
      "analyzed>monitoring",
      "analyzed>no_action_recommended", "analyzed>dismissed",
      "monitoring>no_action_recommended", "monitoring>dismissed",
    ]);
    for (const from of MENTION_STATUSES) for (const to of MENTION_STATUSES) {
      const d = decideSetStatus(from, to, "low");
      if (to === "escalated") expect(d).toEqual({ kind: "blocked", code: "escalation_reserved" });
      else if (from === to) expect(d.kind).toBe("no_op");
      else if (permitted.has(`${from}>${to}`)) expect(d.kind).toBe("apply");
      else expect(d).toEqual({ kind: "blocked", code: "forbidden_transition" });
    }
  });
});

describe("decideEscalate", () => {
  it("permits from analyzed, monitoring, no_action_recommended", () => {
    for (const from of ["analyzed", "monitoring", "no_action_recommended"] as const)
      expect(decideEscalate(from).kind).toBe("apply");
  });
  it("is a no_op on an already escalated mention", () => {
    expect(decideEscalate("escalated").kind).toBe("no_op");
  });
  it("refuses dismissed (a human closed it) and the pipeline states", () => {
    for (const from of ["dismissed", "responded", "needs_approval",
                        "draft_ready", "new"] as const)
      expect(decideEscalate(from)).toEqual({
        kind: "blocked", code: "forbidden_transition",
      });
  });
});
```

If `RISK_LEVELS` is not exported from `@/domain`, export it next to `MENTION_STATUSES` in `src/domain/enums.ts` (the values already exist for `riskLevelSchema`).

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/rules-transitions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// src/lib/rules/transitions.ts
/**
 * The Phase 2 automation transition matrix (spec §7).
 *
 * Statuses are outcomes, not ranks — there is no lattice. This module is
 * the single statement of what automation may do to a mention's status;
 * the G1 execution RPC restates it in SQL, and the database-harness parity
 * test asserts the two agree cell for cell.
 *
 * `escalated` is reserved for the escalate executor: set_status may never
 * target it (`escalation_reserved`), and only `decideEscalate` says when
 * escalation is eligible. Automation never reopens a dismissed mention.
 */
import type { MentionStatus, RiskLevel } from "@/domain";
import { RISK_RANK } from "./evaluate";

export type TransitionDecision =
  | { kind: "apply" }
  | { kind: "no_op" }
  | { kind: "blocked";
      code: "forbidden_transition" | "high_risk_guardrail" | "escalation_reserved" };

const RESTING_TARGETS: readonly MentionStatus[] =
  ["no_action_recommended", "dismissed"];
const MOVABLE_SOURCES: readonly MentionStatus[] = ["analyzed", "monitoring"];

export function decideSetStatus(
  current: MentionStatus,
  target: MentionStatus,
  risk: RiskLevel,
): TransitionDecision {
  if (target === "escalated") {
    return { kind: "blocked", code: "escalation_reserved" };
  }
  if (current === target) return { kind: "no_op" };
  if (!MOVABLE_SOURCES.includes(current)) {
    return { kind: "blocked", code: "forbidden_transition" };
  }
  if (current === "analyzed" && target === "monitoring") return { kind: "apply" };
  if (RESTING_TARGETS.includes(target)) {
    if (RISK_RANK[risk] >= RISK_RANK.high) {
      return { kind: "blocked", code: "high_risk_guardrail" };
    }
    return { kind: "apply" };
  }
  return { kind: "blocked", code: "forbidden_transition" };
}

export function decideEscalate(current: MentionStatus): TransitionDecision {
  if (current === "escalated") return { kind: "no_op" };
  if (current === "analyzed" || current === "monitoring"
      || current === "no_action_recommended") {
    return { kind: "apply" };
  }
  return { kind: "blocked", code: "forbidden_transition" };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/rules-transitions.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/rules/transitions.ts tests/rules-transitions.test.ts src/domain/enums.ts
git commit -m "feat(rules): explicit automation transition matrix with escalation reserved to its executor"
```

---

### Task 6: Repository contract + demo store rows

**Files:**
- Modify: `src/lib/data/types.ts` (new repository interfaces; extend `AutomationRuleRepository`; extend `LiaDataSource`)
- Modify: `src/lib/data/demo/store.ts` (add `automationSweeps: AutomationSweep[]`, `automationRuleExecutions: AutomationRuleExecution[]`, both seeded empty)
- Test: compile only (`npx tsc --noEmit`) — behavior lands in Task 7

**Interfaces:**
- Produces (exact contract; Tasks 7–10 and the G1 plan consume it):

```ts
export interface ClaimSweepResult { sweep: AutomationSweep; claimed: boolean }

export interface FinalizeSweepInput {
  status: "completed" | "failed";
  counters: SweepCounters;
  errorCode?: string | null;
}

export interface ExecuteUnitInput {
  sweepId: string;
  automationRuleId: string;
  ruleRevision: number;
  mentionId: string;
  triggerAnalysisId: string;
  /** The revision snapshot's actions, in order. */
  actions: RuleAction[];
}

export interface RecordProjectionInput extends ExecuteUnitInput {
  status: DryRunExecutionStatus;
  outcomes: ExecutionActionOutcome[];
}

export interface AutomationSweepRepository {
  /**
   * Claim the organization's sweep. `claimed: false` returns the already
   * running sweep untouched (the caller skips the organization). A running
   * sweep older than 30 minutes is expired: marked failed
   * (`lease_expired`) and replaced by the new claim.
   */
  claim(scope: OrganizationScope,
        input: { mode: AutomationExecutionMode }): Promise<ClaimSweepResult>;
  finalize(scope: OrganizationScope, sweepId: string,
           input: FinalizeSweepInput): Promise<AutomationSweep>;
}

export interface AutomationRuleExecutionRepository {
  /**
   * The transactional unit of apply mode (spec §7): claim, validate,
   * apply via the transition matrix, record, audit — atomically. Replays
   * (same idempotency key, terminal row) return the row with zero
   * effects. In G0 only the demo adapter implements this; the Supabase
   * adapter throws DataError("unavailable") until the G1 RPC lands.
   */
  executeUnit(scope: OrganizationScope,
              input: ExecuteUnitInput): Promise<AutomationRuleExecution>;
  /** Dry run: insert a projection row; no business mutation of any kind. */
  recordProjection(scope: OrganizationScope,
                   input: RecordProjectionInput): Promise<AutomationRuleExecution>;
  listForRule(scope: OrganizationScope, ruleId: string,
              limit: number): Promise<AutomationRuleExecution[]>;
}
```

  And on `AutomationRuleRepository`:

```ts
  /** Active, unarchived, ordered priority asc, createdAt asc, id asc. */
  listActiveForExecution(scope: OrganizationScope): Promise<AutomationRule[]>;
  /**
   * Apply-mode activity stamps, monotonic (greatest of existing and new).
   * evaluatedAt always advances; matched/applied only when their flag is set.
   */
  markActivity(scope: OrganizationScope, ruleId: string, input: {
    at: string; matched: boolean; applied: boolean;
  }): Promise<void>;
```

  `LiaDataSource` gains `automationSweeps: AutomationSweepRepository` and `automationRuleExecutions: AutomationRuleExecutionRepository`.

- [ ] **Step 1: Add the interfaces** exactly as above, with doc comments, in `src/lib/data/types.ts` next to `AutomationRuleRepository`. Extend the demo store shape in `store.ts` with the two empty arrays.

- [ ] **Step 2: Stub the two adapters to satisfy the type**

Demo adapter: add `automationSweeps` and `automationRuleExecutions` objects whose methods `throw new DataError("unavailable", "Not implemented until task 7.")` — replaced in Task 7. Supabase adapter: same pattern with the message "Rule execution writes arrive with the G1 execution RPC."; implement `listForRule` as a straightforward select mapped through a new `mapAutomationRuleExecution` in `mappers.ts` (columns per Task 4's migration), and `listActiveForExecution` as a select with `status eq active`, `archived_at is null`, ordered `priority asc, created_at asc, id asc`.

- [ ] **Step 3: Compile and commit**

Run: `npx tsc --noEmit && npx vitest run`
Expected: PASS (nothing calls the stubs yet).

```bash
git add src/lib/data tests
git commit -m "feat(data): sweep and execution repository contract with demo store rows"
```

---

### Task 7: Demo adapter — full unit algorithm (claim, replay, retry, rollback)

**Files:**
- Modify: `src/lib/data/demo/index.ts` (replace Task 6 stubs)
- Test: `tests/automation-execution-repository.test.ts`

**Interfaces:**
- Consumes: Task 5's `decideSetStatus`/`decideEscalate`; Task 6's contract; existing demo `escalations.create` dedupe and `orgRows` helpers.
- Produces: working `automationSweeps.claim/finalize`, `automationRuleExecutions.executeUnit/recordProjection/listForRule`, `automationRules.listActiveForExecution/markActivity` in the demo adapter — the semantic twin the engine tests run against.

- [ ] **Step 1: Write the failing tests**

```ts
// tests/automation-execution-repository.test.ts
// Uses the same demo data-source construction as tests/automation-repositories.test.ts
// (copy its setup helper: fresh store, scope for the seeded org, a seeded
// active rule, a seeded analyzed mention with an analysis row id).
import { beforeEach, describe, expect, it } from "vitest";
// ...setup imports per the existing automation-repositories test file

describe("automationSweeps.claim", () => {
  it("claims when no sweep is running and refuses a second claim", async () => {
    const first = await ds.automationSweeps.claim(scope, { mode: "dry_run" });
    expect(first.claimed).toBe(true);
    const second = await ds.automationSweeps.claim(scope, { mode: "dry_run" });
    expect(second.claimed).toBe(false);
    expect(second.sweep.id).toBe(first.sweep.id);
  });

  it("expires a running sweep older than 30 minutes and claims fresh", async () => {
    const stale = await ds.automationSweeps.claim(scope, { mode: "apply" });
    // Backdate the running sweep past the lease (mutate the store directly,
    // the same pattern existing demo tests use for time-dependent rows).
    backdateSweep(stale.sweep.id, 31);
    const next = await ds.automationSweeps.claim(scope, { mode: "apply" });
    expect(next.claimed).toBe(true);
    const expired = getSweep(stale.sweep.id);
    expect(expired.status).toBe("failed");
    expect(expired.errorCode).toBe("lease_expired");
  });
});

describe("automationRuleExecutions.executeUnit", () => {
  it("applies a permitted set_status and records applied", async () => {
    const row = await ds.automationRuleExecutions.executeUnit(scope, unit({
      actions: [{ type: "set_status", status: "monitoring" }],
    }));
    expect(row.status).toBe("applied");
    expect(row.outcomes).toEqual([
      { index: 0, type: "set_status", outcome: "applied", code: null },
    ]);
    expect((await ds.mentions.get(scope, mentionId))!.status).toBe("monitoring");
  });

  it("replays a terminal row with zero effects", async () => {
    await ds.automationRuleExecutions.executeUnit(scope, unit({
      actions: [{ type: "set_status", status: "monitoring" }],
    }));
    const statusBefore = (await ds.mentions.get(scope, mentionId))!.status;
    const replay = await ds.automationRuleExecutions.executeUnit(scope, unit({
      actions: [{ type: "set_status", status: "monitoring" }],
    }));
    expect(replay.attemptCount).toBe(1); // untouched replay, not a retry
    expect((await ds.mentions.get(scope, mentionId))!.status).toBe(statusBefore);
    expect(countExecutionRows()).toBe(1);
  });

  it("a new trigger analysis id permits the same rule revision to run again", async () => {
    await ds.automationRuleExecutions.executeUnit(scope, unit({}));
    const again = await ds.automationRuleExecutions.executeUnit(scope, unit({
      triggerAnalysisId: newAnalysisId,
    }));
    expect(again.id).not.toBe(firstRowId());
    expect(countExecutionRows()).toBe(2);
  });

  it("escalate is validated before mutation and dedupes to no_op", async () => {
    const first = await ds.automationRuleExecutions.executeUnit(scope, unit({
      actions: [{ type: "escalate", assigneeUserId: null }],
    }));
    expect(first.status).toBe("applied");
    expect((await ds.mentions.get(scope, mentionId))!.status).toBe("escalated");
    const dupe = await ds.automationRuleExecutions.executeUnit(scope, unit({
      triggerAnalysisId: newAnalysisId,
      actions: [{ type: "escalate", assigneeUserId: null }],
    }));
    expect(dupe.status).toBe("no_op");
    expect(countOpenEscalations(mentionId)).toBe(1);
  });

  it("set_status can never produce escalated", async () => {
    const row = await ds.automationRuleExecutions.executeUnit(scope, unit({
      actions: [{ type: "set_status", status: "escalated" }],
    }));
    expect(row.status).toBe("blocked");
    expect(row.outcomes[0]).toMatchObject({
      outcome: "blocked", code: "escalation_reserved",
    });
  });

  it("technical failure rolls back the whole unit and records retryable failed", async () => {
    injectEscalationFailure(); // make escalations.create throw once
    const row = await ds.automationRuleExecutions.executeUnit(scope, unit({
      actions: [
        { type: "set_status", status: "monitoring" },
        { type: "escalate", assigneeUserId: null },
      ],
    }));
    expect(row.status).toBe("failed");
    expect(row.errorClass).toBe("retryable");
    // The earlier set_status rolled back with the unit:
    expect((await ds.mentions.get(scope, mentionId))!.status).toBe("analyzed");
  });

  it("retry after a retryable failure re-runs from committed state", async () => {
    injectEscalationFailure();
    await ds.automationRuleExecutions.executeUnit(scope, unit({
      actions: [{ type: "escalate", assigneeUserId: null }],
    }));
    const retried = await ds.automationRuleExecutions.executeUnit(scope, unit({
      actions: [{ type: "escalate", assigneeUserId: null }],
    }));
    expect(retried.status).toBe("applied");
    expect(retried.attemptCount).toBe(2);
  });

  it("stale revision fails terminally before any mutation", async () => {
    const row = await ds.automationRuleExecutions.executeUnit(scope, unit({
      ruleRevision: 999,
    }));
    expect(row.status).toBe("failed");
    expect(row.errorClass).toBe("terminal");
    expect(row.lastErrorCode).toBe("rule_changed");
    expect((await ds.mentions.get(scope, mentionId))!.status).toBe("analyzed");
  });
});

describe("markActivity", () => {
  it("is monotonic: an older stamp never overwrites a newer one", async () => {
    await ds.automationRules.markActivity(scope, ruleId,
      { at: "2026-08-11T10:00:00.000Z", matched: true, applied: true });
    await ds.automationRules.markActivity(scope, ruleId,
      { at: "2026-08-11T09:00:00.000Z", matched: true, applied: true });
    const rule = (await ds.automationRules.get(scope, ruleId))!;
    expect(rule.lastAppliedAt).toBe("2026-08-11T10:00:00.000Z");
  });
});
```

Write the helpers (`unit`, `backdateSweep`, `injectEscalationFailure`, `countExecutionRows`, `countOpenEscalations`) in the test file against the demo store — follow the store-mutation patterns already used in `tests/automation-repositories.test.ts`.

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run tests/automation-execution-repository.test.ts`
Expected: FAIL — `DataError("unavailable")` from the Task 6 stubs.

- [ ] **Step 3: Implement in `src/lib/data/demo/index.ts`**

Implementation notes that are load-bearing (the algorithm is spec §7's, single-threaded so atomicity is trivial, but rollback must be real):

- `executeUnit` first resolves an existing row by the five-part key. Terminal (`applied|partial|blocked|no_op`, or `failed`+`terminal`, or `failed`+`retryable` with `attemptCount >= 3`) → return it unchanged. `failed`+`retryable` under cap → this call is a retry: increment `attemptCount` on completion.
- Validation before any mutation: rule exists, `status === "active"`, `archivedAt === null`, `revision === input.ruleRevision` (else finalize `failed`/`terminal`/`rule_changed`); parse `input.actions` with `ruleActionSchema` array (else `invalid_action`); mention exists in scope.
- Business phase runs against **copies**: snapshot `mention.status` and the would-be escalation, apply the matrix per action in order, collect outcomes. Only after every action succeeded (or was blocked/no_op — those are outcomes, not errors) write the copies back to the store. A thrown error anywhere in the phase discards the copies (that *is* the rollback) and finalizes `failed` with `errorClass: "retryable"` and `lastErrorCode` from the error.
- `escalate` outcome `applied` sets mention status to `escalated` in the same unit; dedupe via the existing open-escalation check the demo `escalations.create` already performs → `no_op`.
- Row status derivation: all applied (some may be `no_op`) with ≥1 applied → `applied`; ≥1 applied and ≥1 blocked/failed → `partial`; none applied, ≥1 blocked, none failed → `blocked`; all no_op → `no_op`.
- `locationId` is copied from the mention at execution time.
- `recordProjection` inserts the given row (`mode: "dry_run"`, key-checked against the same unique) and touches nothing else.
- `claim`: find `running` sweep for org; fresh (< 30 min) → `{ sweep, claimed: false }`; stale → mark it `failed`/`lease_expired` and insert a new `running` row; none → insert.
- `markActivity`: `greatest` semantics via string comparison of ISO timestamps (they are UTC ISO-8601, lexicographically ordered): only overwrite when `input.at > existing`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run tests/automation-execution-repository.test.ts && npx vitest run`
Expected: PASS, full suite green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/data/demo tests/automation-execution-repository.test.ts
git commit -m "feat(data): demo execution unit with claim, replay, retry, and whole-unit rollback"
```

---

### Task 8: Environment configuration

**Files:**
- Modify: `src/lib/env.ts`
- Test: `tests/env-rules-execution.test.ts`

**Interfaces:**
- Produces:
  - `type RulesExecutionMode = "off" | "dry_run" | "apply"`
  - `resolveRulesExecutionMode(): RulesExecutionMode` — absent → `"off"`; invalid value fails the startup Zod parse like every other mode enum (F7 posture).
  - `rulesExecutionAllowlist(): string[]` — comma-separated org ids from `RULES_EXECUTION_ORG_ALLOWLIST`, trimmed, empty entries dropped; absent → `[]`.
  - `rulesExecutionLimits(): { maxMentionsPerSweep: number; maxActionsPerSweep: number; maxRulesPerMention: number; budgetMs: number }` — defaults 200 / 500 / 50 / 60000, each overridable by env (`RULES_MAX_MENTIONS_PER_SWEEP`, `RULES_MAX_ACTIONS_PER_SWEEP`, `RULES_MAX_RULES_PER_MENTION`, `RULES_EXECUTION_BUDGET_MS`, positive-int validated at startup).

- [ ] **Step 1: Write the failing test**

```ts
// tests/env-rules-execution.test.ts
import { afterEach, describe, expect, it, vi } from "vitest";

async function loadEnv(vars: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return import("@/lib/env");
}

afterEach(() => {
  delete process.env.RULES_EXECUTION_MODE;
  delete process.env.RULES_EXECUTION_ORG_ALLOWLIST;
  delete process.env.RULES_MAX_MENTIONS_PER_SWEEP;
});

describe("rules execution env", () => {
  it("defaults to off when unset", async () => {
    const env = await loadEnv({ RULES_EXECUTION_MODE: undefined });
    expect(env.resolveRulesExecutionMode()).toBe("off");
  });

  it("round-trips dry_run and apply", async () => {
    expect((await loadEnv({ RULES_EXECUTION_MODE: "dry_run" }))
      .resolveRulesExecutionMode()).toBe("dry_run");
    expect((await loadEnv({ RULES_EXECUTION_MODE: "apply" }))
      .resolveRulesExecutionMode()).toBe("apply");
  });

  it("parses the allowlist, dropping empties and whitespace", async () => {
    const env = await loadEnv({ RULES_EXECUTION_ORG_ALLOWLIST: "a, b,,c" });
    expect(env.rulesExecutionAllowlist()).toEqual(["a", "b", "c"]);
    const empty = await loadEnv({ RULES_EXECUTION_ORG_ALLOWLIST: undefined });
    expect(empty.rulesExecutionAllowlist()).toEqual([]);
  });

  it("serves limit defaults and env overrides", async () => {
    const env = await loadEnv({});
    expect(env.rulesExecutionLimits()).toEqual({
      maxMentionsPerSweep: 200, maxActionsPerSweep: 500,
      maxRulesPerMention: 50, budgetMs: 60_000,
    });
    const tuned = await loadEnv({ RULES_MAX_MENTIONS_PER_SWEEP: "25" });
    expect(tuned.rulesExecutionLimits().maxMentionsPerSweep).toBe(25);
  });
});
```

(Note the invalid-mode case is deliberately absent from unit tests: an unknown `RULES_EXECUTION_MODE` fails the module's startup Zod parse, which would fail the import itself — assert it by expecting `loadEnv({ RULES_EXECUTION_MODE: "on" })` to reject, matching how the existing mode enums behave.)

- [ ] **Step 2: Verify it fails**, **Step 3: implement** following the exact style of `newsModeSchema`/`resolveNewsMode` — a `z.enum(["off","dry_run","dry-run" is NOT accepted — exactly "off","dry_run","apply"])` field on `envSchema`, defaulting nothing; helpers exported at the bottom with the others. Add a doc comment stating: "Execution changes what the product does to customer data without a person in the loop; absence of configuration must mean absence of the behavior."

- [ ] **Step 4: Verify pass + full suite. Step 5: Commit**

```bash
git add src/lib/env.ts tests/env-rules-execution.test.ts
git commit -m "feat(env): rules execution mode, allowlist, and sweep limits, fail-closed"
```

---

### Task 9: Analysis result carries the trigger occurrences

**Files:**
- Modify: `src/lib/analysis/analyze.ts`
- Test: extend `tests/analysis.test.ts` (or the existing analyze service test file — locate with `grep -rln "analyzeMentions" tests/`)

**Interfaces:**
- Consumes: `createAnalysis` already returns the `MentionAnalysis` row (F13).
- Produces: `AnalyzeMentionsResult` gains `processed: { mentionId: string; analysisId: string }[]` — one entry per mention whose analysis row was written this run (both model and heuristic outcomes; failed mentions excluded).

- [ ] **Step 1: Write the failing test** — run `analyzeMentions` against the demo adapter over a seed with N unanalyzed mentions; assert `result.processed.length === result.counts.analyzed + result.counts.heuristic` and that each `analysisId` resolves to an analysis row for its `mentionId`.

- [ ] **Step 2: Verify fail. Step 3: Implement** — in `analyzeOne`, return the created analysis row's id alongside the existing `ItemOutcome`; accumulate pairs in the run loop; include in the result. Do not change the write order (escalation → mention update → analysis insert) — the comment in the file explains why it is load-bearing.

- [ ] **Step 4: Verify pass + full suite. Step 5: Commit**

```bash
git add src/lib/analysis/analyze.ts tests
git commit -m "feat(analysis): report processed mention/analysis pairs for rule execution"
```

---

### Task 10: The engine loop (`executeRules`)

**Files:**
- Create: `src/lib/rules/execute.ts`
- Test: `tests/rules-execute.test.ts`

**Interfaces:**
- Consumes: Task 5 matrix, Task 6/7 repositories, Task 8 env limits, `matchesRule`/`RuleSubject` from `src/lib/rules/evaluate.ts`, `Mention` fields for subject building (`status`, `sentiment`, `riskLevel`, `relevanceScore`, `rating`, `sourceType`, `locationId`, `platform`).
- Produces:

```ts
export interface ExecuteRulesInput {
  mode: "dry_run" | "apply";
  processed: { mentionId: string; analysisId: string }[];
}
export interface ExecuteRulesResult {
  sweepId: string | null;      // null when the claim was refused or no rules
  claimed: boolean;
  counters: SweepCounters;
  mentionsSkipped: number;     // cap/budget truncation, reported never silent
  budgetExhausted: boolean;
}
export async function executeRules(
  context: { dataSource: LiaDataSource; scope: OrganizationScope },
  input: ExecuteRulesInput,
): Promise<ExecuteRulesResult>;
```

- [ ] **Step 1: Write the failing tests** — against the demo adapter:

1. No active rules → returns immediately, `sweepId: null`, no sweep row.
2. Claim refused (pre-inserted running sweep) → `claimed: false`, nothing evaluated.
3. Deterministic order: two matching rules with equal priority — outcomes land in `createdAt` order (assert by execution-row order per mention).
4. Dry run end-to-end: matching rule produces a `would_apply` projection; **table-by-table zero-mutation assertion** — snapshot `mentions`, `escalations`, `automationRules` (timestamps), `auditEvents` row counts and the mention statuses before, compare after; only sweeps + executions changed.
5. Apply end-to-end (demo): permitted `set_status` applied, counters correct, `markActivity` stamped evaluated/matched/applied.
6. Mention cap: `maxMentionsPerSweep: 1` (inject via a limits parameter defaulted from env — make limits injectable for tests) with two processed pairs → one evaluated, `mentionsSkipped: 1`.
7. Budget: a fake clock injected the way existing services take clocks (see `src/lib/seed/clock.ts` pattern) exhausts the budget after the first mention → clean stop, `budgetExhausted: true`.
8. Snapshot semantics: rule edited (revision bumped) between load and unit execution → the unit records terminal `rule_changed` (drive by bumping revision inside a hook between claim and execute using the demo store).
9. Dry run for a rule whose conditions do not match writes **no** execution row (`no_match` writes nothing — spec §5), but `mentionsEvaluated` counts it.

- [ ] **Step 2: Verify they fail.**

- [ ] **Step 3: Implement** `executeRules`:

- Guard: `input.processed.length === 0` → return the empty result without claiming.
- Load rules via `listActiveForExecution`; none → return without claiming.
- `automationSweeps.claim(scope, { mode })`; `claimed: false` → return.
- Loop mentions up to `maxMentionsPerSweep` and while budget remains: load mention, build `RuleSubject` (exact fields from `evaluate.ts`; the subject's `status` is the current stored status), evaluate each rule in order (cap `maxRulesPerMention`), and for matches:
  - `dry_run`: compute per-action projections with the matrix (`decideSetStatus`/`decideEscalate` mapped to `would_*`; schema-invalid actions → row status `would_fail_validation`), then `recordProjection`.
  - `apply`: call `executeUnit`; then `markActivity` with `matched: true, applied: status is applied|partial`. For non-matching rules in apply mode, `markActivity` with `matched: false, applied: false` once per rule per sweep (collect the rule ids and stamp after the loop, not per mention).
  - Track `actionsApplied` etc. from returned outcomes; stop when `maxActionsPerSweep` reached (report skip).
- Wrap per-mention work so one mention's unexpected error increments `terminalFailures` and continues (the unit itself already contains its own failure handling; this catch is for subject-building errors).
- `automationSweeps.finalize` with `completed` (or `failed` + code when the loop itself died); return counters.

- [ ] **Step 4: Verify pass + full suite. Step 5: Commit**

```bash
git add src/lib/rules/execute.ts tests/rules-execute.test.ts
git commit -m "feat(rules): dry-run-capable execution sweep with claims, caps, and honest truncation"
```

---

### Task 11: Cron route integration and response contract

**Files:**
- Modify: `src/app/api/cron/analyze-mentions/route.ts`
- Test: `tests/rules-execution-route.test.ts` (or extend the existing route test — locate with `grep -rln "analyze-mentions" tests/`)

**Interfaces:**
- Consumes: Tasks 8–10.
- Produces: the spec §10 response shape — top-level `status: "ok" | "degraded" | "failed"`, `analysis` block (existing totals, unchanged fields), `execution` block (`mode`, `sweeps[]`, `organizationsAttempted`, `organizationsCompleted`).

- [ ] **Step 1: Write the failing tests** — drive the route handler directly (existing route tests show the pattern; they stub `getServiceDataSource`):

1. Mode `off` → no sweep claims; response carries `execution: { mode: "off" }` and analysis behavior is byte-identical to today's fields.
2. Mode `dry_run`, org not in allowlist → skipped, said in response.
3. Mode `dry_run`, allowlisted org → `executeRules` called with the org's processed pairs from the analysis result; sweep summary in response.
4. Status mapping table (spec §10): all-good → `ok`/200; one org errored while another succeeded → `degraded`/200; every attempted org failed → `failed`/503; enumeration threw → `failed`/500; bad secret → 401.
5. Execution failure in one org does not prevent the next org's execution (per-org try/catch).

- [ ] **Step 2: Verify they fail. Step 3: Implement** — after the existing per-org `analyzeMentions` call succeeds, when mode ≠ off and org allowlisted, call `executeRules({ dataSource, scope }, { mode, processed: result.processed })` in its own try/catch; accumulate sweep summaries; compute `status` per the table (existing analysis failures now also produce `degraded` — this deliberately fixes F8); keep the `console.error` redaction posture for the 500 path.

- [ ] **Step 4: Verify pass + full suite. Step 5: Commit**

```bash
git add src/app/api/cron/analyze-mentions/route.ts tests
git commit -m "feat(cron): execution sweeps in the analysis route with ok/degraded/failed reporting"
```

---

### Task 12: Rule detail execution history and mode-aware states

**Files:**
- Modify: `src/app/(app)/rules/[ruleId]/page.tsx`
- Create: `src/components/rules/execution-history.tsx`
- Test: extend the existing rules page/component test file (locate with `grep -rln "rules/\[ruleId\]\|readiness-checklist" tests/`); follow its server-render test pattern

**Interfaces:**
- Consumes: `automationRuleExecutions.listForRule(scope, ruleId, 20)`, Task 3's three timestamps, `resolveRulesExecutionMode()`.
- Produces: an "Execution history" section on the rule detail page.

- [ ] **Step 1: Write the failing test** — render the detail page (or the `ExecutionHistory` component directly with props) for three states: mode `off` → "Rule execution is off — rules are not yet applied to mentions."; mode active + no rows → "No executions yet."; rows present → table with executed-at, mention link, mode badge ("Projection" for dry-run rows — a projection must never read as an applied action), status in sentence case, and per-action outcome codes spelled out ("blocked: escalation is reserved for the escalate action", "blocked: high-risk mentions cannot be moved to a resting state", "blocked: transition not permitted", "no change: already true").

- [ ] **Step 2: Verify fail. Step 3: Implement** — `ExecutionHistory` as a server-component-friendly presentational component (props: rows, mode); page fetches rows and the mode, shows the three activity timestamps ("Last evaluated", "Last matched", "Last applied") in the detail header area. Use existing primitives (`DataTable` or the list styles the page already uses, `StatusBadge` conventions, sentence case).

- [ ] **Step 4: Verify pass, full suite, and `npx tsc --noEmit`. Step 5: Commit**

```bash
git add src/app/\(app\)/rules src/components/rules tests
git commit -m "feat(rules): execution history with projection-distinct rows and mode-aware empty states"
```

---

### Task 13: Reset verification (P0-2) and docs

**Files:**
- Modify: `docs/architecture/current-state.md` (decision ledger + gaps)
- Modify: `docs/superpowers/specs/2026-08-11-rules-execution-phase2-design.md` (mark G0 items implemented)

- [ ] **Step 1: Attempt the harness**

Run: `supabase db reset` then `npm run db:verify-rls` (requires Docker).
Expected: PASS. **If Docker is unavailable on this machine, stop and report to the user that P0-2 remains outstanding — do not mark it done, and record in current-state.md that G0 migrations exist but the reset gate has not run.** The hosted project receives nothing until it passes.

- [ ] **Step 2: Update docs** — add decision-ledger rows for: the trigger-occurrence idempotency key; the transition matrix replacing the lattice; whole-unit rollback; dry-run vocabulary; mode/allowlist gating; the three activity timestamps. Update the known-gaps section: G0 ships dry run only; the G1 plan (RPC, audit hardening, location-scoping fixes) is next; the spec's release gates govern `apply`.

- [ ] **Step 3: Full verification**

Run: `npm run verify`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add docs
git commit -m "docs: record G0 execution decisions and the outstanding reset gate"
```

---

## Not in this plan (G1 plan, written after G0 lands)

The execution RPC migration and Supabase `executeUnit`, the audit-hardening
migration + adapter change (spec §6), the P0-4 location-scoping action
fixes, the audit vocabulary migration, the full database harness (spec §11
DB-1…DB-10), and enabling `apply` for the internal organization. G0's
Supabase adapter deliberately throws on `executeUnit` so no path can apply
effects against real data before the RPC exists.
