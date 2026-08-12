import { beforeEach, describe, expect, it } from "vitest";
import { freshDataSource, harbor, ushg } from "./helpers/scope";
import type { LiaDataSource } from "@/lib/data/types";
import {
  BRAND_VOICE_USHG,
  CONN_GOOGLE,
  LOC_SOHO,
  ORG_HARBOR,
  USER_MARCUS,
  USER_SOFIA,
} from "@/lib/seed/dataset";

/**
 * Repository behaviour: filtering, ordering, transitions, and ingest.
 *
 * These run against the demo adapter. The Supabase adapter implements the same
 * interface and is written to match this behaviour, but it has not been
 * executed against a live database in this environment.
 */

let data: LiaDataSource;

beforeEach(() => {
  data = freshDataSource();
});

async function findRuleByName(name: string) {
  const rules = await data.automationRules.list(ushg.admin(), { includeArchived: true });
  const rule = rules.find((row) => row.name === name);
  if (!rule) throw new Error(`Seeded rule "${name}" not found`);
  return rule;
}

describe("mention filtering", () => {
  it("filters by status", async () => {
    const escalated = await data.mentions.list(ushg.admin(), { statuses: ["escalated"] });
    expect(escalated.length).toBeGreaterThan(0);
    expect(escalated.every((row) => row.status === "escalated")).toBe(true);
  });

  it("filters by risk level", async () => {
    const risky = await data.mentions.list(ushg.admin(), {
      riskLevels: ["high", "critical"],
    });
    expect(risky.length).toBeGreaterThan(0);
    expect(risky.every((row) => ["high", "critical"].includes(row.riskLevel))).toBe(true);
  });

  it("filters by source type", async () => {
    const reviews = await data.mentions.list(ushg.admin(), {
      sourceTypes: ["google_review"],
    });
    expect(reviews.length).toBeGreaterThan(0);
    expect(reviews.every((row) => row.sourceType === "google_review")).toBe(true);
  });

  it("filters by location", async () => {
    const soho = await data.mentions.list(ushg.admin(), { locationId: LOC_SOHO });
    expect(soho.length).toBeGreaterThan(0);
    expect(soho.every((row) => row.locationId === LOC_SOHO)).toBe(true);
  });

  it("filters by platform via the connection", async () => {
    const reddit = await data.mentions.list(ushg.admin(), { platform: "reddit" });
    expect(reddit.length).toBeGreaterThan(0);
    expect(
      reddit.every((row) => ["reddit_post", "reddit_comment"].includes(row.sourceType)),
    ).toBe(true);
  });

  it("searches title, content, and author", async () => {
    const hits = await data.mentions.list(ushg.admin(), { search: "oyster" });
    expect(hits.length).toBeGreaterThan(0);
    expect(
      hits.every((row) =>
        `${row.title ?? ""} ${row.content} ${row.authorName ?? ""}`
          .toLowerCase()
          .includes("oyster"),
      ),
    ).toBe(true);
  });

  it("combines filters", async () => {
    const combined = await data.mentions.list(ushg.admin(), {
      sourceTypes: ["google_review"],
      sentiments: ["negative"],
    });
    expect(
      combined.every(
        (row) => row.sourceType === "google_review" && row.sentiment === "negative",
      ),
    ).toBe(true);
  });

  it("orders newest first and honours limit and offset", async () => {
    const all = await data.mentions.list(ushg.admin());
    const timestamps = all.map((row) => Date.parse(row.publishedAt));
    expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps);

    const page = await data.mentions.list(ushg.admin(), { limit: 3, offset: 1 });
    expect(page).toHaveLength(3);
    expect(page[0]?.id).toBe(all[1]?.id);
  });

  it("ranks the attention queue by risk, then recency", async () => {
    const queue = await data.mentions.listNeedingAttention(ushg.admin());
    const severity = { critical: 0, high: 1, medium: 2, low: 3 } as const;
    const ranks = queue.map((row) => severity[row.riskLevel]);

    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
    expect(queue[0]?.riskLevel).toBe("critical");
  });

  it("counts by status", async () => {
    const counts = await data.mentions.counts(ushg.admin());
    const all = await data.mentions.list(ushg.admin());

    expect(counts.total).toBe(all.length);
    expect(counts.byStatus.escalated).toBe(
      all.filter((row) => row.status === "escalated").length,
    );
  });
});

describe("duplicate external mention protection", () => {
  const baseInput = {
    locationId: LOC_SOHO,
    platformConnectionId: CONN_GOOGLE,
    platformProfileId: null,
    sourceType: "google_review" as const,
    externalId: "dedupe-test-1",
    externalParentId: null,
    sourceUrl: "https://example.com/review/dedupe-test-1",
    title: "First fetch",
    content: "The room was lovely.",
    authorName: "Test Guest",
    authorExternalId: null,
    rating: 4,
    language: "en-US",
    publishedAt: "2026-07-30T12:00:00.000Z",
    relevanceScore: 0.5,
    engagementScore: null,
    rawPayload: {},
  };

  it("creates a mention on first ingest", async () => {
    const created = await data.mentions.create(ushg.admin(), baseInput);
    expect(created.externalId).toBe("dedupe-test-1");
    expect(created.title).toBe("First fetch");
  });

  it("updates rather than duplicating on re-ingest", async () => {
    const before = await data.mentions.list(ushg.admin());

    await data.mentions.create(ushg.admin(), baseInput);
    await data.mentions.create(ushg.admin(), {
      ...baseInput,
      title: "Second fetch",
      content: "The room was lovely, and the wine list is excellent.",
    });

    const after = await data.mentions.list(ushg.admin());

    // One new row, not two: re-syncing is idempotent.
    expect(after.length).toBe(before.length + 1);

    const stored = after.find((row) => row.externalId === "dedupe-test-1");
    expect(stored?.title).toBe("Second fetch");
  });

  it("treats the same external id on a different source type as distinct", async () => {
    await data.mentions.create(ushg.admin(), baseInput);
    await data.mentions.create(ushg.admin(), {
      ...baseInput,
      sourceType: "yelp_review",
    });

    const rows = await data.mentions.list(ushg.admin(), { search: "lovely" });
    expect(rows.filter((row) => row.externalId === "dedupe-test-1")).toHaveLength(2);
  });

  it("rejects a payload that fails validation", async () => {
    await expect(
      data.mentions.create(ushg.admin(), { ...baseInput, rating: 42 }),
    ).rejects.toThrow(/could not be stored/i);
  });
});

describe("response draft approval transitions", () => {
  async function draftAwaitingApproval() {
    const drafts = await data.responseDrafts.list(ushg.admin(), {
      statuses: ["awaiting_approval"],
    });
    const draft = drafts[0];
    expect(draft).toBeDefined();
    return draft!;
  }

  it("approves a draft and records the approver", async () => {
    const draft = await draftAwaitingApproval();

    const { draft: updated, approval } = await data.responseDrafts.decide(
      ushg.approver(),
      draft.id,
      "approved",
      USER_MARCUS,
    );

    expect(updated.status).toBe("approved");
    expect(updated.approvedByUserId).toBe(USER_MARCUS);
    expect(updated.approvedAt).not.toBeNull();
    expect(approval?.status).toBe("approved");
  });

  it("returns a draft with requested changes to draft status with no approver", async () => {
    const draft = await draftAwaitingApproval();

    const { draft: updated, approval } = await data.responseDrafts.decide(
      ushg.approver(),
      draft.id,
      "changes_requested",
      USER_MARCUS,
      "Resolve the refund first.",
    );

    expect(updated.status).toBe("draft");
    expect(updated.approvedByUserId).toBeNull();
    expect(approval?.status).toBe("changes_requested");
    expect(approval?.decisionNote).toBe("Resolve the refund first.");
  });

  it("refuses to decide twice on the same draft", async () => {
    const draft = await draftAwaitingApproval();
    await data.responseDrafts.decide(ushg.approver(), draft.id, "approved", USER_MARCUS);

    await expect(
      data.responseDrafts.decide(ushg.approver(), draft.id, "changes_requested", USER_MARCUS),
    ).rejects.toThrow(/cannot be decided again/i);
  });

  it("refuses to decide on an already published response", async () => {
    const [published] = await data.responseDrafts.list(ushg.admin(), {
      statuses: ["published"],
    });

    await expect(
      data.responseDrafts.decide(ushg.approver(), published!.id, "changes_requested", USER_MARCUS),
    ).rejects.toThrow(/cannot be decided again/i);
  });

  it("assigns a draft to an active member", async () => {
    const draft = await draftAwaitingApproval();
    const updated = await data.responseDrafts.assign(ushg.admin(), draft.id, USER_MARCUS);
    expect(updated.assignedUserId).toBe(USER_MARCUS);
  });

  it("refuses an assignee from another organization", async () => {
    const draft = await draftAwaitingApproval();
    await expect(
      data.responseDrafts.assign(ushg.admin(), draft.id, USER_SOFIA),
    ).rejects.toThrow(/not an active member/i);
  });
});

describe("escalation status transitions", () => {
  it("moves an open case to in progress", async () => {
    const [escalation] = await data.escalations.list(ushg.admin(), { statuses: ["open"] });

    const updated = await data.escalations.updateStatus(
      ushg.comms(),
      escalation!.id,
      "in_progress",
    );

    expect(updated.status).toBe("in_progress");
    expect(updated.resolvedAt).toBeNull();
  });

  it("requires a resolution note to resolve", async () => {
    const [escalation] = await data.escalations.list(ushg.admin(), { statuses: ["open"] });

    await expect(
      data.escalations.updateStatus(ushg.comms(), escalation!.id, "resolved"),
    ).rejects.toThrow(/resolution note/i);
  });

  it("stamps resolvedAt when a case closes with a note", async () => {
    const [escalation] = await data.escalations.list(ushg.admin(), { statuses: ["open"] });

    const updated = await data.escalations.updateStatus(
      ushg.comms(),
      escalation!.id,
      "resolved",
      "Refund processed and confirmed with the guest.",
    );

    expect(updated.status).toBe("resolved");
    expect(updated.resolvedAt).not.toBeNull();
    expect(updated.resolutionNote).toContain("Refund processed");
  });

  it("orders the queue worst severity first", async () => {
    const queue = await data.escalations.list(ushg.admin());
    const severity = { critical: 0, high: 1, medium: 2, low: 3 } as const;
    const ranks = queue.map((row) => severity[row.severity]);
    expect([...ranks].sort((a, b) => a - b)).toEqual(ranks);
  });
});

describe("automation rule enable and disable", () => {
  it("disables an active rule", async () => {
    const [active] = await data.automationRules.list(ushg.admin(), {
      statuses: ["active"],
    });

    const updated = await data.automationRules.setEnabled(ushg.admin(), active!.id, false);
    expect(updated.status).toBe("inactive");
  });

  it("re-enables a rule that passes readiness", async () => {
    // media-watch — the only seeded inactive rule — carries a `notify`
    // action, which is not executable, so it can no longer stand in here
    // (see the refusal case below). escalate-high-risk is active with a
    // fresh simulation, so disabling then re-enabling it round-trips cleanly.
    const active = await findRuleByName("Escalate high-risk mentions");

    const disabled = await data.automationRules.setEnabled(ushg.admin(), active.id, false);
    expect(disabled.status).toBe("inactive");

    const reenabled = await data.automationRules.setEnabled(ushg.admin(), active.id, true);
    expect(reenabled.status).toBe("active");
  });

  it("refuses to re-enable a rule with unexecutable actions", async () => {
    const mediaWatch = await findRuleByName("Flag high-authority media coverage");
    expect(mediaWatch.status).toBe("inactive");

    await expect(
      data.automationRules.setEnabled(ushg.admin(), mediaWatch.id, true),
    ).rejects.toThrow(/notification/i);
  });

  it("refuses to enable a draft rule", async () => {
    const [draft] = await data.automationRules.list(ushg.admin(), { statuses: ["draft"] });

    await expect(
      data.automationRules.setEnabled(ushg.admin(), draft!.id, true),
    ).rejects.toThrow(/simulate/i);
  });

  it("orders rules by priority", async () => {
    const rules = await data.automationRules.list(ushg.admin());
    const priorities = rules.map((rule) => rule.priority);
    expect([...priorities].sort((a, b) => a - b)).toEqual(priorities);
  });
});

describe("location manager assignment", () => {
  it("assigns a manager who is an active member", async () => {
    const updated = await data.locations.updateManager(
      ushg.admin(),
      LOC_SOHO,
      USER_MARCUS,
    );
    expect(updated.managerUserId).toBe(USER_MARCUS);
  });

  it("clears the manager", async () => {
    const updated = await data.locations.updateManager(ushg.admin(), LOC_SOHO, null);
    expect(updated.managerUserId).toBeNull();
  });

  it("refuses a manager from another organization", async () => {
    await expect(
      data.locations.updateManager(ushg.admin(), LOC_SOHO, USER_SOFIA),
    ).rejects.toThrow(/not an active member/i);
  });
});

describe("metrics", () => {
  it("counts only this organization's mentions", async () => {
    const metrics = await data.mentions.metrics(ushg.admin());
    const mentions = await data.mentions.list(ushg.admin());
    expect(metrics.totalMentions).toBe(mentions.length);
  });

  it("excludes deliberate no-action rows from response coverage", async () => {
    const metrics = await data.mentions.metrics(ushg.admin());
    expect(metrics.responseCoveragePercent).toBeGreaterThanOrEqual(0);
    expect(metrics.responseCoveragePercent).toBeLessThanOrEqual(100);
  });

  it("produces a source mix that sums to the mention total", async () => {
    const metrics = await data.mentions.metrics(ushg.admin());
    const summed = metrics.sourceMix.reduce((total, entry) => total + entry.count, 0);
    expect(summed).toBe(metrics.totalMentions);
  });

  it("returns a full trend window", async () => {
    const metrics = await data.mentions.metrics(ushg.admin());
    expect(metrics.sentimentTrend).toHaveLength(30);
  });
});

describe("brand voice", () => {
  const input = {
    name: "Maison Laurent voice",
    axes: { warmth: 60, detail: 40, formality: 55, confidence: 44, hospitality: 35 },
    approvedPhrases: ["thank you for sharing"],
    prohibitedPhrases: ["not our fault"],
  };

  it("reads the seeded profile", async () => {
    const profile = await data.brandVoice.get(ushg.admin());
    expect(profile?.id).toBe(BRAND_VOICE_USHG);
    expect(profile?.version).toBe(1);
  });

  it("returns null for an organization that has never configured one", async () => {
    // Absence is normal: provisioning does not create a row, so this is what
    // every organization looks like until somebody presses Save.
    expect(await data.brandVoice.get(harbor.owner())).toBeNull();
  });

  it("inserts at version 1 on the first save", async () => {
    const saved = await data.brandVoice.save(harbor.owner(), input);
    expect(saved.version).toBe(1);
    expect(saved.organizationId).toBe(ORG_HARBOR);
    expect(saved.name).toBe("Maison Laurent voice");
  });

  it("bumps the version when something changes", async () => {
    const before = await data.brandVoice.get(ushg.admin());
    const saved = await data.brandVoice.save(ushg.admin(), input);
    expect(saved.version).toBe((before?.version ?? 0) + 1);
  });

  it("leaves the version alone when nothing changes", async () => {
    // response_drafts.brand_voice_version records which voice produced a draft.
    // Bumping on a no-op would invalidate the provenance of every existing
    // draft because somebody pressed Save twice.
    const first = await data.brandVoice.save(ushg.admin(), input);
    const second = await data.brandVoice.save(ushg.admin(), input);

    expect(second.version).toBe(first.version);
    expect(second.updatedAt).toBe(first.updatedAt);
  });

  it("treats a reordered phrase list as a change", async () => {
    await data.brandVoice.save(ushg.admin(), {
      ...input,
      approvedPhrases: ["one", "two"],
    });
    const reordered = await data.brandVoice.save(ushg.admin(), {
      ...input,
      approvedPhrases: ["two", "one"],
    });
    expect(reordered.approvedPhrases).toEqual(["two", "one"]);
  });

  it("records who saved it", async () => {
    const saved = await data.brandVoice.save(ushg.comms(), input);
    expect(saved.updatedByUserId).toBe(ushg.comms().userId);
  });

  it("does not leak one organization's voice into another", async () => {
    await data.brandVoice.save(harbor.owner(), { ...input, name: "Harbor voice" });
    const ushgProfile = await data.brandVoice.get(ushg.admin());
    expect(ushgProfile?.name).not.toBe("Harbor voice");
  });

  it("rejects a phrase listed in both the approved and prohibited lists", async () => {
    await expect(
      data.brandVoice.save(harbor.owner(), {
        ...input,
        approvedPhrases: ["thank you"],
        prohibitedPhrases: ["thank you"],
      }),
    ).rejects.toThrow();
  });

  it("dedupes phrases differing only in case, keeping the first spelling", async () => {
    const saved = await data.brandVoice.save(harbor.owner(), {
      ...input,
      approvedPhrases: ["Thank You", "thank you"],
    });
    expect(saved.approvedPhrases).toEqual(["Thank You"]);
  });

  it("rejects a phrase over 80 characters", async () => {
    await expect(
      data.brandVoice.save(harbor.owner(), {
        ...input,
        approvedPhrases: ["a".repeat(81)],
      }),
    ).rejects.toThrow();
  });
});
