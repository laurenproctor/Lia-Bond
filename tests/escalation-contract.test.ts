import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import { freshDataSource, ushg } from "./helpers/scope";
import { demoStore } from "@/lib/data/demo/store";
import { createSupabaseDataSource } from "@/lib/data/supabase";
import { DataError } from "@/lib/data/errors";

/**
 * The Supabase adapter's occurrence entry points route through the
 * service-role client (Task 10), the same way `auditEvents.record` does — see
 * `tests/audit-events-service-write.test.ts`'s doc comment for why. Mocked
 * here, at module scope, so the tests below can hand it a stub that records
 * the exact RPC payload without touching a real database.
 */
const { createSupabaseServiceClient } = vi.hoisted(() => ({
  createSupabaseServiceClient: vi.fn(),
}));

vi.mock("@/lib/supabase/server", () => ({
  createSupabaseServiceClient,
}));
import type {
  CreateMentionAnalysisInput,
  Escalation,
  MentionStatus,
} from "@/domain";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";

/**
 * The escalation contract, in TypeScript.
 *
 * The mirror of `20260812000300_escalation_contract.sql`: the demo adapter's
 * internal `raiseEscalation` is the in-memory twin of the SQL `raise_escalation`
 * ladder — provenance → replay → dismissed → open dedupe → awaiting_retriage →
 * create — and `recordAnalysisOccurrence`/`applyAnalysisOccurrence` are the twins
 * of the two entry-point functions. So these tests are driven through the entry
 * points, never through a bare create, because that is the caller graph the
 * database enforces by grant: analysis → `applyAnalysisOccurrence`; automation →
 * `executeUnit`; both reach the ladder internally; nothing else can.
 *
 * The one exception is the ladder's *return contract* (which row comes back for
 * which reason), asserted through the demo adapter's `escalations.create` — the
 * demo has no privilege system, so that method is the mirror's seam rather than
 * a production path. Its Supabase counterpart refuses outright, which is
 * asserted at the bottom of this file.
 */

let ds: LiaDataSource;
let scope: OrganizationScope;
/** Analysed, low risk, no escalation, no analysis row — a clean subject. */
let subject: string;
/** Still `new`, so the non-escalation status derivation has somewhere to go. */
let untouched: string;

const CLASSIFICATION: Omit<
  CreateMentionAnalysisInput,
  "mentionId" | "analysisRunId" | "analyzedAt"
> = {
  modelProvider: "lia",
  modelName: "rating-heuristic",
  promptVersion: "test-1",
  relevanceScore: 0.8,
  relevanceExplanation: null,
  sentiment: "negative",
  sentimentScore: -0.5,
  riskLevel: "high",
  riskCategories: [],
  riskExplanation: null,
  topics: [],
  factsNeedingVerification: [],
  recommendedAction: "escalate",
  recommendationExplanation: null,
};

async function record(
  mentionId: string,
  analysisRunId: string,
  overrides: Partial<CreateMentionAnalysisInput> = {},
) {
  return ds.mentions.recordAnalysisOccurrence(scope, {
    ...CLASSIFICATION,
    mentionId,
    analysisRunId,
    analyzedAt: new Date().toISOString(),
    ...overrides,
  });
}

async function apply(
  mentionId: string,
  analysisId: string,
  shouldEscalate: boolean,
  overrides: { sentiment?: "positive" | "neutral" | "negative" | "mixed" } = {},
) {
  return ds.mentions.applyAnalysisOccurrence(scope, {
    mentionId,
    analysisId,
    shouldEscalate,
    category: "other",
    severity: "high",
    title: "Escalated by analysis",
    summary: null,
    sentiment: overrides.sentiment ?? "negative",
    riskLevel: "high",
    relevanceScore: 0.8,
  });
}

function escalationsFor(mentionId: string): Escalation[] {
  return demoStore().escalations.filter((row) => row.mentionId === mentionId);
}

async function statusOf(mentionId: string): Promise<MentionStatus> {
  const mention = await ds.mentions.get(scope, mentionId);
  if (!mention) throw new Error(`Mention ${mentionId} not found`);
  return mention.status;
}

/** An active rule whose only action escalates — the automation entry point. */
async function escalatingRule(): Promise<{ id: string; revision: number }> {
  const draft = await ds.automationRules.create(scope, {
    name: "Escalate on risk",
    description: null,
    priority: 100,
    conditions: [{ field: "risk_level", operator: "at_least", value: "high" }],
    actions: [{ type: "escalate", assigneeUserId: null }],
  });
  await ds.automationRules.recordSimulation(scope, draft.id, draft.revision);
  const active = await ds.automationRules.setEnabled(scope, draft.id, true);
  return { id: active.id, revision: active.revision };
}

async function executeEscalateUnit(mentionId: string, analysisId: string) {
  const rule = await escalatingRule();
  const sweep = await ds.automationSweeps.claim(scope, { mode: "apply" });
  return ds.automationRuleExecutions.executeUnit(scope, {
    sweepId: sweep.sweep.id,
    automationRuleId: rule.id,
    ruleRevision: rule.revision,
    mentionId,
    triggerAnalysisId: analysisId,
  });
}

beforeEach(async () => {
  ds = freshDataSource();
  scope = ushg.admin();

  const store = demoStore();
  const escalated = new Set(store.escalations.map((row) => row.mentionId));
  const analysed = new Set(store.mentionAnalyses.map((row) => row.mentionId));
  const mentions = await ds.mentions.list(scope);

  const clean = mentions.find(
    (row) =>
      row.status === "analyzed" && !escalated.has(row.id) && !analysed.has(row.id),
  );
  if (!clean) throw new Error("Expected a seeded analysed mention with no case");
  subject = clean.id;

  const fresh = mentions.find((row) => row.status === "new" && !escalated.has(row.id));
  if (!fresh) throw new Error("Expected a seeded `new` mention");
  untouched = fresh.id;
});

/* -------------------------------------------------------------------------- */
/* The ladder, through the analysis entry point                                */
/* -------------------------------------------------------------------------- */

describe("applyAnalysisOccurrence: the escalation ladder", () => {
  it("A — a resolved case leaves the mention escalated, and a new occurrence is refused", async () => {
    const o1 = await record(subject, crypto.randomUUID());
    const first = await apply(subject, o1.analysis.id, true);

    expect(first).toMatchObject({
      escalationCreated: true,
      reason: null,
      alreadyApplied: false,
      finalStatus: "escalated",
    });
    expect(first.escalationId).not.toBeNull();

    await ds.escalations.updateStatus(
      scope,
      first.escalationId!,
      "resolved",
      "Spoke to the guest.",
    );
    // Resolving the case does not re-triage the mention: that is a human
    // decision, and until somebody makes it the mention is still escalated.
    expect(await statusOf(subject)).toBe("escalated");

    const o2 = await record(subject, crypto.randomUUID());
    const second = await apply(subject, o2.analysis.id, true);

    expect(second).toMatchObject({
      escalationId: null,
      escalationCreated: false,
      reason: "awaiting_retriage",
      alreadyApplied: false,
      // Preserved, not rewritten: `escalated` is where the human left it.
      finalStatus: "escalated",
    });
    expect(escalationsFor(subject)).toHaveLength(1);
  });

  it("B — replaying a completed occurrence has no effects at all", async () => {
    const o1 = await record(subject, crypto.randomUUID());
    const first = await apply(subject, o1.analysis.id, true);
    await ds.escalations.updateStatus(
      scope,
      first.escalationId!,
      "resolved",
      "Spoke to the guest.",
    );
    await ds.mentions.updateStatus(scope, subject, "monitoring");

    const before = JSON.stringify({
      mentions: demoStore().mentions,
      escalations: demoStore().escalations,
      analyses: demoStore().mentionAnalyses,
    });

    // Deliberately a different classification from the first application: a
    // replay that wrote anything at all would show up as this sentiment.
    const replay = await apply(subject, o1.analysis.id, true, {
      sentiment: "positive",
    });

    expect(replay).toMatchObject({
      escalationId: null,
      escalationCreated: false,
      reason: null,
      alreadyApplied: true,
      finalStatus: "monitoring",
    });
    expect(
      JSON.stringify({
        mentions: demoStore().mentions,
        escalations: demoStore().escalations,
        analyses: demoStore().mentionAnalyses,
      }),
    ).toBe(before);
  });

  it("B — the raw replay path through automation returns the historical case", async () => {
    const o1 = await record(subject, crypto.randomUUID());
    const first = await apply(subject, o1.analysis.id, true);
    await ds.escalations.updateStatus(
      scope,
      first.escalationId!,
      "resolved",
      "Spoke to the guest.",
    );
    await ds.mentions.updateStatus(scope, subject, "monitoring");

    const row = await executeEscalateUnit(subject, o1.analysis.id);

    // `occurrence_replayed` mapped into the pinned public vocabulary.
    expect(row.status).toBe("no_op");
    expect(row.outcomes[0]).toMatchObject({
      type: "escalate",
      outcome: "no_op",
      code: "escalation_exists",
    });
    expect(escalationsFor(subject)).toHaveLength(1);
    expect(escalationsFor(subject)[0]).toMatchObject({
      id: first.escalationId,
      status: "resolved",
      triggerAnalysisId: o1.analysis.id,
    });
    expect(await statusOf(subject)).toBe("monitoring");
  });

  it("C — a re-triaged mention escalates again on a new occurrence", async () => {
    const o1 = await record(subject, crypto.randomUUID());
    const first = await apply(subject, o1.analysis.id, true);
    await ds.escalations.updateStatus(
      scope,
      first.escalationId!,
      "resolved",
      "Spoke to the guest.",
    );
    await ds.mentions.updateStatus(scope, subject, "monitoring");

    const o2 = await record(subject, crypto.randomUUID());
    const second = await apply(subject, o2.analysis.id, true);

    expect(second).toMatchObject({
      escalationCreated: true,
      reason: null,
      finalStatus: "escalated",
    });
    expect(second.escalationId).not.toBe(first.escalationId);

    const rows = escalationsFor(subject);
    expect(rows).toHaveLength(2);
    expect(rows.filter((row) => row.status === "open")).toHaveLength(1);
    expect(await statusOf(subject)).toBe("escalated");
  });

  it("D — a dismissed mention refuses an unused occurrence", async () => {
    const o1 = await record(subject, crypto.randomUUID());
    await apply(subject, o1.analysis.id, true);
    await ds.mentions.updateStatus(scope, subject, "dismissed");

    const o2 = await record(subject, crypto.randomUUID());
    const refused = await apply(subject, o2.analysis.id, true);

    expect(refused).toMatchObject({
      escalationId: null,
      escalationCreated: false,
      reason: "mention_dismissed",
      alreadyApplied: false,
      finalStatus: "dismissed",
    });
    // The case raised before the dismissal is still there; no second one.
    expect(escalationsFor(subject)).toHaveLength(1);
  });

  it("D2 — a consumed occurrence replays on a dismissed mention without touching it", async () => {
    const o1 = await record(subject, crypto.randomUUID());
    const first = await apply(subject, o1.analysis.id, true);
    await ds.escalations.updateStatus(
      scope,
      first.escalationId!,
      "resolved",
      "Spoke to the guest.",
    );
    await ds.mentions.updateStatus(scope, subject, "dismissed");

    // Ladder level: replay is checked BEFORE the dismissed refusal, so a
    // consumed occurrence reports its history rather than being refused —
    // and reports it without mutating anything.
    const replayed = await ds.escalations.create(scope, {
      mentionId: subject,
      category: "other",
      severity: "high",
      title: "Escalated by analysis",
      summary: null,
      dueAt: null,
      triggerAnalysisId: o1.analysis.id,
    });

    expect(replayed).toMatchObject({ created: false, reason: "occurrence_replayed" });
    expect(replayed.escalation?.id).toBe(first.escalationId);
    expect(replayed.escalation?.status).toBe("resolved");
    expect(await statusOf(subject)).toBe("dismissed");

    // Automation entry point: the transition matrix refuses before the ladder
    // is consulted at all (spec §7 — automation never reopens a dismissed
    // mention), so the outcome is the matrix's, not the ladder's. Either way
    // no case is created and the dismissal stands.
    const row = await executeEscalateUnit(subject, o1.analysis.id);
    expect(row.outcomes[0]).toMatchObject({
      type: "escalate",
      outcome: "blocked",
      code: "forbidden_transition",
    });
    expect(escalationsFor(subject)).toHaveLength(1);
    expect(await statusOf(subject)).toBe("dismissed");
  });

  it("preserves a dismissal when a replayed occurrence is applied", async () => {
    // The reachable route to the replay arm of `applyAnalysisOccurrence`:
    // automation raises a case off an occurrence the pipeline has not applied
    // yet, a person dismisses the mention, and only then does the pipeline get
    // to that occurrence. The occurrence is not a replay of itself — it has
    // never been applied — but its *escalation* already exists, and reporting
    // that history must not undo the dismissal.
    const o1 = await record(subject, crypto.randomUUID());
    const unit = await executeEscalateUnit(subject, o1.analysis.id);
    expect(unit.outcomes[0]).toMatchObject({ outcome: "applied" });
    expect(await statusOf(subject)).toBe("escalated");

    await ds.mentions.updateStatus(scope, subject, "dismissed");

    const applied = await apply(subject, o1.analysis.id, true);

    expect(applied).toMatchObject({
      escalationCreated: false,
      reason: "occurrence_replayed",
      alreadyApplied: false,
      // Preserved, not derived from the escalation result: a replay reports
      // history and never mutates state.
      finalStatus: "dismissed",
    });
    expect(applied.escalationId).toBe(escalationsFor(subject)[0]?.id);
    expect(escalationsFor(subject)).toHaveLength(1);
    expect(await statusOf(subject)).toBe("dismissed");

    // The occurrence is still completed by the application: it has done all it
    // will ever do, and leaving it pending would have recovery re-pick it.
    const stored = await ds.mentions.latestAnalysis(scope, subject);
    expect(stored?.outcomeAppliedAt).not.toBeNull();
  });

  it("shows the open case on the mention detail, not an older resolved one", async () => {
    const o1 = await record(subject, crypto.randomUUID());
    const first = await apply(subject, o1.analysis.id, true);
    await ds.escalations.updateStatus(
      scope,
      first.escalationId!,
      "resolved",
      "Spoke to the guest.",
    );
    await ds.mentions.updateStatus(scope, subject, "monitoring");

    const o2 = await record(subject, crypto.randomUUID());
    const second = await apply(subject, o2.analysis.id, true);

    const rows = escalationsFor(subject);
    expect(rows).toHaveLength(2);
    // The demo clock is frozen, so both cases carry the same `createdAt`:
    // ordering by recency alone ties, and a tie broken by insertion order
    // would put the resolved case on the panel of an escalated mention.
    expect(rows[0]?.createdAt).toBe(rows[1]?.createdAt);

    const detail = await ds.mentions.getDetail(scope, subject);
    expect(detail?.escalation?.id).toBe(second.escalationId);
    expect(detail?.escalation?.status).toBe("open");
  });

  it("returns the open case for escalation_exists and nothing for a hard refusal", async () => {
    const o1 = await record(subject, crypto.randomUUID());
    const first = await apply(subject, o1.analysis.id, true);
    await ds.mentions.updateStatus(scope, subject, "monitoring");

    // A different occurrence, open case still standing: the open row comes back.
    const o2 = await record(subject, crypto.randomUUID());
    const deduped = await ds.escalations.create(scope, {
      mentionId: subject,
      category: "other",
      severity: "high",
      title: "Escalated by analysis",
      summary: null,
      dueAt: null,
      triggerAnalysisId: o2.analysis.id,
    });

    expect(deduped).toMatchObject({ created: false, reason: "escalation_exists" });
    expect(deduped.escalation?.id).toBe(first.escalationId);

    // Hard refusal: no row at all, rather than somebody else's.
    await ds.mentions.updateStatus(scope, subject, "dismissed");
    const refused = await ds.escalations.create(scope, {
      mentionId: subject,
      category: "other",
      severity: "high",
      title: "Escalated by analysis",
      summary: null,
      dueAt: null,
      triggerAnalysisId: o2.analysis.id,
    });
    expect(refused).toMatchObject({
      escalation: null,
      created: false,
      reason: "mention_dismissed",
    });
  });
});

/* -------------------------------------------------------------------------- */
/* Status derivation                                                           */
/* -------------------------------------------------------------------------- */

describe("applyAnalysisOccurrence: the database owns the final status", () => {
  it("moves a new mention to analyzed", async () => {
    const occurrence = await record(untouched, crypto.randomUUID());
    const result = await apply(untouched, occurrence.analysis.id, false);

    expect(result).toMatchObject({
      escalationId: null,
      escalationCreated: false,
      reason: null,
      alreadyApplied: false,
      finalStatus: "analyzed",
    });

    const mention = await ds.mentions.get(scope, untouched);
    expect(mention?.sentiment).toBe("negative");
    expect(mention?.riskLevel).toBe("high");
    expect(mention?.relevanceScore).toBe(0.8);
  });

  it("preserves a status a person set between recording and application", async () => {
    const occurrence = await record(untouched, crypto.randomUUID());
    await ds.mentions.updateStatus(scope, untouched, "responded");

    const result = await apply(untouched, occurrence.analysis.id, false, {
      sentiment: "mixed",
    });

    expect(result.finalStatus).toBe("responded");
    const mention = await ds.mentions.get(scope, untouched);
    // The scores still land — they are the analysis's own fields.
    expect(mention?.sentiment).toBe("mixed");
    expect(mention?.riskLevel).toBe("high");
    expect(mention?.status).toBe("responded");
  });

  it("preserves a dismissal", async () => {
    const occurrence = await record(untouched, crypto.randomUUID());
    await ds.mentions.updateStatus(scope, untouched, "dismissed");

    const result = await apply(untouched, occurrence.analysis.id, false);

    expect(result.finalStatus).toBe("dismissed");
    expect(await statusOf(untouched)).toBe("dismissed");
  });
});

/* -------------------------------------------------------------------------- */
/* Event identity                                                              */
/* -------------------------------------------------------------------------- */

describe("recordAnalysisOccurrence: one durable occurrence per event", () => {
  it("returns the same occurrence for the same run and mention", async () => {
    const runId = crypto.randomUUID();
    const first = await record(subject, runId);
    const second = await record(subject, runId, { sentiment: "positive" });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.analysis.id).toBe(first.analysis.id);
    // The late recorder's output is discarded, not merged.
    expect(second.analysis.sentiment).toBe("negative");
  });

  it("returns the same occurrence to a recorder arriving after completion", async () => {
    const runId = crypto.randomUUID();
    const first = await record(subject, runId);
    await apply(subject, first.analysis.id, false);

    const late = await record(subject, runId);

    expect(late.created).toBe(false);
    expect(late.analysis.id).toBe(first.analysis.id);
    expect(late.analysis.outcomeAppliedAt).not.toBeNull();
  });

  it("records a new occurrence for a later run once the first completed", async () => {
    const first = await record(subject, crypto.randomUUID());
    await apply(subject, first.analysis.id, false);

    const next = await record(subject, crypto.randomUUID());

    expect(next.created).toBe(true);
    expect(next.analysis.id).not.toBe(first.analysis.id);
    expect(next.analysis.outcomeAppliedAt).toBeNull();
  });

  it("hands a later run the occurrence still pending for the mention", async () => {
    const pending = await record(subject, crypto.randomUUID());
    const later = await record(subject, crypto.randomUUID());

    // One pending occurrence per mention: recovery always has exactly one
    // thing to finish, so the new event's output is discarded and this sweep
    // completes the older event first.
    expect(later.created).toBe(false);
    expect(later.analysis.id).toBe(pending.analysis.id);
  });

  it("refuses an occurrence with no run id", async () => {
    await expect(
      record(subject, null as unknown as string),
    ).rejects.toThrow();
    await expect(
      ds.mentions.recordAnalysisOccurrence(scope, {
        ...CLASSIFICATION,
        mentionId: subject,
        analyzedAt: new Date().toISOString(),
      } as unknown as CreateMentionAnalysisInput),
    ).rejects.toThrow();
  });
});

/* -------------------------------------------------------------------------- */
/* Provenance                                                                  */
/* -------------------------------------------------------------------------- */

describe("provenance", () => {
  it("refuses to apply an occurrence belonging to another mention", async () => {
    const occurrence = await record(subject, crypto.randomUUID());

    await expect(apply(untouched, occurrence.analysis.id, true)).rejects.toMatchObject({
      code: "not_found",
    });
  });

  it("refuses to raise a case on another mention's occurrence", async () => {
    const occurrence = await record(subject, crypto.randomUUID());

    await expect(
      ds.escalations.create(scope, {
        mentionId: untouched,
        category: "other",
        severity: "high",
        title: "Escalated by analysis",
        summary: null,
        dueAt: null,
        triggerAnalysisId: occurrence.analysis.id,
      }),
    ).rejects.toBeInstanceOf(DataError);
    expect(escalationsFor(untouched)).toHaveLength(0);
  });
});

/* -------------------------------------------------------------------------- */
/* The Supabase adapter's closed surfaces                                      */
/* -------------------------------------------------------------------------- */

describe("the Supabase adapter", () => {
  /** No call should reach it: every method under test refuses before any I/O. */
  const unusableClient = {
    from() {
      throw new Error("The adapter must refuse before touching the database.");
    },
  } as unknown as SupabaseClient;

  const supabaseScope: OrganizationScope = {
    organizationId: crypto.randomUUID(),
    userId: crypto.randomUUID(),
    role: "admin",
  };

  /** A chainable stand-in for a PostgREST query builder that reads one row. */
  interface FakeQueryChain {
    select: (columns?: string) => FakeQueryChain;
    eq: (column: string, value: unknown) => FakeQueryChain;
    maybeSingle: () => Promise<{ data: unknown; error: unknown }>;
    single: () => Promise<{ data: unknown; error: unknown }>;
  }

  /**
   * A stub service-role client whose `rpc` calls are recorded verbatim and
   * whose every `from(...).select()...` read returns the same fixed row.
   * That is enough for the entry points under test here: each one makes
   * exactly one RPC call and, on success, one confirming read.
   */
  function makeServiceClientStub(
    rpcImpl: (fn: string, payload: Record<string, unknown>) => { data: unknown; error: unknown },
    readRow: Record<string, unknown> | null = null,
  ) {
    const rpcCalls: Array<{ fn: string; payload: Record<string, unknown> }> = [];

    const chain = (): FakeQueryChain => {
      const c: FakeQueryChain = {
        select: () => c,
        eq: () => c,
        maybeSingle: () => Promise.resolve({ data: readRow, error: null }),
        single: () => Promise.resolve({ data: readRow, error: null }),
      };
      return c;
    };

    const client = {
      rpc: (fn: string, payload: Record<string, unknown>) => {
        rpcCalls.push({ fn, payload });
        return Promise.resolve(rpcImpl(fn, payload));
      },
      from: () => chain(),
    } as unknown as SupabaseClient;

    return { client, rpcCalls };
  }

  beforeEach(() => {
    createSupabaseServiceClient.mockReset();
  });

  it("refuses to create an escalation outside the entry points", async () => {
    const remote = createSupabaseDataSource(unusableClient);

    await expect(
      remote.escalations.create(supabaseScope, {
        mentionId: crypto.randomUUID(),
        category: "other",
        severity: "high",
        title: "Direct create",
        summary: null,
        dueAt: null,
        triggerAnalysisId: crypto.randomUUID(),
      }),
    ).rejects.toMatchObject({
      code: "unavailable",
      message: "Escalations are created only through analysis application or rule execution.",
    });
  });

  it("records an occurrence via record_analysis_occurrence with exact p_-prefixed params, then reads back the stored row", async () => {
    const mentionId = crypto.randomUUID();
    const analysisRunId = crypto.randomUUID();
    const analysisId = crypto.randomUUID();
    const analyzedAt = new Date().toISOString();

    const storedRow = {
      id: analysisId,
      organization_id: supabaseScope.organizationId,
      mention_id: mentionId,
      model_provider: CLASSIFICATION.modelProvider,
      model_name: CLASSIFICATION.modelName,
      prompt_version: CLASSIFICATION.promptVersion,
      relevance_score: String(CLASSIFICATION.relevanceScore),
      relevance_explanation: CLASSIFICATION.relevanceExplanation,
      sentiment: CLASSIFICATION.sentiment,
      sentiment_score: String(CLASSIFICATION.sentimentScore),
      risk_level: CLASSIFICATION.riskLevel,
      risk_categories: CLASSIFICATION.riskCategories,
      risk_explanation: CLASSIFICATION.riskExplanation,
      topics: CLASSIFICATION.topics,
      facts_needing_verification: CLASSIFICATION.factsNeedingVerification,
      recommended_action: CLASSIFICATION.recommendedAction,
      recommendation_explanation: CLASSIFICATION.recommendationExplanation,
      analyzed_at: analyzedAt,
      analysis_run_id: analysisRunId,
      input_tokens: null,
      output_tokens: null,
      outcome_applied_at: null,
      created_at: new Date().toISOString(),
    };

    const { client, rpcCalls } = makeServiceClientStub(
      () => ({ data: [{ analysis_id: analysisId, created: true }], error: null }),
      storedRow,
    );
    createSupabaseServiceClient.mockReturnValue(client);

    const remote = createSupabaseDataSource(unusableClient);
    const result = await remote.mentions.recordAnalysisOccurrence(supabaseScope, {
      ...CLASSIFICATION,
      mentionId,
      analysisRunId,
      analyzedAt,
    });

    expect(result).toEqual({
      created: true,
      analysis: expect.objectContaining({ id: analysisId, mentionId }),
    });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]?.fn).toBe("record_analysis_occurrence");
    expect(rpcCalls[0]?.payload).toStrictEqual({
      p_organization_id: supabaseScope.organizationId,
      p_mention_id: mentionId,
      p_analysis_run_id: analysisRunId,
      p_model_provider: CLASSIFICATION.modelProvider,
      p_model_name: CLASSIFICATION.modelName,
      p_prompt_version: CLASSIFICATION.promptVersion,
      p_relevance_score: CLASSIFICATION.relevanceScore,
      p_relevance_explanation: CLASSIFICATION.relevanceExplanation,
      p_sentiment: CLASSIFICATION.sentiment,
      p_sentiment_score: CLASSIFICATION.sentimentScore,
      p_risk_level: CLASSIFICATION.riskLevel,
      p_risk_categories: CLASSIFICATION.riskCategories,
      p_risk_explanation: CLASSIFICATION.riskExplanation,
      p_topics: CLASSIFICATION.topics,
      p_facts_needing_verification: CLASSIFICATION.factsNeedingVerification,
      p_recommended_action: CLASSIFICATION.recommendedAction,
      p_recommendation_explanation: CLASSIFICATION.recommendationExplanation,
      p_analyzed_at: analyzedAt,
    });
  });

  it("applies an occurrence via apply_analysis_occurrence with exact p_-prefixed params", async () => {
    const mentionId = crypto.randomUUID();
    const analysisId = crypto.randomUUID();

    const { client, rpcCalls } = makeServiceClientStub(() => ({
      data: [
        {
          escalation_id: null,
          escalation_created: false,
          reason: null,
          already_applied: false,
          final_status: "analyzed",
        },
      ],
      error: null,
    }));
    createSupabaseServiceClient.mockReturnValue(client);

    const remote = createSupabaseDataSource(unusableClient);
    const input = {
      mentionId,
      analysisId,
      shouldEscalate: false,
      category: "other" as const,
      severity: "high" as const,
      title: "Escalated by analysis",
      summary: null,
      sentiment: "negative" as const,
      riskLevel: "high" as const,
      relevanceScore: 0.8,
    };
    const result = await remote.mentions.applyAnalysisOccurrence(supabaseScope, input);

    expect(result).toEqual({
      escalationId: null,
      escalationCreated: false,
      reason: null,
      alreadyApplied: false,
      finalStatus: "analyzed",
    });
    expect(rpcCalls).toHaveLength(1);
    expect(rpcCalls[0]?.fn).toBe("apply_analysis_occurrence");
    expect(rpcCalls[0]?.payload).toStrictEqual({
      p_organization_id: supabaseScope.organizationId,
      p_mention_id: mentionId,
      p_analysis_id: analysisId,
      p_should_escalate: false,
      p_category: "other",
      p_severity: "high",
      p_title: "Escalated by analysis",
      p_summary: null,
      p_sentiment: "negative",
      p_risk_level: "high",
      p_relevance_score: 0.8,
    });
  });

  it("translates a postgrest error from either occurrence RPC into a DataError, never the raw error", async () => {
    const { client } = makeServiceClientStub(() => ({
      data: null,
      error: { message: "boom", code: "XX000" },
    }));
    createSupabaseServiceClient.mockReturnValue(client);

    const remote = createSupabaseDataSource(unusableClient);

    await expect(
      remote.mentions.recordAnalysisOccurrence(supabaseScope, {
        ...CLASSIFICATION,
        mentionId: crypto.randomUUID(),
        analysisRunId: crypto.randomUUID(),
        analyzedAt: new Date().toISOString(),
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "DataError",
        message: expect.not.stringContaining("boom"),
      }),
    );

    await expect(
      remote.mentions.applyAnalysisOccurrence(supabaseScope, {
        mentionId: crypto.randomUUID(),
        analysisId: crypto.randomUUID(),
        shouldEscalate: false,
        category: "other",
        severity: "high",
        title: "Escalated by analysis",
        summary: null,
        sentiment: "negative",
        riskLevel: "high",
        relevanceScore: 0.8,
      }),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "DataError",
        message: expect.not.stringContaining("boom"),
      }),
    );
  });
});
