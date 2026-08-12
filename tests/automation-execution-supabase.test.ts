import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { createSupabaseDataSource } from "@/lib/data/supabase";
import type {
  ExecuteUnitInput,
  OrganizationScope,
  RecordProjectionInput,
} from "@/lib/data/types";
import { zeroSweepCounters } from "@/domain";

/**
 * The Supabase adapter's automation entry points (Task 10): `execute_automation_rule`,
 * `claim_automation_sweep`, `automation_mark_activity`, and the plain-table
 * writes `automationSweeps.finalize` and `automationRuleExecutions.recordProjection`
 * (dry run has no RPC — a dry run touches exactly one table, so there is
 * nothing for a transaction to coordinate).
 *
 * Same shape as `tests/audit-events-service-write.test.ts` and the Supabase
 * section of `tests/escalation-contract.test.ts`: every write here goes
 * through the service-role client (this is cron/background territory — no
 * user session — mirroring `oauthStates` and `platformCredentials`), so
 * `createSupabaseServiceClient` is mocked and handed a stub that records
 * exactly what crossed the wire, with no real database involved. What is
 * pinned:
 *
 *   - every RPC payload uses the function's own `p_`-prefixed parameter
 *     names, exactly (a typo here would slip past TypeScript entirely, since
 *     `.rpc()`'s payload is an untyped `Record<string, unknown>`)
 *   - a PostgREST error never crosses this boundary raw — it always becomes
 *     a `DataError`
 *   - `claim`'s `{ claimed: false }` shape when another sweep already holds
 *     the lease
 *   - `recordProjection`'s insert-with-`ignoreDuplicates`-then-read-back:
 *     a replay returns the row already stored, not the caller's own
 *     (discarded) projection
 */

const { createSupabaseServiceClient } = vi.hoisted(() => ({
  createSupabaseServiceClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient,
}));

/** No call should ever reach the caller's own session client from these methods. */
const unusableClient = {
  from() {
    throw new Error("The adapter must route through the service client, never this one.");
  },
  rpc() {
    throw new Error("The adapter must route through the service client, never this one.");
  },
} as unknown as SupabaseClient;

const supabaseScope: OrganizationScope = {
  organizationId: crypto.randomUUID(),
  userId: crypto.randomUUID(),
  role: "admin",
};

interface FakeResult {
  data: unknown;
  error: unknown;
}

interface FakeChain extends PromiseLike<FakeResult> {
  select: (...args: unknown[]) => FakeChain;
  eq: (...args: unknown[]) => FakeChain;
  update: (...args: unknown[]) => FakeChain;
  upsert: (...args: unknown[]) => FakeChain;
  maybeSingle: () => Promise<FakeResult>;
  single: () => Promise<FakeResult>;
}

interface FromCall {
  table: string;
  method: string;
  args: unknown[];
}

/**
 * A stub service-role client.
 *
 * `responses` is keyed by table name for `.from(table)` reads/writes, and by
 * `rpc:<function name>` for `.rpc()` calls; each key holds a queue consumed
 * in call order, which is how a test expresses "the insert lands, then a
 * separate read returns something else" (`recordProjection`'s replay case).
 * A chain with no terminal method called (`.upsert(...)` awaited directly,
 * with no `.select()` after it) still resolves, because the chain itself is
 * a `PromiseLike` — the same shape `@supabase/supabase-js`'s own query
 * builder has.
 */
function makeStub(responses: Record<string, FakeResult[]>) {
  const rpcCalls: Array<{ fn: string; payload: Record<string, unknown> }> = [];
  const fromCalls: FromCall[] = [];

  function next(table: string): FakeResult {
    const queue = responses[table];
    if (!queue || queue.length === 0) return { data: null, error: null };
    return queue.shift() as FakeResult;
  }

  function chain(table: string): FakeChain {
    const c: FakeChain = {
      select: (...args: unknown[]) => {
        fromCalls.push({ table, method: "select", args });
        return c;
      },
      eq: (...args: unknown[]) => {
        fromCalls.push({ table, method: "eq", args });
        return c;
      },
      update: (...args: unknown[]) => {
        fromCalls.push({ table, method: "update", args });
        return c;
      },
      upsert: (...args: unknown[]) => {
        fromCalls.push({ table, method: "upsert", args });
        return c;
      },
      maybeSingle: () => {
        fromCalls.push({ table, method: "maybeSingle", args: [] });
        return Promise.resolve(next(table));
      },
      single: () => {
        fromCalls.push({ table, method: "single", args: [] });
        return Promise.resolve(next(table));
      },
      then: (onFulfilled, onRejected) => Promise.resolve(next(table)).then(onFulfilled, onRejected),
    };
    return c;
  }

  const client = {
    rpc: (fn: string, payload: Record<string, unknown>) => {
      rpcCalls.push({ fn, payload });
      const queue = responses[`rpc:${fn}`];
      const result = queue && queue.length ? (queue.shift() as FakeResult) : { data: null, error: null };
      return Promise.resolve(result);
    },
    from: (table: string) => chain(table),
  } as unknown as SupabaseClient;

  return { client, rpcCalls, fromCalls };
}

function sweepRow(id: string, overrides: Record<string, unknown> = {}) {
  return {
    id,
    organization_id: supabaseScope.organizationId,
    mode: "apply",
    status: "running",
    started_at: new Date().toISOString(),
    completed_at: null,
    mentions_evaluated: 0,
    rules_matched: 0,
    actions_applied: 0,
    actions_blocked: 0,
    actions_skipped: 0,
    actions_failed: 0,
    retryable_failures: 0,
    terminal_failures: 0,
    error_code: null,
    ...overrides,
  };
}

function executionRow(overrides: Record<string, unknown> = {}) {
  return {
    id: crypto.randomUUID(),
    organization_id: supabaseScope.organizationId,
    sweep_id: crypto.randomUUID(),
    automation_rule_id: crypto.randomUUID(),
    rule_revision: 1,
    mention_id: crypto.randomUUID(),
    trigger_analysis_id: crypto.randomUUID(),
    location_id: null,
    mode: "apply",
    status: "applied",
    outcomes: [],
    outcome_schema_version: 1,
    attempt_count: 1,
    last_error_code: null,
    error_class: null,
    started_at: new Date().toISOString(),
    completed_at: new Date().toISOString(),
    ...overrides,
  };
}

const genericError = { message: "boom", code: "XX000" };

beforeEach(() => {
  createSupabaseServiceClient.mockReset();
});

describe("automationRules.markActivity", () => {
  it("calls automation_mark_activity with the function's exact p_-prefixed params", async () => {
    const ruleId = crypto.randomUUID();
    const { client, rpcCalls } = makeStub({
      "rpc:automation_mark_activity": [{ data: null, error: null }],
    });
    createSupabaseServiceClient.mockReturnValue(client);
    const remote = createSupabaseDataSource(unusableClient);

    await remote.automationRules.markActivity(supabaseScope, ruleId, {
      at: "2026-08-12T00:00:00.000Z",
      matched: true,
      applied: false,
    });

    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]?.fn).toBe("automation_mark_activity");
    expect(rpcCalls[0]?.payload).toStrictEqual({
      p_organization_id: supabaseScope.organizationId,
      p_rule_id: ruleId,
      p_at: "2026-08-12T00:00:00.000Z",
      p_matched: true,
      p_applied: false,
    });
  });

  it("translates a postgrest error into a DataError, never the raw error", async () => {
    const { client } = makeStub({
      "rpc:automation_mark_activity": [{ data: null, error: genericError }],
    });
    createSupabaseServiceClient.mockReturnValue(client);
    const remote = createSupabaseDataSource(unusableClient);

    await expect(
      remote.automationRules.markActivity(supabaseScope, crypto.randomUUID(), {
        at: new Date().toISOString(),
        matched: false,
        applied: false,
      }),
    ).rejects.toEqual(
      expect.objectContaining({ name: "DataError", message: expect.not.stringContaining("boom") }),
    );
  });
});

/**
 * `fail()`'s SQLSTATE branches (`src/lib/data/supabase/index.ts`, just above
 * `createSupabaseDataSource`) are shared by every write in this adapter, so
 * this pins the branch logic itself through one representative, simple call
 * site — `markActivity` (a single RPC, no read-back to also stub) — rather
 * than repeating the same three cases at every one of this task's call
 * sites.
 *
 * Live review against a real database found that both P0002 (raised by
 * every entry-point RPC here for "the row this call named isn't there" — a
 * missing mention or occurrence) and 23503 (a same-tenant/same-parent
 * foreign-key refusal — a mention that doesn't belong to the claimed
 * organization, an occurrence that doesn't belong to the claimed mention)
 * were falling into the generic `unavailable` branch: a permanent condition
 * — retrying with the same id fails the same way forever — labelled as
 * transient. Fixed by giving both their own branches ahead of the generic
 * fallback.
 */
describe("fail(): PostgREST error code translation", () => {
  it("translates P0002 (the named row does not exist) into not_found, never the raw message", async () => {
    const { client } = makeStub({
      "rpc:automation_mark_activity": [{ data: null, error: { message: "boom", code: "P0002" } }],
    });
    createSupabaseServiceClient.mockReturnValue(client);
    const remote = createSupabaseDataSource(unusableClient);

    await expect(
      remote.automationRules.markActivity(supabaseScope, crypto.randomUUID(), {
        at: new Date().toISOString(),
        matched: false,
        applied: false,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "DataError",
        code: "not_found",
        message: expect.not.stringContaining("boom"),
      }),
    );
  });

  it("translates 23503 (a foreign-key refusal) into invalid_input, never the raw message", async () => {
    const { client } = makeStub({
      "rpc:automation_mark_activity": [{ data: null, error: { message: "boom", code: "23503" } }],
    });
    createSupabaseServiceClient.mockReturnValue(client);
    const remote = createSupabaseDataSource(unusableClient);

    await expect(
      remote.automationRules.markActivity(supabaseScope, crypto.randomUUID(), {
        at: new Date().toISOString(),
        matched: false,
        applied: false,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "DataError",
        code: "invalid_input",
        message: expect.not.stringContaining("boom"),
      }),
    );
  });

  it("still falls through to unavailable for an unclassified SQLSTATE — the pre-existing fallback, unregressed", async () => {
    const { client } = makeStub({
      "rpc:automation_mark_activity": [{ data: null, error: genericError }],
    });
    createSupabaseServiceClient.mockReturnValue(client);
    const remote = createSupabaseDataSource(unusableClient);

    await expect(
      remote.automationRules.markActivity(supabaseScope, crypto.randomUUID(), {
        at: new Date().toISOString(),
        matched: false,
        applied: false,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "DataError",
        code: "unavailable",
        message: expect.not.stringContaining("boom"),
      }),
    );
  });
});

describe("automationSweeps.claim", () => {
  it("claims via claim_automation_sweep with exact p_-prefixed params, then re-reads the sweep row by id", async () => {
    const sweepId = crypto.randomUUID();
    const row = sweepRow(sweepId, { status: "running" });

    const { client, rpcCalls, fromCalls } = makeStub({
      "rpc:claim_automation_sweep": [{ data: [{ sweep: { id: sweepId }, claimed: true }], error: null }],
      automation_sweeps: [{ data: row, error: null }],
    });
    createSupabaseServiceClient.mockReturnValue(client);
    const remote = createSupabaseDataSource(unusableClient);

    const result = await remote.automationSweeps.claim(supabaseScope, { mode: "apply" });

    expect(result.claimed).toBe(true);
    expect(result.sweep.id).toBe(sweepId);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]?.fn).toBe("claim_automation_sweep");
    expect(rpcCalls[0]?.payload).toStrictEqual({
      p_organization_id: supabaseScope.organizationId,
      p_mode: "apply",
    });
    // The re-read is scoped by both the sweep's own id and the caller's
    // organization — never trusts the nested composite payload beyond its id.
    expect(
      fromCalls.some(
        (c) => c.table === "automation_sweeps" && c.method === "eq" && c.args[0] === "id" && c.args[1] === sweepId,
      ),
    ).toBe(true);
    expect(
      fromCalls.some(
        (c) =>
          c.table === "automation_sweeps" &&
          c.method === "eq" &&
          c.args[0] === "organization_id" &&
          c.args[1] === supabaseScope.organizationId,
      ),
    ).toBe(true);
  });

  it("reports { claimed: false } when another sweep already holds the lease", async () => {
    const sweepId = crypto.randomUUID();
    const row = sweepRow(sweepId, { status: "running" });

    const { client } = makeStub({
      "rpc:claim_automation_sweep": [{ data: [{ sweep: { id: sweepId }, claimed: false }], error: null }],
      automation_sweeps: [{ data: row, error: null }],
    });
    createSupabaseServiceClient.mockReturnValue(client);
    const remote = createSupabaseDataSource(unusableClient);

    const result = await remote.automationSweeps.claim(supabaseScope, { mode: "apply" });

    expect(result).toEqual({ claimed: false, sweep: expect.objectContaining({ id: sweepId, status: "running" }) });
  });

  it("translates a postgrest error into a DataError, never the raw error", async () => {
    const { client } = makeStub({
      "rpc:claim_automation_sweep": [{ data: null, error: genericError }],
    });
    createSupabaseServiceClient.mockReturnValue(client);
    const remote = createSupabaseDataSource(unusableClient);

    await expect(remote.automationSweeps.claim(supabaseScope, { mode: "dry_run" })).rejects.toEqual(
      expect.objectContaining({ name: "DataError", message: expect.not.stringContaining("boom") }),
    );
  });
});

describe("automationSweeps.finalize", () => {
  it("updates status and every counter column", async () => {
    const sweepId = crypto.randomUUID();
    const row = sweepRow(sweepId, { status: "completed", mentions_evaluated: 10, rules_matched: 2 });

    const { client, fromCalls } = makeStub({
      automation_sweeps: [{ data: row, error: null }],
    });
    createSupabaseServiceClient.mockReturnValue(client);
    const remote = createSupabaseDataSource(unusableClient);

    const result = await remote.automationSweeps.finalize(supabaseScope, sweepId, {
      status: "completed",
      counters: {
        mentionsEvaluated: 10,
        rulesMatched: 2,
        actionsApplied: 1,
        actionsBlocked: 0,
        actionsSkipped: 0,
        actionsFailed: 0,
        retryableFailures: 0,
        terminalFailures: 0,
      },
      errorCode: null,
    });

    expect(result.status).toBe("completed");
    const updateCall = fromCalls.find((c) => c.table === "automation_sweeps" && c.method === "update");
    expect(updateCall?.args[0]).toMatchObject({
      status: "completed",
      mentions_evaluated: 10,
      rules_matched: 2,
      actions_applied: 1,
      actions_blocked: 0,
      actions_skipped: 0,
      actions_failed: 0,
      retryable_failures: 0,
      terminal_failures: 0,
      error_code: null,
    });
  });

  it("throws not_found when the update matches no row", async () => {
    const { client } = makeStub({ automation_sweeps: [{ data: null, error: null }] });
    createSupabaseServiceClient.mockReturnValue(client);
    const remote = createSupabaseDataSource(unusableClient);

    await expect(
      remote.automationSweeps.finalize(supabaseScope, crypto.randomUUID(), {
        status: "failed",
        counters: zeroSweepCounters(),
        errorCode: "boom",
      }),
    ).rejects.toMatchObject({ code: "not_found" });
  });
});

describe("automationRuleExecutions.executeUnit", () => {
  const input: ExecuteUnitInput = {
    sweepId: crypto.randomUUID(),
    automationRuleId: crypto.randomUUID(),
    ruleRevision: 3,
    mentionId: crypto.randomUUID(),
    triggerAnalysisId: crypto.randomUUID(),
  };

  it("calls execute_automation_rule with exact p_-prefixed params, mapping the unwrapped composite row", async () => {
    // `execute_automation_rule` is declared `returns public.automation_rule_executions`
    // with no `SETOF` — PostgREST answers with that row's JSON object
    // directly, not wrapped in an array. This fixture sends it that way on
    // purpose, to pin that `singleRow` accepts the unwrapped shape.
    const row = executionRow({
      sweep_id: input.sweepId,
      automation_rule_id: input.automationRuleId,
      rule_revision: input.ruleRevision,
      mention_id: input.mentionId,
      trigger_analysis_id: input.triggerAnalysisId,
      status: "applied",
    });

    const { client, rpcCalls } = makeStub({
      "rpc:execute_automation_rule": [{ data: row, error: null }],
    });
    createSupabaseServiceClient.mockReturnValue(client);
    const remote = createSupabaseDataSource(unusableClient);

    const result = await remote.automationRuleExecutions.executeUnit(supabaseScope, input);

    expect(result.status).toBe("applied");
    expect(result.mentionId).toBe(input.mentionId);
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]?.fn).toBe("execute_automation_rule");
    expect(rpcCalls[0]?.payload).toStrictEqual({
      p_organization_id: supabaseScope.organizationId,
      p_sweep_id: input.sweepId,
      p_rule_id: input.automationRuleId,
      p_revision: input.ruleRevision,
      p_mention_id: input.mentionId,
      p_analysis_id: input.triggerAnalysisId,
    });
  });

  it("translates a postgrest error into a DataError, never the raw error", async () => {
    const { client } = makeStub({
      "rpc:execute_automation_rule": [{ data: null, error: genericError }],
    });
    createSupabaseServiceClient.mockReturnValue(client);
    const remote = createSupabaseDataSource(unusableClient);

    await expect(remote.automationRuleExecutions.executeUnit(supabaseScope, input)).rejects.toEqual(
      expect.objectContaining({ name: "DataError", message: expect.not.stringContaining("boom") }),
    );
  });
});

describe("automationRuleExecutions.recordProjection", () => {
  const baseInput: RecordProjectionInput = {
    sweepId: crypto.randomUUID(),
    automationRuleId: crypto.randomUUID(),
    ruleRevision: 1,
    mentionId: crypto.randomUUID(),
    triggerAnalysisId: crypto.randomUUID(),
    status: "would_apply",
    outcomes: [],
  };

  it("inserts with ignoreDuplicates against the idempotency key, then reads the row back", async () => {
    const locationId = crypto.randomUUID();
    const stored = executionRow({
      sweep_id: baseInput.sweepId,
      automation_rule_id: baseInput.automationRuleId,
      rule_revision: baseInput.ruleRevision,
      mention_id: baseInput.mentionId,
      trigger_analysis_id: baseInput.triggerAnalysisId,
      location_id: locationId,
      mode: "dry_run",
      status: "would_apply",
    });

    const { client, fromCalls } = makeStub({
      mentions: [{ data: { location_id: locationId }, error: null }],
      automation_rule_executions: [
        { data: null, error: null }, // the insert itself, awaited with no .select()
        { data: stored, error: null }, // the read-back
      ],
    });
    createSupabaseServiceClient.mockReturnValue(client);
    const remote = createSupabaseDataSource(unusableClient);

    const result = await remote.automationRuleExecutions.recordProjection(supabaseScope, baseInput);

    expect(result.mode).toBe("dry_run");
    expect(result.status).toBe("would_apply");
    expect(result.locationId).toBe(locationId);

    const upsertCall = fromCalls.find(
      (c) => c.table === "automation_rule_executions" && c.method === "upsert",
    );
    expect(upsertCall).toBeDefined();
    expect(upsertCall?.args[0]).toMatchObject({
      organization_id: supabaseScope.organizationId,
      sweep_id: baseInput.sweepId,
      automation_rule_id: baseInput.automationRuleId,
      rule_revision: baseInput.ruleRevision,
      mention_id: baseInput.mentionId,
      trigger_analysis_id: baseInput.triggerAnalysisId,
      location_id: locationId,
      mode: "dry_run",
      status: "would_apply",
    });
    expect(upsertCall?.args[1]).toMatchObject({
      onConflict: "automation_rule_id,rule_revision,mention_id,trigger_analysis_id,mode",
      ignoreDuplicates: true,
    });
  });

  it("returns the STORED row on replay, not the caller's own (discarded) projection", async () => {
    // A different, earlier caller's projection is what is actually on disk —
    // `would_block`, not this call's `would_apply`. The insert silently
    // no-ops against the idempotency key, and the read-back is what proves
    // the STORED value wins.
    const stored = executionRow({
      sweep_id: baseInput.sweepId,
      automation_rule_id: baseInput.automationRuleId,
      rule_revision: baseInput.ruleRevision,
      mention_id: baseInput.mentionId,
      trigger_analysis_id: baseInput.triggerAnalysisId,
      mode: "dry_run",
      status: "would_block",
    });

    const { client } = makeStub({
      mentions: [{ data: { location_id: null }, error: null }],
      automation_rule_executions: [
        { data: null, error: null },
        { data: stored, error: null },
      ],
    });
    createSupabaseServiceClient.mockReturnValue(client);
    const remote = createSupabaseDataSource(unusableClient);

    const result = await remote.automationRuleExecutions.recordProjection(supabaseScope, {
      ...baseInput,
      status: "would_apply",
    });

    expect(result.status).toBe("would_block");
  });

  it("throws not_found when the mention does not exist in this organization", async () => {
    const { client } = makeStub({ mentions: [{ data: null, error: null }] });
    createSupabaseServiceClient.mockReturnValue(client);
    const remote = createSupabaseDataSource(unusableClient);

    await expect(
      remote.automationRuleExecutions.recordProjection(supabaseScope, baseInput),
    ).rejects.toMatchObject({ code: "not_found" });
  });

  it("translates a postgrest error on the insert into a DataError, never the raw error", async () => {
    const { client } = makeStub({
      mentions: [{ data: { location_id: null }, error: null }],
      automation_rule_executions: [{ data: null, error: genericError }],
    });
    createSupabaseServiceClient.mockReturnValue(client);
    const remote = createSupabaseDataSource(unusableClient);

    await expect(
      remote.automationRuleExecutions.recordProjection(supabaseScope, baseInput),
    ).rejects.toEqual(
      expect.objectContaining({ name: "DataError", message: expect.not.stringContaining("boom") }),
    );
  });
});
