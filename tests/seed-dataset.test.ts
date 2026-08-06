import { describe, expect, it } from "vitest";
import {
  approvalSchema,
  auditEventSchema,
  automationRuleSchema,
  brandVoiceProfileSchema,
  escalationSchema,
  isAutoPublishSafe,
  locationSchema,
  membershipSchema,
  mentionAnalysisSchema,
  mentionSchema,
  monitoringQuerySchema,
  organizationSchema,
  platformConnectionSchema,
  platformProfileSchema,
  responseDraftSchema,
  userSchema,
} from "@/domain";
import { ORG_HARBOR, ORG_USHG, SEED_DATASET } from "@/lib/seed/dataset";
import { seedId } from "@/lib/seed/ids";

/**
 * The seed dataset is the fixture every other suite builds on, and it becomes
 * `supabase/seed.sql`. If it does not satisfy the domain schemas and its own
 * foreign keys, nothing downstream can be trusted.
 */

describe("seed ids", () => {
  it("are deterministic", () => {
    expect(seedId("org:ushg")).toBe(seedId("org:ushg"));
  });

  it("are well-formed UUIDs", () => {
    const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    expect(seedId("mention:example")).toMatch(uuid);
  });

  it("do not collide across a large label space", () => {
    const ids = new Set(
      Array.from({ length: 5_000 }, (_, index) => seedId(`label-${index}`)),
    );
    expect(ids.size).toBe(5_000);
  });
});

describe("seed dataset validation", () => {
  const cases = [
    ["organizations", organizationSchema, SEED_DATASET.organizations],
    ["users", userSchema, SEED_DATASET.users],
    ["memberships", membershipSchema, SEED_DATASET.memberships],
    ["locations", locationSchema, SEED_DATASET.locations],
    ["platformConnections", platformConnectionSchema, SEED_DATASET.platformConnections],
    ["platformProfiles", platformProfileSchema, SEED_DATASET.platformProfiles],
    ["mentions", mentionSchema, SEED_DATASET.mentions],
    ["mentionAnalyses", mentionAnalysisSchema, SEED_DATASET.mentionAnalyses],
    ["monitoringQueries", monitoringQuerySchema, SEED_DATASET.monitoringQueries],
    ["responseDrafts", responseDraftSchema, SEED_DATASET.responseDrafts],
    ["approvals", approvalSchema, SEED_DATASET.approvals],
    ["escalations", escalationSchema, SEED_DATASET.escalations],
    ["automationRules", automationRuleSchema, SEED_DATASET.automationRules],
    ["auditEvents", auditEventSchema, SEED_DATASET.auditEvents],
  ] as const;

  for (const [name, schema, rows] of cases) {
    it(`${name} satisfy the domain schema`, () => {
      for (const row of rows) {
        const result = schema.safeParse(row);
        if (!result.success) {
          throw new Error(
            `${name} row failed validation:\n${JSON.stringify(result.error.issues, null, 2)}`,
          );
        }
      }
      expect(rows.length).toBeGreaterThan(0);
    });
  }
});

describe("seed dataset coverage", () => {
  const ushgMentions = SEED_DATASET.mentions.filter(
    (mention) => mention.organizationId === ORG_USHG,
  );

  it("has at least 20 mentions in the primary organization", () => {
    expect(ushgMentions.length).toBeGreaterThanOrEqual(20);
  });

  it("covers every sentiment", () => {
    const sentiments = new Set(ushgMentions.map((mention) => mention.sentiment));
    expect(sentiments).toContain("positive");
    expect(sentiments).toContain("neutral");
    expect(sentiments).toContain("negative");
    expect(sentiments).toContain("mixed");
  });

  it("covers every risk level", () => {
    const risks = new Set(ushgMentions.map((mention) => mention.riskLevel));
    expect(risks).toEqual(new Set(["low", "medium", "high", "critical"]));
  });

  it("covers reviews, discussions, news, and article comments", () => {
    const sources = new Set(ushgMentions.map((mention) => mention.sourceType));
    expect(sources).toContain("google_review");
    expect(sources).toContain("yelp_review");
    expect(sources).toContain("reddit_post");
    expect(sources).toContain("news_article");
    expect(sources).toContain("article_comment");
  });

  it("has at least five locations, five escalations, and six rules", () => {
    expect(
      SEED_DATASET.locations.filter((row) => row.organizationId === ORG_USHG).length,
    ).toBeGreaterThanOrEqual(5);
    expect(
      SEED_DATASET.escalations.filter((row) => row.organizationId === ORG_USHG).length,
    ).toBeGreaterThanOrEqual(5);
    expect(
      SEED_DATASET.automationRules.filter((row) => row.organizationId === ORG_USHG).length,
    ).toBeGreaterThanOrEqual(6);
  });

  it("has four users holding distinct roles in the primary organization", () => {
    const roles = new Set(
      SEED_DATASET.memberships
        .filter((row) => row.organizationId === ORG_USHG)
        .map((row) => row.role),
    );
    expect(roles.size).toBeGreaterThanOrEqual(4);
  });

  it("has response drafts in several statuses", () => {
    const statuses = new Set(
      SEED_DATASET.responseDrafts
        .filter((row) => row.organizationId === ORG_USHG)
        .map((row) => row.status),
    );
    expect(statuses.size).toBeGreaterThanOrEqual(4);
  });

  it("includes a second organization so isolation is testable", () => {
    expect(
      SEED_DATASET.mentions.some((row) => row.organizationId === ORG_HARBOR),
    ).toBe(true);
  });

  it("gives one user membership in two organizations", () => {
    const counts = new Map<string, number>();
    for (const row of SEED_DATASET.memberships) {
      counts.set(row.userId, (counts.get(row.userId) ?? 0) + 1);
    }
    expect([...counts.values()].some((count) => count > 1)).toBe(true);
  });

  it("seeds monitoring queries for both tenants", () => {
    const orgs = new Set(SEED_DATASET.monitoringQueries.map((q) => q.organizationId));
    expect(orgs.size).toBeGreaterThanOrEqual(2);
    expect(SEED_DATASET.monitoringQueries.length).toBeGreaterThanOrEqual(3);
  });

  it("attaches every seeded news mention to a seeded monitoring query", () => {
    const ids = new Set(SEED_DATASET.monitoringQueries.map((q) => q.id));
    const news = SEED_DATASET.mentions.filter((m) => m.sourceType === "news_article");
    expect(news.length).toBeGreaterThan(0);
    for (const mention of news) {
      expect(ids.has(mention.monitoringQueryId ?? "")).toBe(true);
    }
  });
});

describe("seed dataset referential integrity", () => {
  const organizationIds = new Set(SEED_DATASET.organizations.map((row) => row.id));
  const userIds = new Set(SEED_DATASET.users.map((row) => row.id));
  const locationIds = new Set(SEED_DATASET.locations.map((row) => row.id));
  const connectionIds = new Set(SEED_DATASET.platformConnections.map((row) => row.id));
  const profileIds = new Set(SEED_DATASET.platformProfiles.map((row) => row.id));
  const mentionIds = new Set(SEED_DATASET.mentions.map((row) => row.id));
  const draftIds = new Set(SEED_DATASET.responseDrafts.map((row) => row.id));

  it("points every organizationId at a real organization", () => {
    const owned = [
      ...SEED_DATASET.memberships,
      ...SEED_DATASET.locations,
      ...SEED_DATASET.platformConnections,
      ...SEED_DATASET.platformProfiles,
      ...SEED_DATASET.mentions,
      ...SEED_DATASET.mentionAnalyses,
      ...SEED_DATASET.responseDrafts,
      ...SEED_DATASET.approvals,
      ...SEED_DATASET.escalations,
      ...SEED_DATASET.automationRules,
      ...SEED_DATASET.auditEvents,
      ...SEED_DATASET.monitoringQueries,
    ];
    for (const row of owned) {
      expect(organizationIds.has(row.organizationId)).toBe(true);
    }
  });

  it("resolves every user reference", () => {
    for (const row of SEED_DATASET.memberships) expect(userIds.has(row.userId)).toBe(true);
    for (const row of SEED_DATASET.locations) {
      if (row.managerUserId) expect(userIds.has(row.managerUserId)).toBe(true);
    }
    for (const row of SEED_DATASET.responseDrafts) {
      if (row.assignedUserId) expect(userIds.has(row.assignedUserId)).toBe(true);
      if (row.approvedByUserId) expect(userIds.has(row.approvedByUserId)).toBe(true);
    }
    for (const row of SEED_DATASET.escalations) {
      if (row.assignedUserId) expect(userIds.has(row.assignedUserId)).toBe(true);
    }
  });

  it("resolves every platform and location reference on mentions", () => {
    for (const row of SEED_DATASET.mentions) {
      expect(connectionIds.has(row.platformConnectionId)).toBe(true);
      if (row.locationId) expect(locationIds.has(row.locationId)).toBe(true);
      if (row.platformProfileId) expect(profileIds.has(row.platformProfileId)).toBe(true);
    }
  });

  it("resolves every monitoring query's location, and every mention's monitoringQueryId", () => {
    const monitoringQueryIds = new Set(SEED_DATASET.monitoringQueries.map((row) => row.id));
    for (const row of SEED_DATASET.monitoringQueries) {
      if (row.locationId) expect(locationIds.has(row.locationId)).toBe(true);
    }
    for (const row of SEED_DATASET.mentions) {
      if (row.monitoringQueryId) expect(monitoringQueryIds.has(row.monitoringQueryId)).toBe(true);
    }
  });

  it("agrees a location-bound monitoring query's locationId with any mention it found", () => {
    // Mirrors src/lib/monitoring/poll-service.ts, which sets a new mention's
    // locationId from its query's locationId — so a seeded mention and the
    // query it is attributed to must not disagree about which location a
    // real poll would have produced.
    const queryLocation = new Map(
      SEED_DATASET.monitoringQueries.map((row) => [row.id, row.locationId]),
    );
    for (const row of SEED_DATASET.mentions) {
      if (!row.monitoringQueryId) continue;
      expect(queryLocation.get(row.monitoringQueryId)).toBe(row.locationId);
    }
  });

  it("resolves every mention and draft reference", () => {
    for (const row of SEED_DATASET.mentionAnalyses) expect(mentionIds.has(row.mentionId)).toBe(true);
    for (const row of SEED_DATASET.responseDrafts) expect(mentionIds.has(row.mentionId)).toBe(true);
    for (const row of SEED_DATASET.escalations) expect(mentionIds.has(row.mentionId)).toBe(true);
    for (const row of SEED_DATASET.approvals) expect(draftIds.has(row.responseDraftId)).toBe(true);
  });

  it("keeps child rows in the same organization as their parent", () => {
    const mentionOrg = new Map(SEED_DATASET.mentions.map((row) => [row.id, row.organizationId]));
    for (const row of SEED_DATASET.responseDrafts) {
      expect(mentionOrg.get(row.mentionId)).toBe(row.organizationId);
    }
    for (const row of SEED_DATASET.escalations) {
      expect(mentionOrg.get(row.mentionId)).toBe(row.organizationId);
    }
    const queryOrg = new Map(
      SEED_DATASET.monitoringQueries.map((row) => [row.id, row.organizationId]),
    );
    for (const row of SEED_DATASET.mentions) {
      if (row.monitoringQueryId) {
        expect(queryOrg.get(row.monitoringQueryId)).toBe(row.organizationId);
      }
    }
  });

  it("keeps external ids unique per connection and source type", () => {
    const seen = new Set<string>();
    for (const row of SEED_DATASET.mentions) {
      const key = `${row.platformConnectionId}:${row.sourceType}:${row.externalId}`;
      expect(seen.has(key)).toBe(false);
      seen.add(key);
    }
  });
});

describe("automation guardrails", () => {
  it("never lets a seeded rule auto-publish risky content", () => {
    for (const rule of SEED_DATASET.automationRules) {
      expect(isAutoPublishSafe(rule)).toBe(true);
    }
  });
});

describe("brand voice seed", () => {
  it("gives the primary organization exactly one profile", () => {
    const owned = SEED_DATASET.brandVoiceProfiles.filter(
      (profile) => profile.organizationId === ORG_USHG,
    );
    expect(owned).toHaveLength(1);
  });

  it("holds at most one profile per organization", () => {
    const seen = new Set<string>();
    for (const profile of SEED_DATASET.brandVoiceProfiles) {
      expect(seen.has(profile.organizationId)).toBe(false);
      seen.add(profile.organizationId);
    }
  });

  it("seeds values that satisfy the domain schema", () => {
    for (const profile of SEED_DATASET.brandVoiceProfiles) {
      expect(() => brandVoiceProfileSchema.parse(profile)).not.toThrow();
    }
  });
});
