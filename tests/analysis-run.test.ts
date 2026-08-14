import { beforeEach, describe, expect, it } from "vitest";
import { NON_DISCUSSION_INGEST_FIELDS } from "@/domain";
import type {
  AuditEventType,
  CreateMentionAnalysisInput,
  Escalation,
  IngestMentionInput,
  Mention,
  MentionAnalysis,
} from "@/domain";
import type { AiProvider, AnalyzeMentionInput } from "@/ai/provider";
import { aiError, type AiErrorCode } from "@/ai/errors";
import { analyzeMentions, getAnalysisStatus } from "@/lib/analysis/analyze";
import type { MentionAnalysisOutput } from "@/lib/analysis/schema";
import { can } from "@/lib/auth/permissions";
import { DataError } from "@/lib/data/errors";
import type {
  ApplyAnalysisOccurrenceInput,
  LiaDataSource,
  OrganizationScope,
} from "@/lib/data/types";
import { demoStore } from "@/lib/data/demo/store";
import { freshDataSource, harbor, ushg } from "./helpers/scope";

/**
 * The analysis run, end to end through the service.
 *
 * Only the provider is faked. Repositories, the run lock, the escalation
 * dedupe, the permission matrix, and audit are all production code — because
 * what these tests are for is how those fit together. A run that classifies
 * correctly but overwrites a status somebody set, or one that silently drops
 * half a backlog, is exactly the bug a unit test of any single piece would
 * miss.
 */

let dataSource: LiaDataSource;
let scope: OrganizationScope;

/** A provider that returns a fixed analysis and counts its calls. */
function fakeProvider(
  options: {
    output?: Partial<MentionAnalysisOutput>;
    failWith?: AiErrorCode;
    /** Fail only the nth call (1-indexed), to exercise partial success. */
    failCall?: number;
  } = {},
): AiProvider & { calls: AnalyzeMentionInput[] } {
  const calls: AnalyzeMentionInput[] = [];

  return {
    calls,
    provider: "fake",
    model: "fake-model",
    async analyzeMention(input) {
      calls.push(input);

      if (options.failWith && options.failCall === undefined) {
        throw aiError(options.failWith);
      }
      if (options.failCall !== undefined && calls.length === options.failCall) {
        throw aiError(options.failWith ?? "unknown");
      }

      return {
        analysis: {
          relevanceScore: 0.9,
          relevanceExplanation: "Fixture.",
          sentiment: "negative",
          sentimentScore: -0.5,
          riskLevel: "low",
          riskCategories: [],
          riskExplanation: "Fixture.",
          topics: ["fixture"],
          factsNeedingVerification: [],
          recommendedAction: "respond_publicly",
          recommendationExplanation: "Fixture.",
          ...options.output,
        },
        modelProvider: "fake",
        modelName: "fake-model",
        inputTokens: 100,
        outputTokens: 50,
      };
    },
    // Unused by this file — these tests only exercise the analysis path —
    // but AiProvider requires it since Task 7 added draftResponse.
    async draftResponse() {
      throw new Error("draftResponse not implemented in this fixture");
    },
  };
}

/** Mentions in this organization that carry no analysis. */
async function unanalyzedCount(activeScope = scope): Promise<number> {
  return dataSource.mentions.countUnanalyzed(activeScope);
}

/**
 * A case raised before the escalation contract existed.
 *
 * Written into the store directly because that is the only way such a row can
 * exist: `escalations.create` now requires the analysis occurrence that
 * authorized the case, and a mention still in the backlog has none. The
 * database says the same thing — `trigger_analysis_id` is nullable only for
 * rows that predate the contract — so this is a fixture of a real shape, not a
 * shortcut around a rule.
 */
function seedHistoricalEscalation(mentionId: string): { escalation: Escalation } {
  const timestamp = "2026-08-01T00:00:00.000Z";
  const escalation: Escalation = {
    id: crypto.randomUUID(),
    organizationId: scope.organizationId,
    mentionId,
    category: "other",
    severity: "high",
    status: "open",
    title: "Raised by a person",
    summary: null,
    assignedUserId: null,
    dueAt: null,
    resolvedAt: null,
    resolutionNote: null,
    triggerAnalysisId: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };

  demoStore().escalations.push(escalation);
  return { escalation };
}

/**
 * Import a fresh mention through the real ingest path.
 *
 * Every unanalysed mention in the seed already carries a status a person set,
 * so a test asserting that analysis *advances* a status has to start from one
 * nobody has touched — otherwise it is really asserting that the
 * don't-overwrite rule failed. Ingest creates in `new`, which is exactly what
 * a freshly synced review looks like.
 */
async function ingestFresh(
  externalId: string,
  overrides: Partial<IngestMentionInput> = {},
): Promise<Mention> {
  const template = (await dataSource.mentions.list(scope, { limit: 1 }))[0]!;

  const { mention } = await dataSource.mentions.ingest(scope, {
    locationId: template.locationId,
    platformConnectionId: template.platformConnectionId,
    platformProfileId: template.platformProfileId,
    sourceType: "google_review",
    externalId,
    externalParentId: null,
    sourceUrl: null,
    title: null,
    content: "The service was slow and nobody checked on our table.",
    authorName: "Test Reviewer",
    authorExternalId: null,
    rating: 2,
    language: null,
    // Oldest, so the backlog ordering picks it first.
    publishedAt: "2020-01-01T00:00:00.000Z",
    rawPayload: {},
    externalResourceName: null,
    authorAvatarUrl: null,
    authorIsAnonymous: false,
    sourceUpdatedAt: null,
    sourceReplyText: null,
    sourceReplyUpdatedAt: null,
    sourceMetadata: {},
    syncedAt: "2026-08-04T00:00:00.000Z",
    publisherName: null,
    publisherDomain: null,
    monitoringQueryId: null,
    ...NON_DISCUSSION_INGEST_FIELDS,
    ...overrides,
  });

  return mention;
}

/**
 * A pending occurrence, written straight through `createAnalysis`.
 *
 * `createAnalysis` is the one repository write that appends an analysis row
 * without applying it, which makes it the only way to construct the state a
 * crash between `recordAnalysisOccurrence` and `applyAnalysisOccurrence`
 * leaves behind: a durable classification whose outcome nobody acted on.
 *
 * `analyzedAt` defaults to a minute ahead so the row is unambiguously the
 * mention's latest — a mention that has already been analysed once carries an
 * earlier row, and recovery has to find this one.
 */
async function seedPendingOccurrence(
  mentionId: string,
  overrides: Partial<CreateMentionAnalysisInput> = {},
): Promise<MentionAnalysis> {
  return dataSource.mentions.createAnalysis(scope, {
    mentionId,
    modelProvider: "fake",
    modelName: "fake-model",
    promptVersion: "analysis@test",
    relevanceScore: 0.9,
    relevanceExplanation: "Recovered fixture.",
    sentiment: "negative",
    sentimentScore: -0.5,
    riskLevel: "critical",
    riskCategories: ["injury"],
    riskExplanation: "Recovered fixture.",
    topics: ["fixture"],
    factsNeedingVerification: [],
    recommendedAction: "escalate",
    recommendationExplanation: "Recovered fixture.",
    analyzedAt: new Date(Date.now() + 60_000).toISOString(),
    analysisRunId: crypto.randomUUID(),
    inputTokens: null,
    outputTokens: null,
    ...overrides,
  });
}

/**
 * A data source whose first `applyAnalysisOccurrence` dies before it writes.
 *
 * The crash the occurrence lifecycle exists for: the classification is already
 * durable and the outcome is not, so the next run must finish that occurrence
 * rather than pay for a second opinion.
 */
function crashOnFirstApply(source: LiaDataSource): LiaDataSource {
  let crashed = false;

  return {
    ...source,
    mentions: {
      ...source.mentions,
      async applyAnalysisOccurrence(applyScope, input) {
        if (!crashed) {
          crashed = true;
          throw new DataError("unavailable", "The connection dropped mid-apply.");
        }
        return source.mentions.applyAnalysisOccurrence(applyScope, input);
      },
    },
  };
}

/** A data source that lets a test act in the window before every apply. */
function actBeforeApply(
  source: LiaDataSource,
  act: (input: ApplyAnalysisOccurrenceInput) => Promise<void>,
): LiaDataSource {
  return {
    ...source,
    mentions: {
      ...source.mentions,
      async applyAnalysisOccurrence(applyScope, input) {
        await act(input);
        return source.mentions.applyAnalysisOccurrence(applyScope, input);
      },
    },
  };
}

/**
 * Every audit event the *service* asks for, by type.
 *
 * The contract writes the escalation's own event inside the apply transaction,
 * where nothing can separate a case from its trail. That is only true if the
 * service does not also write one — so this records what passes through the
 * repository from application code, and a test asserts what is missing from it.
 */
function auditSpy(source: LiaDataSource): {
  source: LiaDataSource;
  recorded: AuditEventType[];
} {
  const recorded: AuditEventType[] = [];

  return {
    recorded,
    source: {
      ...source,
      auditEvents: {
        ...source.auditEvents,
        async record(recordScope, input) {
          recorded.push(input.eventType);
          return source.auditEvents.record(recordScope, input);
        },
      },
    },
  };
}

/** The analysis rows this mention carries, straight from the store. */
function occurrencesFor(mentionId: string): MentionAnalysis[] {
  return demoStore().mentionAnalyses.filter((row) => row.mentionId === mentionId);
}

beforeEach(() => {
  dataSource = freshDataSource();
  scope = ushg.admin();
});

/* -------------------------------------------------------------------------- */
/* The backlog                                                                 */
/* -------------------------------------------------------------------------- */

describe("selecting the backlog", () => {
  it("analyses only mentions that have none", async () => {
    // The seed already carries analyses for some mentions. A run must not
    // re-do those — re-analysis costs money and buys nothing.
    const before = await unanalyzedCount();
    expect(before).toBeGreaterThan(0);

    const provider = fakeProvider();
    await analyzeMentions({ dataSource, scope }, { provider, limit: 500 });

    expect(await unanalyzedCount()).toBe(0);
  });

  it("re-running finds nothing left to do", async () => {
    const provider = fakeProvider();
    await analyzeMentions({ dataSource, scope }, { provider, limit: 500 });

    const callsAfterFirst = provider.calls.length;
    const second = await analyzeMentions(
      { dataSource, scope },
      { provider, limit: 500 },
    );

    expect(second.counts.analyzed).toBe(0);
    expect(second.counts.heuristic).toBe(0);
    expect(second.status).toBe("completed");
    expect(provider.calls.length).toBe(callsAfterFirst);
  });

  it("records the backlog a capped run left behind", async () => {
    // The "no silent caps" rule. A run that analysed 3 of 40 and reported
    // success reads as "the inbox is triaged" when it is not.
    const backlog = await unanalyzedCount();
    expect(backlog).toBeGreaterThan(3);

    const result = await analyzeMentions(
      { dataSource, scope },
      { provider: fakeProvider(), limit: 3 },
    );

    expect(result.counts.analyzed + result.counts.heuristic).toBe(3);
    expect(result.counts.remaining).toBe(backlog - 3);
  });

  it("keeps a mention whose occurrence is still pending in the queue", async () => {
    // The widened selection. "Needing analysis work" is no analysis row *or* a
    // latest row whose outcome was never applied — the narrower "no analysis
    // row" would hide a crashed apply forever, because the classification it
    // left behind looks, from the outside, exactly like a finished one.
    const target = await ingestFresh("pending-stays-in-queue");
    const before = await unanalyzedCount();

    await seedPendingOccurrence(target.id);

    expect(await unanalyzedCount()).toBe(before);
    expect(
      (await dataSource.mentions.listUnanalyzed(scope, 500)).map((row) => row.id),
    ).toContain(target.id);

    await analyzeMentions({ dataSource, scope }, { provider: fakeProvider(), limit: 500 });

    // And a completed one leaves it.
    expect(
      (await dataSource.mentions.listUnanalyzed(scope, 500)).map((row) => row.id),
    ).not.toContain(target.id);
    expect(await unanalyzedCount()).toBe(0);
  });

  it("reports an empty backlog as success, not as an error", async () => {
    await analyzeMentions({ dataSource, scope }, { provider: fakeProvider(), limit: 500 });

    const result = await analyzeMentions(
      { dataSource, scope },
      { provider: fakeProvider(), limit: 500 },
    );

    expect(result.status).toBe("completed");
    expect(result.errorMessage).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* What a run writes                                                           */
/* -------------------------------------------------------------------------- */

describe("what a run writes", () => {
  it("populates the denormalised columns the inbox reads", async () => {
    const target = await ingestFresh("fresh-for-status");

    await analyzeMentions(
      { dataSource, scope },
      {
        provider: fakeProvider({ output: { sentiment: "negative", riskLevel: "medium" } }),
        limit: 500,
      },
    );

    const after = await dataSource.mentions.get(scope, target.id);
    expect(after?.sentiment).toBe("negative");
    expect(after?.riskLevel).toBe("medium");
    expect(after?.relevanceScore).toBe(0.9);
    expect(after?.status).toBe("analyzed");
  });

  it("stores the analysis with its provenance and token counts", async () => {
    const [target] = await dataSource.mentions.listUnanalyzed(scope, 1);

    const result = await analyzeMentions(
      { dataSource, scope },
      { provider: fakeProvider(), limit: 1 },
    );

    const analysis = await dataSource.mentions.latestAnalysis(scope, target!.id);
    expect(analysis?.modelProvider).toBe("fake");
    expect(analysis?.modelName).toBe("fake-model");
    expect(analysis?.inputTokens).toBe(100);
    expect(analysis?.analysisRunId).toBe(result.analysisRunId);
  });

  it("never touches a source-owned field", async () => {
    // The mirror of workflow 03's Lia-fields test. A sync may not write Lia
    // state; an analysis may not write source state.
    const [target] = await dataSource.mentions.listUnanalyzed(scope, 1);
    const before = { ...target! };

    await analyzeMentions({ dataSource, scope }, { provider: fakeProvider(), limit: 1 });

    const after = await dataSource.mentions.get(scope, before.id);
    expect(after?.content).toBe(before.content);
    expect(after?.rating).toBe(before.rating);
    expect(after?.authorName).toBe(before.authorName);
    expect(after?.publishedAt).toBe(before.publishedAt);
    expect(after?.sourceReplyText).toBe(before.sourceReplyText);
    expect(after?.externalId).toBe(before.externalId);
  });

  it("does not overwrite a status a person already set", async () => {
    // The failure this guards against is quiet: a mention somebody dismissed
    // reappearing in the queue because a machine decided it was `analyzed`.
    const [target] = await dataSource.mentions.listUnanalyzed(scope, 1);
    await dataSource.mentions.updateStatus(scope, target!.id, "dismissed");

    await analyzeMentions({ dataSource, scope }, { provider: fakeProvider(), limit: 1 });

    const after = await dataSource.mentions.get(scope, target!.id);
    // The scores still land — they are the analysis's own fields.
    expect(after?.sentiment).toBe("negative");
    // The decision does not.
    expect(after?.status).toBe("dismissed");
  });
});

/* -------------------------------------------------------------------------- */
/* Processed pairs for rule execution                                          */
/* -------------------------------------------------------------------------- */

describe("processed pairs for rule execution", () => {
  it("reports one mention/analysis pair per analysis row written this run", async () => {
    // A rating-only mention alongside the model-analysed seed backlog, so the
    // run exercises both the heuristic and the model outcome — both are
    // required to write an analysis row and so both must appear.
    await dataSource.mentions.ingest(scope, {
      locationId: null,
      platformConnectionId: (await dataSource.mentions.listUnanalyzed(scope, 1))[0]!
        .platformConnectionId,
      platformProfileId: null,
      sourceType: "google_review",
      externalId: "processed-pairs-heuristic",
      externalParentId: null,
      sourceUrl: null,
      title: null,
      content: "",
      authorName: null,
      authorExternalId: null,
      rating: 5,
      language: null,
      publishedAt: "2026-01-01T00:00:00.000Z",
      rawPayload: {},
      externalResourceName: null,
      authorAvatarUrl: null,
      authorIsAnonymous: false,
      sourceUpdatedAt: null,
      sourceReplyText: null,
      sourceReplyUpdatedAt: null,
      sourceMetadata: {},
      syncedAt: "2026-08-04T00:00:00.000Z",
      publisherName: null,
      publisherDomain: null,
      monitoringQueryId: null,
      ...NON_DISCUSSION_INGEST_FIELDS,
    });

    const result = await analyzeMentions(
      { dataSource, scope },
      { provider: fakeProvider(), limit: 500 },
    );

    expect(result.counts.analyzed).toBeGreaterThan(0);
    expect(result.counts.heuristic).toBeGreaterThan(0);
    expect(result.processed.length).toBe(
      result.counts.analyzed + result.counts.heuristic,
    );

    // Every mention in the pair list is unique — one analysis row each.
    const mentionIds = result.processed.map((pair) => pair.mentionId);
    expect(new Set(mentionIds).size).toBe(mentionIds.length);

    // Each pair's analysisId resolves to a real analysis row belonging to
    // its mentionId. `latestAnalysis` is the only per-mention analysis read
    // the repository exposes, and since this run is the only writer for
    // these previously-unanalysed mentions, the latest row is the one this
    // run wrote.
    for (const pair of result.processed) {
      const analysis = await dataSource.mentions.latestAnalysis(scope, pair.mentionId);
      expect(analysis).not.toBeNull();
      expect(analysis?.id).toBe(pair.analysisId);
      expect(analysis?.mentionId).toBe(pair.mentionId);
    }
  });

  it("excludes a mention that failed to analyse", async () => {
    const result = await analyzeMentions(
      { dataSource, scope },
      { provider: fakeProvider({ failWith: "refused", failCall: 1 }), limit: 3 },
    );

    expect(result.counts.failed).toBe(1);
    expect(result.processed.length).toBe(
      result.counts.analyzed + result.counts.heuristic,
    );
    expect(result.processed.length).toBeLessThan(3);
  });
});

/* -------------------------------------------------------------------------- */
/* Rating-only mentions                                                        */
/* -------------------------------------------------------------------------- */

describe("rating-only mentions", () => {
  it("analyses them without calling the model", async () => {
    const [target] = await dataSource.mentions.listUnanalyzed(scope, 1);
    await dataSource.mentions.ingest(scope, {
      locationId: target!.locationId,
      platformConnectionId: target!.platformConnectionId,
      platformProfileId: target!.platformProfileId,
      sourceType: "google_review",
      externalId: "rating-only-fixture",
      externalParentId: null,
      sourceUrl: null,
      title: null,
      content: "",
      authorName: null,
      authorExternalId: null,
      rating: 4,
      language: null,
      publishedAt: "2026-01-01T00:00:00.000Z",
      rawPayload: {},
      externalResourceName: null,
      authorAvatarUrl: null,
      authorIsAnonymous: false,
      sourceUpdatedAt: null,
      sourceReplyText: null,
      sourceReplyUpdatedAt: null,
      sourceMetadata: {},
      syncedAt: "2026-08-04T00:00:00.000Z",
      publisherName: null,
      publisherDomain: null,
      monitoringQueryId: null,
      ...NON_DISCUSSION_INGEST_FIELDS,
    });

    const provider = fakeProvider();
    const result = await analyzeMentions(
      { dataSource, scope },
      { provider, limit: 500 },
    );

    expect(result.counts.heuristic).toBeGreaterThan(0);

    // The proof: no call carried the rating-only mention.
    const analysed = provider.calls.map((call) => call.mention.externalId);
    expect(analysed).not.toContain("rating-only-fixture");
  });

  it("marks a heuristic analysis as such rather than claiming a model", async () => {
    await dataSource.mentions.ingest(scope, {
      locationId: null,
      platformConnectionId: (await dataSource.mentions.listUnanalyzed(scope, 1))[0]!
        .platformConnectionId,
      platformProfileId: null,
      sourceType: "google_review",
      externalId: "rating-only-provenance",
      externalParentId: null,
      sourceUrl: null,
      title: null,
      content: "",
      authorName: null,
      authorExternalId: null,
      rating: 5,
      language: null,
      publishedAt: "2026-01-01T00:00:00.000Z",
      rawPayload: {},
      externalResourceName: null,
      authorAvatarUrl: null,
      authorIsAnonymous: false,
      sourceUpdatedAt: null,
      sourceReplyText: null,
      sourceReplyUpdatedAt: null,
      sourceMetadata: {},
      syncedAt: "2026-08-04T00:00:00.000Z",
      publisherName: null,
      publisherDomain: null,
      monitoringQueryId: null,
      ...NON_DISCUSSION_INGEST_FIELDS,
    });

    await analyzeMentions({ dataSource, scope }, { provider: fakeProvider(), limit: 500 });

    const mentions = await dataSource.mentions.list(scope);
    const target = mentions.find((row) => row.externalId === "rating-only-provenance");
    const analysis = await dataSource.mentions.latestAnalysis(scope, target!.id);

    expect(analysis?.modelProvider).toBe("lia");
    expect(analysis?.modelName).toBe("rating-heuristic");
    // No prompt was used, so claiming a version would be a fiction in the
    // field a later prompt comparison relies on.
    expect(analysis?.inputTokens).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Escalation                                                                  */
/* -------------------------------------------------------------------------- */

describe("escalation", () => {
  it("raises an open, unassigned escalation for critical risk", async () => {
    // A freshly imported mention rather than the head of the seeded backlog:
    // that one is `dismissed`, and the escalation contract refuses to raise a
    // case on a dismissed mention — analysis does not reopen a decision a
    // person made. Starting there would test the refusal, not the raise.
    const target = await ingestFresh("fresh-for-critical-risk");

    const result = await analyzeMentions(
      { dataSource, scope },
      {
        provider: fakeProvider({
          output: {
            riskLevel: "critical",
            riskCategories: ["food_safety"],
            escalationTitle: "Allergic reaction after shellfish dish",
          },
        }),
        limit: 1,
      },
    );

    expect(result.counts.escalated).toBe(1);

    const escalations = await dataSource.escalations.list(scope, {
      mentionId: target.id,
    });
    expect(escalations[0]?.status).toBe("open");
    // Unowned is the signal. A default owner would make it look handled.
    expect(escalations[0]?.assignedUserId).toBeNull();
    expect(escalations[0]?.severity).toBe("critical");
    // The case names the occurrence that authorized it, which is what makes a
    // repeated application find this row rather than raise a second one.
    const analysis = await dataSource.mentions.latestAnalysis(scope, target.id);
    expect(escalations[0]?.triggerAnalysisId).toBe(analysis?.id);
  });

  it("moves the mention to escalated rather than analyzed", async () => {
    const target = await ingestFresh("fresh-for-escalation");

    await analyzeMentions(
      { dataSource, scope },
      {
        provider: fakeProvider({
          output: { riskLevel: "critical", riskCategories: ["injury"] },
        }),
        limit: 500,
      },
    );

    expect((await dataSource.mentions.get(scope, target.id))?.status).toBe("escalated");
  });

  it("raises none for low risk", async () => {
    const [target] = await dataSource.mentions.listUnanalyzed(scope, 1);

    const result = await analyzeMentions(
      { dataSource, scope },
      { provider: fakeProvider({ output: { riskLevel: "low" } }), limit: 1 },
    );

    expect(result.counts.escalated).toBe(0);
    expect(
      await dataSource.escalations.list(scope, { mentionId: target!.id }),
    ).toHaveLength(0);
  });

  it("does not raise a second escalation for a mention that has one", async () => {
    // Two open cases for one review is a queue nobody trusts.
    //
    // A freshly imported mention, deliberately: it is `new`, so it reaches the
    // contract's open-case dedupe rather than being turned away earlier by the
    // dismissed refusal — the head of the seeded backlog is dismissed, and a
    // fixture built on it would pass with the dedupe entirely broken. Ingest
    // also makes it the oldest mention in the backlog, so a `limit: 1` run
    // picks exactly this one.
    //
    // The case is written straight into the store rather than raised through
    // the repository, and it has to be: every escalation raised from here on
    // names the analysis occurrence that authorized it, and this mention has
    // no analysis yet — giving it one would take it out of the backlog this
    // run is meant to pick it up from. A case with no occurrence is exactly
    // what a row predating the contract looks like, which is what this fixture
    // is, and the contract still has to dedupe against it.
    const target = await ingestFresh("fresh-for-existing-escalation");

    const first = seedHistoricalEscalation(target.id);

    const result = await analyzeMentions(
      { dataSource, scope },
      {
        provider: fakeProvider({
          output: { riskLevel: "critical", riskCategories: ["food_safety"] },
        }),
        limit: 1,
      },
    );

    const escalations = await dataSource.escalations.list(scope, {
      mentionId: target.id,
    });

    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.id).toBe(first.escalation.id);
    // Counted as not-escalated, because this run did not raise it.
    expect(result.counts.escalated).toBe(0);
    // Which arm refused it matters: the open case is what stopped the second
    // one, and the mention advancing to `escalated` is what proves it. A
    // refusal for any other reason — a dismissed mention, say — would have
    // left the status where it was and passed these counts just the same.
    expect((await dataSource.mentions.get(scope, target.id))?.status).toBe("escalated");
  });
});

/* -------------------------------------------------------------------------- */
/* The occurrence lifecycle                                                    */
/* -------------------------------------------------------------------------- */

/**
 * Record, then apply — and survive a crash between the two.
 *
 * These are the guarantees the escalation contract exists to provide, exercised
 * through the service rather than through the repository, because the thing
 * that can go wrong is the order and the recovery, not any single call.
 */
describe("the occurrence lifecycle", () => {
  /** The classification that must produce a case. */
  const critical = (): Partial<MentionAnalysisOutput> => ({
    riskLevel: "critical",
    riskCategories: ["injury"],
  });

  it("gives the case its occurrence, and leaves the audit event to the contract", async () => {
    const target = await ingestFresh("lifecycle-provenance");
    const spy = auditSpy(dataSource);

    await analyzeMentions(
      { dataSource: spy.source, scope },
      { provider: fakeProvider({ output: critical() }), limit: 1 },
    );

    const analysis = await dataSource.mentions.latestAnalysis(scope, target.id);
    const [escalation] = await dataSource.escalations.list(scope, {
      mentionId: target.id,
    });

    // Provenance: the case names the reading of the mention that authorized it.
    expect(escalation?.triggerAnalysisId).toBe(analysis?.id);

    const events = await dataSource.auditEvents.list(scope, {
      eventTypes: ["escalation.created_from_analysis"],
    });
    expect(events).toHaveLength(1);
    expect(events[0]?.entityId).toBe(escalation?.id);

    // Exactly one, and the service wrote none of it: the event is part of the
    // apply transaction, so no failure can separate a case from its trail.
    // The run's own event proves the spy sees what the service does record.
    expect(spy.recorded).toContain("mention.analyzed");
    expect(spy.recorded).not.toContain("escalation.created_from_analysis");
  });

  it("recovers a crashed apply without classifying the mention twice", async () => {
    const target = await ingestFresh("lifecycle-crash");
    const provider = fakeProvider({ output: critical() });

    const first = await analyzeMentions(
      { dataSource: crashOnFirstApply(dataSource), scope },
      { provider, limit: 1 },
    );

    // Nothing durable but the classification itself.
    expect(first.counts.failed).toBe(1);
    expect(first.counts.escalated).toBe(0);
    expect(first.processed).toHaveLength(0);

    const pending = await dataSource.mentions.latestAnalysis(scope, target.id);
    expect(pending?.outcomeAppliedAt).toBeNull();
    expect(await dataSource.escalations.list(scope, { mentionId: target.id })).toHaveLength(0);
    expect((await dataSource.mentions.get(scope, target.id))?.status).toBe("new");

    const second = await analyzeMentions({ dataSource, scope }, { provider, limit: 1 });

    // One model call across both runs. The pending occurrence already holds a
    // classification; paying for a second one would be spending money to
    // second-guess a decision that is already durable.
    expect(provider.calls).toHaveLength(1);

    // Applied under the *original* occurrence's identity, not a new one.
    expect(occurrencesFor(target.id)).toHaveLength(1);
    expect(second.processed).toEqual([
      { mentionId: target.id, analysisId: pending!.id },
    ]);

    const escalations = await dataSource.escalations.list(scope, { mentionId: target.id });
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.triggerAnalysisId).toBe(pending?.id);

    const applied = await dataSource.mentions.latestAnalysis(scope, target.id);
    expect(applied?.id).toBe(pending?.id);
    expect(applied?.outcomeAppliedAt).not.toBeNull();

    // Counts honest across the two runs: escalated is incremented by whichever
    // run actually created the case, exactly once.
    expect(second.counts.escalated).toBe(1);
    expect(
      await dataSource.auditEvents.list(scope, {
        eventTypes: ["escalation.created_from_analysis"],
      }),
    ).toHaveLength(1);

    // The run rows are the cost record, and between them they have to account
    // for exactly one model call — the one the provider spy saw.
    const firstRun = await dataSource.analysisRuns.get(scope, first.analysisRunId);
    const secondRun = await dataSource.analysisRuns.get(scope, second.analysisRunId);

    // Run 1 called the model and then failed to apply what it got back. The
    // money is spent either way, so a run row denying it would hide real spend
    // from a cost review — even though this run recorded no successful item.
    expect(first.counts.analyzed).toBe(0);
    expect(firstRun?.status).toBe("failed");
    expect(firstRun?.modelProvider).toBe("fake");
    expect(firstRun?.modelName).toBe("fake-model");
    expect(firstRun?.promptVersion).not.toBeNull();

    // Run 2 called nothing: it applied an analysis run 1 paid for. Claiming the
    // model here would double-count that one call. Note it says so while
    // reporting the mention as `analyzed` — the bucket comes from the stored
    // row's provenance, the spend from what this run actually did, and the two
    // are deliberately not the same question.
    expect(second.counts.analyzed).toBe(1);
    expect(secondRun?.modelProvider).toBeNull();
    expect(secondRun?.modelName).toBeNull();
    expect(secondRun?.promptVersion).toBeNull();
  });

  it("recovers a heuristic occurrence as heuristic, whatever the mention looks like", async () => {
    // A mention with words in it: `isRatingOnly` says "this one needs a model".
    // The occurrence waiting on it says otherwise — it was classified by the
    // rating heuristic — and the occurrence is the one that is true, because it
    // is the analysis that actually exists. Reporting it as `analyzed` would
    // claim a model reading of this mention that nobody ever made.
    const target = await ingestFresh("lifecycle-heuristic-recovery");

    const pending = await seedPendingOccurrence(target.id, {
      // The heuristic's own provenance — `HEURISTIC_MODEL_PROVIDER` and
      // `HEURISTIC_MODEL_NAME`, spelled out the way the neighbouring
      // provenance test spells them.
      modelProvider: "lia",
      modelName: "rating-heuristic",
      // Provenance is the whole identity: `isHeuristicAnalysis` reads these two
      // columns and nothing else, so this row is a heuristic analysis however
      // model-shaped the mention it belongs to is.
      inputTokens: null,
      outputTokens: null,
      riskLevel: "low",
      riskCategories: [],
    });

    const provider = fakeProvider();
    const result = await analyzeMentions({ dataSource, scope }, { provider, limit: 1 });

    // Recovery, so nothing was classified a second time.
    expect(provider.calls).toHaveLength(0);

    expect(result.counts.heuristic).toBe(1);
    expect(result.counts.analyzed).toBe(0);
    expect(result.processed).toEqual([
      { mentionId: target.id, analysisId: pending.id },
    ]);

    // Applied exactly once, under the occurrence that was already there.
    expect(occurrencesFor(target.id)).toHaveLength(1);
    const stored = await dataSource.mentions.latestAnalysis(scope, target.id);
    expect(stored?.id).toBe(pending.id);
    expect(stored?.outcomeAppliedAt).not.toBeNull();
    expect((await dataSource.mentions.get(scope, target.id))?.status).toBe("analyzed");
  });

  it("replaying a completed occurrence has no effects", async () => {
    const target = await ingestFresh("lifecycle-replay");

    await analyzeMentions(
      { dataSource, scope },
      { provider: fakeProvider({ output: critical() }), limit: 1 },
    );

    const analysis = await dataSource.mentions.latestAnalysis(scope, target.id);
    const before = await dataSource.mentions.get(scope, target.id);
    const [escalation] = await dataSource.escalations.list(scope, {
      mentionId: target.id,
    });

    // A replay carrying deliberately different scores, so any write would show.
    const replay = await dataSource.mentions.applyAnalysisOccurrence(scope, {
      mentionId: target.id,
      analysisId: analysis!.id,
      shouldEscalate: true,
      category: "other",
      severity: "high",
      title: "Replayed",
      summary: null,
      sentiment: "positive",
      riskLevel: "low",
      relevanceScore: 0.1,
    });

    expect(replay.alreadyApplied).toBe(true);
    expect(replay.escalationCreated).toBe(false);
    expect(replay.finalStatus).toBe("escalated");
    expect(await dataSource.mentions.get(scope, target.id)).toEqual(before);
    expect(await dataSource.escalations.list(scope, { mentionId: target.id })).toHaveLength(1);
    expect(
      (
        await dataSource.auditEvents.list(scope, {
          eventTypes: ["escalation.created_from_analysis"],
        })
      ).filter((event) => event.entityId === escalation!.id),
    ).toHaveLength(1);

    // And the pipeline never offers it a replay in the first place: a completed
    // occurrence takes the mention out of the queue.
    await analyzeMentions({ dataSource, scope }, { provider: fakeProvider(), limit: 500 });
    expect(occurrencesFor(target.id)).toHaveLength(1);
    expect(await dataSource.escalations.list(scope, { mentionId: target.id })).toHaveLength(1);
  });

  it("completes the occurrence of a dismissed mention without escalating it", async () => {
    // A person dismissed this; the model then reads it as critical. The
    // classification still lands, the decision still stands, and the occurrence
    // is finished — leaving it pending would have recovery re-pick it forever.
    const target = await ingestFresh("lifecycle-dismissed");
    await dataSource.mentions.updateStatus(scope, target.id, "dismissed");

    const result = await analyzeMentions(
      { dataSource, scope },
      { provider: fakeProvider({ output: critical() }), limit: 1 },
    );

    expect(result.status).toBe("completed");
    expect(result.counts.escalated).toBe(0);
    expect(await dataSource.escalations.list(scope, { mentionId: target.id })).toHaveLength(0);

    const after = await dataSource.mentions.get(scope, target.id);
    expect(after?.status).toBe("dismissed");
    expect(after?.riskLevel).toBe("critical");

    const analysis = await dataSource.mentions.latestAnalysis(scope, target.id);
    expect(analysis?.outcomeAppliedAt).not.toBeNull();
    expect(result.processed).toContainEqual({
      mentionId: target.id,
      analysisId: analysis!.id,
    });
  });

  it("refuses to re-escalate a mention whose only cases are closed", async () => {
    // Somebody resolved the case but has not re-triaged the mention, so it is
    // still `escalated`. A pending occurrence recovered into that state must
    // not re-open work a person deliberately finished.
    const target = await ingestFresh("lifecycle-retriage");

    await analyzeMentions(
      { dataSource, scope },
      { provider: fakeProvider({ output: critical() }), limit: 1 },
    );

    const [first] = await dataSource.escalations.list(scope, { mentionId: target.id });
    await dataSource.escalations.updateStatus(scope, first!.id, "resolved", "Handled.");

    const pending = await seedPendingOccurrence(target.id);

    const provider = fakeProvider({ output: critical() });
    const result = await analyzeMentions({ dataSource, scope }, { provider, limit: 1 });

    // Recovery, so no classification happened at all.
    expect(provider.calls).toHaveLength(0);
    expect(result.status).toBe("completed");
    expect(result.counts.escalated).toBe(0);

    const escalations = await dataSource.escalations.list(scope, { mentionId: target.id });
    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.status).toBe("resolved");
    expect((await dataSource.mentions.get(scope, target.id))?.status).toBe("escalated");

    // Finished all the same: it has done everything it will ever do.
    const stored = occurrencesFor(target.id).find((row) => row.id === pending.id);
    expect(stored?.outcomeAppliedAt).not.toBeNull();
  });

  it("preserves a status a person set between the recording and the apply", async () => {
    const target = await ingestFresh("lifecycle-responded");

    const raced = actBeforeApply(dataSource, async (input) => {
      if (input.mentionId !== target.id) return;
      await dataSource.mentions.updateStatus(scope, target.id, "responded");
    });

    await analyzeMentions(
      { dataSource: raced, scope },
      {
        provider: fakeProvider({
          output: { sentiment: "negative", riskLevel: "medium" },
        }),
        limit: 1,
      },
    );

    const after = await dataSource.mentions.get(scope, target.id);
    // The person's decision stands; the analysis's own fields still land.
    expect(after?.status).toBe("responded");
    expect(after?.sentiment).toBe("negative");
    expect(after?.riskLevel).toBe("medium");
    expect((await dataSource.mentions.latestAnalysis(scope, target.id))?.outcomeAppliedAt)
      .not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Failure                                                                     */
/* -------------------------------------------------------------------------- */

describe("failures", () => {
  it("keeps the rest of the batch when one mention is refused", async () => {
    // Real for this product: a review describing an injury can trip a safety
    // classifier, and those are the reviews that most need reading.
    const result = await analyzeMentions(
      { dataSource, scope },
      { provider: fakeProvider({ failWith: "refused", failCall: 2 }), limit: 5 },
    );

    expect(result.status).toBe("partial");
    expect(result.counts.failed).toBe(1);
    expect(result.counts.analyzed).toBeGreaterThan(0);
    expect(result.errorCode).toBe("refused");
  });

  it("stops the run on a credential failure instead of burning the batch", async () => {
    // not_authorized will not fix itself. Retrying 49 more times wastes money
    // and delays the one message an operator can act on.
    const provider = fakeProvider({ failWith: "not_authorized" });
    const result = await analyzeMentions(
      { dataSource, scope },
      { provider, limit: 20 },
    );

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("not_authorized");
    expect(provider.calls).toHaveLength(1);
    // What it did not get to is still backlog, not silently finished.
    expect(result.counts.remaining).toBeGreaterThan(0);
  });

  it("never exposes a provider message", async () => {
    const result = await analyzeMentions(
      { dataSource, scope },
      { provider: fakeProvider({ failWith: "provider_unavailable" }), limit: 1 },
    );

    // Lia's own wording. A model error can echo the prompt, and the prompt
    // contains the review and the reviewer's name.
    expect(result.errorMessage).not.toMatch(/api[_-]?key|prompt|anthropic/i);
  });

  it("writes no analysis for a mention it could not classify", async () => {
    const backlogBefore = await unanalyzedCount();

    await analyzeMentions(
      { dataSource, scope },
      { provider: fakeProvider({ failWith: "unexpected_output" }), limit: 1 },
    );

    // Still unanalysed, so the next run picks it up rather than it being
    // silently written off.
    expect(await unanalyzedCount()).toBe(backlogBefore);
  });
});

/* -------------------------------------------------------------------------- */
/* Concurrency and authorization                                               */
/* -------------------------------------------------------------------------- */

describe("concurrency", () => {
  it("lets only one run hold an organization at a time", async () => {
    const held = await dataSource.analysisRuns.start(scope, {
      trigger: "manual",
      actorUserId: scope.userId,
      startedAt: new Date().toISOString(),
    });

    const provider = fakeProvider();
    const error = await analyzeMentions(
      { dataSource, scope },
      { provider, limit: 5 },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DataError);
    expect((error as DataError).code).toBe("conflict");
    expect(provider.calls).toHaveLength(0);

    // And the refused attempt left no run row to confuse the history.
    const runs = await dataSource.analysisRuns.list(scope);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(held.id);
  });

  it("reclaims a run abandoned by a process that died", async () => {
    await dataSource.analysisRuns.start(scope, {
      trigger: "manual",
      actorUserId: scope.userId,
      startedAt: new Date(Date.now() - 60 * 60 * 1000).toISOString(),
    });

    const result = await analyzeMentions(
      { dataSource, scope },
      { provider: fakeProvider(), limit: 1 },
    );

    expect(result.status).toBe("completed");
  });

  it("does not block a different organization", async () => {
    await dataSource.analysisRuns.start(scope, {
      trigger: "manual",
      actorUserId: scope.userId,
      startedAt: new Date().toISOString(),
    });

    const result = await analyzeMentions(
      { dataSource, scope: harbor.owner() },
      { provider: fakeProvider(), limit: 1 },
    );

    expect(result.status).toBe("completed");
  });
});

describe("authorization", () => {
  it("gives the permission to the roles that own the queue", () => {
    expect(can("owner", "mention.analyze")).toBe(true);
    expect(can("admin", "mention.analyze")).toBe(true);
    expect(can("communications_lead", "mention.analyze")).toBe(true);
  });

  it("withholds it from read-only roles and location managers", () => {
    expect(can("analyst", "mention.analyze")).toBe(false);
    expect(can("viewer", "mention.analyze")).toBe(false);
    // A run walks the whole organization's backlog, so there is no location
    // to scope a location manager to.
    expect(can("location_manager", "mention.analyze")).toBe(false);
  });

  it("analyses only the caller's own organization", async () => {
    const harborScope = harbor.owner();
    const ushgBefore = await unanalyzedCount();

    await analyzeMentions(
      { dataSource, scope: harborScope },
      { provider: fakeProvider(), limit: 500 },
    );

    // Harbor's backlog is clear; USHG's is untouched.
    expect(await unanalyzedCount(harborScope)).toBe(0);
    expect(await unanalyzedCount()).toBe(ushgBefore);
  });
});

/* -------------------------------------------------------------------------- */
/* Observability                                                               */
/* -------------------------------------------------------------------------- */

describe("observability", () => {
  it("records an audit event carrying counts but no review text", async () => {
    await analyzeMentions({ dataSource, scope }, { provider: fakeProvider(), limit: 2 });

    const events = await dataSource.auditEvents.list(scope, {
      eventTypes: ["mention.analyzed"],
    });

    expect(events.length).toBeGreaterThan(0);
    const serialised = JSON.stringify(events[0]);
    // The seeded reviews all contain this; the audit trail must not.
    expect(serialised).not.toContain("reservation");
  });

  it("reports status for the inbox card", async () => {
    await analyzeMentions({ dataSource, scope }, { provider: fakeProvider(), limit: 2 });

    const status = await getAnalysisStatus({ dataSource, scope });

    expect(status.lastSuccessful?.status).toBe("completed");
    expect(status.running).toBe(false);
    expect(status.unanalyzedCount).toBeGreaterThanOrEqual(0);
  });

  it("shows a run as active while it holds the lock", async () => {
    await dataSource.analysisRuns.start(scope, {
      trigger: "manual",
      actorUserId: scope.userId,
      startedAt: new Date().toISOString(),
    });

    expect((await getAnalysisStatus({ dataSource, scope })).running).toBe(true);
  });

  it("attributes a scheduled run to no person", async () => {
    const result = await analyzeMentions(
      { dataSource, scope },
      { provider: fakeProvider(), limit: 1, trigger: "scheduled" },
    );

    const run = await dataSource.analysisRuns.get(scope, result.analysisRunId);
    // Attributing an unattended run to whoever last clicked would be a lie in
    // the audit trail.
    expect(run?.actorUserId).toBeNull();
    expect(run?.trigger).toBe("scheduled");
  });

  it("names no model on a run that never called one", async () => {
    // Analyse the whole backlog first so only heuristic work remains.
    await analyzeMentions({ dataSource, scope }, { provider: fakeProvider(), limit: 500 });

    const connectionId = (await dataSource.mentions.list(scope))[0]!
      .platformConnectionId;

    await dataSource.mentions.ingest(scope, {
      locationId: null,
      platformConnectionId: connectionId,
      platformProfileId: null,
      sourceType: "google_review",
      externalId: "heuristic-only-run",
      externalParentId: null,
      sourceUrl: null,
      title: null,
      content: "",
      authorName: null,
      authorExternalId: null,
      rating: 5,
      language: null,
      publishedAt: "2026-01-01T00:00:00.000Z",
      rawPayload: {},
      externalResourceName: null,
      authorAvatarUrl: null,
      authorIsAnonymous: false,
      sourceUpdatedAt: null,
      sourceReplyText: null,
      sourceReplyUpdatedAt: null,
      sourceMetadata: {},
      syncedAt: "2026-08-04T00:00:00.000Z",
      publisherName: null,
      publisherDomain: null,
      monitoringQueryId: null,
      ...NON_DISCUSSION_INGEST_FIELDS,
    });

    const result = await analyzeMentions(
      { dataSource, scope },
      { provider: fakeProvider(), limit: 500 },
    );

    const run = await dataSource.analysisRuns.get(scope, result.analysisRunId);
    expect(result.counts.heuristic).toBe(1);
    expect(result.counts.analyzed).toBe(0);
    // Naming a model that was never called would put a fiction into the
    // provenance a cost review reads.
    expect(run?.modelName).toBeNull();
    expect(run?.promptVersion).toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* The cron sweep's organization scan                                         */
/* -------------------------------------------------------------------------- */

describe("the cron sweep's organization scan", () => {
  it("mirrors listUnanalyzed's widened selection: a pending occurrence still counts as work", async () => {
    // Clear both organizations' backlogs first, so what each one carries
    // afterward is exactly what this test sets up next — not whatever the
    // seed happened to leave behind.
    const harborScope = harbor.owner();
    await analyzeMentions({ dataSource, scope }, { provider: fakeProvider(), limit: 500 });
    await analyzeMentions(
      { dataSource, scope: harborScope },
      { provider: fakeProvider(), limit: 500 },
    );
    expect(await unanalyzedCount()).toBe(0);
    expect(await unanalyzedCount(harborScope)).toBe(0);

    // USHG's only remaining work is a pending occurrence — the narrower "no
    // analysis row" predicate would miss this mention entirely, because a
    // pending analysis row already exists for it.
    const target = await ingestFresh("sweep-widened-pending");
    await seedPendingOccurrence(target.id);

    const swept = await dataSource.organizations.listWithUnanalyzedMentions();

    expect(swept).toContain(scope.organizationId);
    // Harbor has nothing outstanding — every mention it carries is analysed
    // and applied — so the widened predicate must still leave it out.
    expect(swept).not.toContain(harborScope.organizationId);
  });

  it("still sees a mention carrying both a settled row and a newer pending one", async () => {
    // The case a single `not exists (settled)` predicate would miss: a
    // mention re-analysed after its first occurrence already settled has
    // *two* rows, one settled and one pending. "No settled row exists" is
    // false for that mention — a settled row does exist — so a predicate
    // without the independent "a pending row exists" arm would drop the
    // organization from the sweep while unapplied work still sits on it.
    const harborScope = harbor.owner();
    await analyzeMentions({ dataSource, scope }, { provider: fakeProvider(), limit: 500 });
    await analyzeMentions(
      { dataSource, scope: harborScope },
      { provider: fakeProvider(), limit: 500 },
    );
    expect(await unanalyzedCount()).toBe(0);
    expect(await unanalyzedCount(harborScope)).toBe(0);

    // Settle a fresh USHG mention through the ordinary flow first...
    const target = await ingestFresh("sweep-settled-then-pending");
    await analyzeMentions({ dataSource, scope }, { provider: fakeProvider(), limit: 500 });
    const settled = await dataSource.mentions.latestAnalysis(scope, target.id);
    expect(settled?.outcomeAppliedAt).not.toBeNull();

    // ...then re-analyse it: schema-legal (the one-pending-per-mention index
    // only forbids two pending rows, not a pending row beside a settled
    // one), and exactly how this shape arises in production.
    await seedPendingOccurrence(target.id);
    expect(occurrencesFor(target.id)).toHaveLength(2);

    const swept = await dataSource.organizations.listWithUnanalyzedMentions();

    expect(swept).toContain(scope.organizationId);
    expect(swept).not.toContain(harborScope.organizationId);
  });
});
