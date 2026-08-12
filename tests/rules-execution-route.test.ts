import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { zeroSweepCounters, type SweepCounters } from "@/domain";
import type { OrganizationScope } from "@/lib/data/types";
import type { ExecuteRulesResult } from "@/lib/rules/execute";

const SECRET = "test-cron-secret-value";
const LEAK_MARKER = "connection string postgres://cron_user:s3cr3t@db.internal/lia";

/**
 * The analyse-mentions cron route as the *execution* entry point (spec §10).
 *
 * `tests/cron-sweep-mocked.test.ts` owns the analysis half of this route —
 * per-organization isolation, lock-conflict counting, the 500 redaction
 * property. This file owns what Task 11 added on top: whether an execution
 * sweep runs at all (mode, allowlist), what it is called with, how its result
 * is reported, and the `ok` / `degraded` / `failed` status table.
 *
 * `@/lib/rules/execute` is mocked so each organization's sweep outcome can be
 * scripted — including a sweep that throws, which `executeRules` deliberately
 * rethrows once it has finalized its own row, and which must therefore cost
 * one organization and no others.
 *
 * The environment is stubbed rather than mocked: `resolveRulesExecutionMode`
 * and `rulesExecutionAllowlist` read a module-level parse of `process.env`, so
 * `vi.stubEnv` plus the `vi.resetModules()` in `afterEach` exercises the real
 * resolution path instead of a test double of it.
 */

const {
  listWithUnanalyzedMentions,
  analyzeMentionsMock,
  getServiceDataSourceMock,
  executeRulesMock,
} = vi.hoisted(() => ({
  listWithUnanalyzedMentions: vi.fn(),
  analyzeMentionsMock: vi.fn(),
  getServiceDataSourceMock: vi.fn(),
  executeRulesMock: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getServiceDataSource: getServiceDataSourceMock,
}));

vi.mock("@/lib/analysis/analyze", () => ({
  analyzeMentions: analyzeMentionsMock,
}));

vi.mock("@/lib/rules/execute", () => ({
  executeRules: executeRulesMock,
}));

const FAKE_DATA_SOURCE = { kind: "demo" as const, organizations: { listWithUnanalyzedMentions } };

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("LIA_AI_MODE", "mock");
  vi.stubEnv("NODE_ENV", "test");

  listWithUnanalyzedMentions.mockReset();
  analyzeMentionsMock.mockReset();
  executeRulesMock.mockReset();
  getServiceDataSourceMock.mockReset();
  getServiceDataSourceMock.mockResolvedValue(FAKE_DATA_SOURCE);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

function authorizedRequest(): Request {
  return new Request("https://lia.test/api/cron/analyze-mentions", {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}` },
  });
}

function counts(
  overrides: Partial<{
    analyzed: number;
    heuristic: number;
    escalated: number;
    failed: number;
    remaining: number;
  }> = {},
) {
  return { analyzed: 0, heuristic: 0, escalated: 0, failed: 0, remaining: 0, ...overrides };
}

/** An analysis run that succeeded and handed `processed` pairs to execution. */
function analysisResult(
  processed: { mentionId: string; analysisId: string }[],
  countOverrides: Parameters<typeof counts>[0] = {},
) {
  return {
    analysisRunId: "run-1",
    status: "completed" as const,
    counts: counts({ analyzed: processed.length, ...countOverrides }),
    errorMessage: null,
    errorCode: null,
    processed,
  };
}

/**
 * A run that came back *normally* carrying an error code.
 *
 * `analyzeMentions` catches a failure outside the per-mention path — a
 * repository read, most likely — records it on the analysis run, and returns.
 * With nothing ever attempted, `counts.failed` stays 0 and the run's status
 * computes to `completed`: a total analysis outage that looks, to anything
 * reading `counts` alone, exactly like an organization with no backlog.
 */
function erroredRunResult(
  countOverrides: Parameters<typeof counts>[0] = {},
  processed: { mentionId: string; analysisId: string }[] = [],
) {
  return {
    analysisRunId: "run-outage",
    status: "completed" as const,
    counts: counts(countOverrides),
    errorMessage: "The mentions could not be read.",
    errorCode: "unavailable",
    processed,
  };
}

function sweepResult(overrides: Partial<ExecuteRulesResult> = {}): ExecuteRulesResult {
  return {
    sweepId: "sweep-1",
    claimed: true,
    counters: zeroSweepCounters(),
    mentionsSkipped: 0,
    budgetExhausted: false,
    ...overrides,
  };
}

function withCounters(overrides: Partial<SweepCounters>): SweepCounters {
  return { ...zeroSweepCounters(), ...overrides };
}

async function callRoute(): Promise<{ status: number; body: Record<string, unknown> }> {
  const { POST } = await import("@/app/api/cron/analyze-mentions/route");
  const response = await POST(authorizedRequest());
  return { status: response.status, body: await response.json() };
}

describe("analyze-mentions route: execution gating", () => {
  it("never claims a sweep when the mode is off", async () => {
    // Not "runs a sweep that does nothing" — off must cost zero calls, which
    // only a spy on the engine can pin.
    vi.stubEnv("RULES_EXECUTION_MODE", "off");
    vi.stubEnv("RULES_EXECUTION_ORG_ALLOWLIST", "org-a");
    listWithUnanalyzedMentions.mockResolvedValue(["org-a"]);
    analyzeMentionsMock.mockResolvedValue(
      analysisResult([{ mentionId: "m-1", analysisId: "a-1" }]),
    );

    const { status, body } = await callRoute();

    expect(executeRulesMock).not.toHaveBeenCalled();
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.execution).toEqual({
      mode: "off",
      reason: "mode_off",
      sweeps: [],
      organizationsAttempted: 0,
      organizationsCompleted: 0,
      organizationsNotAllowlisted: 0,
    });
    // The analysis half of the contract is unchanged, only relocated.
    expect(body.analysis).toEqual({
      organizations: 1,
      skipped: 0,
      analyzed: 1,
      heuristic: 0,
      escalated: 0,
      mentionsFailed: 0,
      erroredOrganizations: 0,
      analysisRunsWithErrors: 0,
    });
  });

  it("treats an unset mode as off", async () => {
    listWithUnanalyzedMentions.mockResolvedValue(["org-a"]);
    analyzeMentionsMock.mockResolvedValue(analysisResult([{ mentionId: "m-1", analysisId: "a-1" }]));

    const { body } = await callRoute();

    expect(executeRulesMock).not.toHaveBeenCalled();
    expect((body.execution as { mode: string }).mode).toBe("off");
  });

  it("runs no sweep for an organization outside the allowlist, and says so", async () => {
    vi.stubEnv("RULES_EXECUTION_MODE", "dry_run");
    vi.stubEnv("RULES_EXECUTION_ORG_ALLOWLIST", "org-allowed");
    listWithUnanalyzedMentions.mockResolvedValue(["org-blocked", "org-allowed"]);
    analyzeMentionsMock.mockImplementation(async (context: { scope: OrganizationScope }) =>
      analysisResult([{ mentionId: `m-${context.scope.organizationId}`, analysisId: "a-1" }]),
    );
    executeRulesMock.mockResolvedValue(sweepResult());

    const { status, body } = await callRoute();

    expect(executeRulesMock).toHaveBeenCalledTimes(1);
    const [context] = executeRulesMock.mock.calls[0] as [{ scope: OrganizationScope }];
    expect(context.scope.organizationId).toBe("org-allowed");
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.execution).toMatchObject({
      mode: "dry_run",
      organizationsAttempted: 1,
      organizationsCompleted: 1,
      organizationsNotAllowlisted: 1,
      reason: null,
    });
  });

  it("runs nothing with an active mode and an empty allowlist", async () => {
    vi.stubEnv("RULES_EXECUTION_MODE", "dry_run");
    listWithUnanalyzedMentions.mockResolvedValue(["org-a"]);
    analyzeMentionsMock.mockResolvedValue(analysisResult([{ mentionId: "m-1", analysisId: "a-1" }]));

    const { status, body } = await callRoute();

    expect(executeRulesMock).not.toHaveBeenCalled();
    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.execution).toEqual({
      mode: "dry_run",
      reason: "allowlist_empty",
      sweeps: [],
      organizationsAttempted: 0,
      organizationsCompleted: 0,
      organizationsNotAllowlisted: 0,
    });
  });

  it("states that no organization was due when the sweep found none", async () => {
    vi.stubEnv("RULES_EXECUTION_MODE", "dry_run");
    vi.stubEnv("RULES_EXECUTION_ORG_ALLOWLIST", "org-allowed");
    listWithUnanalyzedMentions.mockResolvedValue([]);

    const { status, body } = await callRoute();

    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.execution).toMatchObject({
      mode: "dry_run",
      reason: "no_organizations_due",
      organizationsAttempted: 0,
    });
  });

  it("blames the analysis half, not the allowlist, when no analysis reached execution", async () => {
    vi.stubEnv("RULES_EXECUTION_MODE", "dry_run");
    vi.stubEnv("RULES_EXECUTION_ORG_ALLOWLIST", "org-a");
    listWithUnanalyzedMentions.mockResolvedValue(["org-a"]);
    // A lock conflict: another process holds this organization's analysis, so
    // there is no analysis run for a sweep to follow. The organization was
    // allowlisted, and the reason must not claim otherwise.
    //
    // Imported here rather than at the top of the file on purpose: the
    // `vi.resetModules()` in `afterEach` gives each test a fresh module
    // registry, so a `DataError` captured at file load is a *different class*
    // from the one the route resolves, and the route's `instanceof` check
    // would miscount this conflict as an unexpected failure.
    const { DataError } = await import("@/lib/data/errors");
    analyzeMentionsMock.mockRejectedValue(
      new DataError("conflict", "An analysis is already running."),
    );

    const { status, body } = await callRoute();

    expect(status).toBe(200);
    expect(body.status).toBe("ok");
    expect(body.execution).toMatchObject({
      reason: "no_analysis_succeeded",
      organizationsAttempted: 0,
      organizationsNotAllowlisted: 0,
    });
  });
});

describe("analyze-mentions route: what the sweep is called with", () => {
  it("hands each organization its own scope and its own processed pairs", async () => {
    vi.stubEnv("RULES_EXECUTION_MODE", "dry_run");
    vi.stubEnv("RULES_EXECUTION_ORG_ALLOWLIST", "org-a, org-b");
    listWithUnanalyzedMentions.mockResolvedValue(["org-a", "org-b"]);
    analyzeMentionsMock.mockImplementation(async (context: { scope: OrganizationScope }) =>
      analysisResult([
        { mentionId: `m-${context.scope.organizationId}`, analysisId: `a-${context.scope.organizationId}` },
      ]),
    );
    executeRulesMock.mockImplementation(async (context: { scope: OrganizationScope }) =>
      sweepResult({ sweepId: `sweep-${context.scope.organizationId}` }),
    );

    const { body } = await callRoute();

    expect(executeRulesMock).toHaveBeenCalledTimes(2);
    const calls = executeRulesMock.mock.calls as [
      { dataSource: unknown; scope: OrganizationScope },
      { mode: string; processed: { mentionId: string; analysisId: string }[] },
    ][];

    for (const [context, input] of calls) {
      const organizationId = context.scope.organizationId;
      expect(["org-a", "org-b"]).toContain(organizationId);
      // D88: the sweep's scope is the organization's own, never ambient.
      expect(context.scope.userId).toBe("00000000-0000-0000-0000-000000000000");
      expect(context.scope.role).toBe("owner");
      expect(context.dataSource).toBe(FAKE_DATA_SOURCE);
      expect(input.mode).toBe("dry_run");
      // The pairs are this organization's, not the previous organization's.
      expect(input.processed).toEqual([
        { mentionId: `m-${organizationId}`, analysisId: `a-${organizationId}` },
      ]);
    }

    expect(body.execution).toMatchObject({
      sweeps: [
        {
          organizationId: "org-a",
          sweepId: "sweep-org-a",
          status: "completed",
          claimed: true,
          counters: zeroSweepCounters(),
          mentionsSkipped: 0,
          budgetExhausted: false,
        },
        {
          organizationId: "org-b",
          sweepId: "sweep-org-b",
          status: "completed",
          claimed: true,
          counters: zeroSweepCounters(),
          mentionsSkipped: 0,
          budgetExhausted: false,
        },
      ],
    });
  });

  it("never runs a sweep for an organization whose analysis threw", async () => {
    vi.stubEnv("RULES_EXECUTION_MODE", "dry_run");
    vi.stubEnv("RULES_EXECUTION_ORG_ALLOWLIST", "org-broken, org-fine");
    listWithUnanalyzedMentions.mockResolvedValue(["org-broken", "org-fine"]);
    analyzeMentionsMock.mockImplementation(async (context: { scope: OrganizationScope }) => {
      if (context.scope.organizationId === "org-broken") throw new Error(LEAK_MARKER);
      return analysisResult([{ mentionId: "m-1", analysisId: "a-1" }]);
    });
    executeRulesMock.mockResolvedValue(sweepResult());

    const { body } = await callRoute();

    expect(executeRulesMock).toHaveBeenCalledTimes(1);
    const [context] = executeRulesMock.mock.calls[0] as [{ scope: OrganizationScope }];
    expect(context.scope.organizationId).toBe("org-fine");
    // One organization's analysis failed while another's whole pipeline ran.
    expect(body.status).toBe("degraded");
  });

  it("reports a refused claim as a sweep that was not claimed", async () => {
    vi.stubEnv("RULES_EXECUTION_MODE", "dry_run");
    vi.stubEnv("RULES_EXECUTION_ORG_ALLOWLIST", "org-a");
    listWithUnanalyzedMentions.mockResolvedValue(["org-a"]);
    analyzeMentionsMock.mockResolvedValue(analysisResult([{ mentionId: "m-1", analysisId: "a-1" }]));
    executeRulesMock.mockResolvedValue(
      sweepResult({ sweepId: null, claimed: false }),
    );

    const { status, body } = await callRoute();

    expect(status).toBe(200);
    // A refused claim is another scheduler already sweeping this organization,
    // or nothing to sweep — normal operation, not a failure.
    expect(body.status).toBe("ok");
    expect(body.execution).toMatchObject({
      organizationsAttempted: 1,
      organizationsCompleted: 1,
      sweeps: [{ organizationId: "org-a", sweepId: null, claimed: false, status: "not_claimed" }],
    });
  });
});

describe("analyze-mentions route: status table (spec §10)", () => {
  it("returns 401 for a bad secret, before anything else runs", async () => {
    vi.stubEnv("RULES_EXECUTION_MODE", "dry_run");
    vi.stubEnv("RULES_EXECUTION_ORG_ALLOWLIST", "org-a");
    const { POST } = await import("@/app/api/cron/analyze-mentions/route");

    const response = await POST(
      new Request("https://lia.test/api/cron/analyze-mentions", {
        method: "POST",
        headers: { authorization: "Bearer wrong-secret-entirely" },
      }),
    );

    expect(response.status).toBe(401);
    expect(executeRulesMock).not.toHaveBeenCalled();
    expect(getServiceDataSourceMock).not.toHaveBeenCalled();
  });

  it("is ok at 200 when everything attempted completed", async () => {
    vi.stubEnv("RULES_EXECUTION_MODE", "dry_run");
    vi.stubEnv("RULES_EXECUTION_ORG_ALLOWLIST", "org-a");
    listWithUnanalyzedMentions.mockResolvedValue(["org-a"]);
    analyzeMentionsMock.mockResolvedValue(analysisResult([{ mentionId: "m-1", analysisId: "a-1" }]));
    // Blocked and no-op actions are normal operation, not degradation.
    executeRulesMock.mockResolvedValue(
      sweepResult({
        counters: withCounters({ mentionsEvaluated: 1, rulesMatched: 1, actionsApplied: 1, actionsBlocked: 2 }),
      }),
    );

    const { status, body } = await callRoute();

    expect(status).toBe(200);
    expect(body.status).toBe("ok");
  });

  it("is degraded at 200 when analysis failed a mention but the sweep was clean", async () => {
    // F8: an analysis-only failure used to report a flat `ok`. It does not now.
    listWithUnanalyzedMentions.mockResolvedValue(["org-a"]);
    analyzeMentionsMock.mockResolvedValue(analysisResult([{ mentionId: "m-1", analysisId: "a-1" }], { failed: 2 }));

    const { status, body } = await callRoute();

    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.analysis).toMatchObject({ organizations: 1, mentionsFailed: 2 });
  });

  it("is degraded at 200 when one analysis run returned an error code", async () => {
    // The run did not throw, so `erroredOrganizations` stays 0, and it failed
    // no individual mention, so `mentionsFailed` stays 0 too. Reading counts
    // alone this is a clean sweep; it is not one.
    listWithUnanalyzedMentions.mockResolvedValue(["org-good", "org-outage"]);
    analyzeMentionsMock.mockImplementation(async (context: { scope: OrganizationScope }) =>
      context.scope.organizationId === "org-outage"
        ? erroredRunResult()
        : analysisResult([{ mentionId: "m-1", analysisId: "a-1" }]),
    );

    const { status, body } = await callRoute();

    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.analysis).toMatchObject({
      organizations: 2,
      erroredOrganizations: 0,
      mentionsFailed: 0,
      analysisRunsWithErrors: 1,
    });
  });

  it("is failed at 503 when every analysis run returned an error code and got nothing through", async () => {
    // A returned failure is still a failure: two organizations, both analysed
    // nothing, both carrying an error code. Nothing succeeded.
    listWithUnanalyzedMentions.mockResolvedValue(["org-a", "org-b"]);
    analyzeMentionsMock.mockResolvedValue(erroredRunResult());

    const { status, body } = await callRoute();

    expect(status).toBe(503);
    expect(body.status).toBe("failed");
    expect(body.analysis).toMatchObject({
      organizations: 2,
      analysisRunsWithErrors: 2,
    });
  });

  it("is degraded, not failed, when an erroring run still got mentions through", async () => {
    // A partial run — some mentions analysed, then a read failed — succeeded
    // at something, so it must not count toward the all-failed 503 clause even
    // when it is the only organization in the sweep.
    listWithUnanalyzedMentions.mockResolvedValue(["org-partial"]);
    analyzeMentionsMock.mockResolvedValue(
      erroredRunResult({ analyzed: 1, remaining: 4 }, [{ mentionId: "m-1", analysisId: "a-1" }]),
    );

    const { status, body } = await callRoute();

    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
  });

  it("counts a heuristic-only run that errored as progress", async () => {
    // The mention was classified and a row written; no model was involved.
    // That is progress, and the sweep is degraded rather than failed.
    listWithUnanalyzedMentions.mockResolvedValue(["org-heuristic"]);
    analyzeMentionsMock.mockResolvedValue(erroredRunResult({ heuristic: 2 }));

    const { status, body } = await callRoute();

    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
  });

  it("is degraded at 200 when a sweep failed actions", async () => {
    vi.stubEnv("RULES_EXECUTION_MODE", "dry_run");
    vi.stubEnv("RULES_EXECUTION_ORG_ALLOWLIST", "org-a");
    listWithUnanalyzedMentions.mockResolvedValue(["org-a"]);
    analyzeMentionsMock.mockResolvedValue(analysisResult([{ mentionId: "m-1", analysisId: "a-1" }]));
    executeRulesMock.mockResolvedValue(
      sweepResult({ counters: withCounters({ mentionsEvaluated: 1, rulesMatched: 1, actionsFailed: 1, terminalFailures: 1 }) }),
    );

    const { status, body } = await callRoute();

    expect(status).toBe(200);
    expect(body.status).toBe("degraded");
  });

  it("stays ok when a sweep only left work behind for the next run", async () => {
    // Budget exhaustion and skipped mentions are the engine reporting honestly
    // that it stopped at its caps — the run did what it was configured to do.
    vi.stubEnv("RULES_EXECUTION_MODE", "dry_run");
    vi.stubEnv("RULES_EXECUTION_ORG_ALLOWLIST", "org-a");
    listWithUnanalyzedMentions.mockResolvedValue(["org-a"]);
    analyzeMentionsMock.mockResolvedValue(analysisResult([{ mentionId: "m-1", analysisId: "a-1" }]));
    executeRulesMock.mockResolvedValue(
      sweepResult({ mentionsSkipped: 5, budgetExhausted: true, counters: withCounters({ actionsSkipped: 3 }) }),
    );

    const { status, body } = await callRoute();

    expect(status).toBe(200);
    expect(body.status).toBe("ok");
  });

  it("is failed at 503 when every attempted organization errored in analysis", async () => {
    listWithUnanalyzedMentions.mockResolvedValue(["org-a", "org-b"]);
    analyzeMentionsMock.mockRejectedValue(new Error(LEAK_MARKER));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { POST } = await import("@/app/api/cron/analyze-mentions/route");
    const response = await POST(authorizedRequest());
    const text = await response.text();

    expect(response.status).toBe(503);
    expect(JSON.parse(text).status).toBe("failed");
    expect(text).not.toContain(LEAK_MARKER);
    for (const call of consoleSpy.mock.calls) {
      for (const arg of call) expect(String(arg)).not.toContain(LEAK_MARKER);
    }
    consoleSpy.mockRestore();
  });

  it("is failed at 503 when every execution sweep threw", async () => {
    vi.stubEnv("RULES_EXECUTION_MODE", "dry_run");
    vi.stubEnv("RULES_EXECUTION_ORG_ALLOWLIST", "org-a, org-b");
    listWithUnanalyzedMentions.mockResolvedValue(["org-a", "org-b"]);
    analyzeMentionsMock.mockResolvedValue(analysisResult([{ mentionId: "m-1", analysisId: "a-1" }]));
    executeRulesMock.mockRejectedValue(new Error(LEAK_MARKER));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { POST } = await import("@/app/api/cron/analyze-mentions/route");
    const response = await POST(authorizedRequest());
    const text = await response.text();
    const body = JSON.parse(text);

    expect(response.status).toBe(503);
    expect(body.status).toBe("failed");
    expect(body.execution.organizationsAttempted).toBe(2);
    expect(body.execution.organizationsCompleted).toBe(0);
    expect(text).not.toContain(LEAK_MARKER);
    // Both swallowed throws are logged — a sweep that throws before its row is
    // written exists nowhere else — and both logs carry the error's *name*
    // only, never the message the marker is hiding in.
    expect(consoleSpy).toHaveBeenCalledTimes(2);
    for (const call of consoleSpy.mock.calls) {
      expect(call).toEqual([
        "[cron:analyze-mentions] sweep failed",
        expect.stringMatching(/^org-[ab]$/),
        "Error",
      ]);
      for (const arg of call) expect(String(arg)).not.toContain(LEAK_MARKER);
    }
    consoleSpy.mockRestore();
  });

  it("is failed at 500 with no detail when organization enumeration threw", async () => {
    listWithUnanalyzedMentions.mockRejectedValue(new Error(LEAK_MARKER));
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { POST } = await import("@/app/api/cron/analyze-mentions/route");
    const response = await POST(authorizedRequest());
    const text = await response.text();

    expect(response.status).toBe(500);
    expect(JSON.parse(text).status).toBe("failed");
    expect(text).not.toContain(LEAK_MARKER);
    expect(text).not.toContain(SECRET);
    for (const call of consoleSpy.mock.calls) {
      for (const arg of call) expect(String(arg)).not.toContain(LEAK_MARKER);
    }
    consoleSpy.mockRestore();
  });
});

describe("analyze-mentions route: per-organization execution isolation", () => {
  it("keeps sweeping after one organization's sweep throws", async () => {
    vi.stubEnv("RULES_EXECUTION_MODE", "dry_run");
    vi.stubEnv("RULES_EXECUTION_ORG_ALLOWLIST", "org-broken, org-fine");
    listWithUnanalyzedMentions.mockResolvedValue(["org-broken", "org-fine"]);
    analyzeMentionsMock.mockImplementation(async (context: { scope: OrganizationScope }) =>
      analysisResult([
        { mentionId: `m-${context.scope.organizationId}`, analysisId: "a-1" },
        { mentionId: `m2-${context.scope.organizationId}`, analysisId: "a-2" },
      ]),
    );
    executeRulesMock.mockImplementation(async (context: { scope: OrganizationScope }) => {
      if (context.scope.organizationId === "org-broken") throw new Error(LEAK_MARKER);
      return sweepResult({ sweepId: "sweep-fine", counters: withCounters({ mentionsEvaluated: 2 }) });
    });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const { POST } = await import("@/app/api/cron/analyze-mentions/route");
    const response = await POST(authorizedRequest());
    const text = await response.text();
    const body = JSON.parse(text);

    // The second organization's sweep ran; the first one's throw cost only it.
    expect(executeRulesMock).toHaveBeenCalledTimes(2);
    expect(response.status).toBe(200);
    expect(body.status).toBe("degraded");
    expect(body.execution.organizationsAttempted).toBe(2);
    expect(body.execution.organizationsCompleted).toBe(1);
    expect(body.execution.sweeps).toEqual([
      {
        organizationId: "org-broken",
        sweepId: null,
        status: "failed",
        claimed: false,
        counters: zeroSweepCounters(),
        // Nothing came back from the throw, so every pair handed over is
        // reported unreached rather than claiming progress no one can verify.
        mentionsSkipped: 2,
        budgetExhausted: false,
      },
      {
        organizationId: "org-fine",
        sweepId: "sweep-fine",
        status: "completed",
        claimed: true,
        counters: withCounters({ mentionsEvaluated: 2 }),
        mentionsSkipped: 0,
        budgetExhausted: false,
      },
    ]);
    expect(text).not.toContain(LEAK_MARKER);
    // Named, and named only: the failing organization is identified (the
    // response already names it) and the error's name given, with no message
    // and no stack.
    expect(consoleSpy).toHaveBeenCalledWith(
      "[cron:analyze-mentions] sweep failed",
      "org-broken",
      "Error",
    );
    for (const call of consoleSpy.mock.calls) {
      for (const arg of call) expect(String(arg)).not.toContain(LEAK_MARKER);
    }
    consoleSpy.mockRestore();
  });
});
