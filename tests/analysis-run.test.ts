import { beforeEach, describe, expect, it } from "vitest";
import type { IngestMentionInput, Mention } from "@/domain";
import type { AiProvider, AnalyzeMentionInput } from "@/ai/provider";
import { aiError, type AiErrorCode } from "@/ai/errors";
import { analyzeMentions, getAnalysisStatus } from "@/lib/analysis/analyze";
import type { MentionAnalysisOutput } from "@/lib/analysis/schema";
import { can } from "@/lib/auth/permissions";
import { DataError } from "@/lib/data/errors";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
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
  };
}

/** Mentions in this organization that carry no analysis. */
async function unanalyzedCount(activeScope = scope): Promise<number> {
  return dataSource.mentions.countUnanalyzed(activeScope);
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
    ...overrides,
  });

  return mention;
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
    const [target] = await dataSource.mentions.listUnanalyzed(scope, 1);

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
      mentionId: target!.id,
    });
    expect(escalations[0]?.status).toBe("open");
    // Unowned is the signal. A default owner would make it look handled.
    expect(escalations[0]?.assignedUserId).toBeNull();
    expect(escalations[0]?.severity).toBe("critical");
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
    const [target] = await dataSource.mentions.listUnanalyzed(scope, 1);

    const first = await dataSource.escalations.create(scope, {
      mentionId: target!.id,
      category: "other",
      severity: "high",
      title: "Raised by a person",
      summary: null,
      dueAt: null,
    });

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
      mentionId: target!.id,
    });

    expect(escalations).toHaveLength(1);
    expect(escalations[0]?.id).toBe(first.escalation.id);
    // Counted as not-escalated, because this run did not raise it.
    expect(result.counts.escalated).toBe(0);
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
