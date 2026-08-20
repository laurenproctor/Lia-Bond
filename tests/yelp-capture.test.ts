import { beforeEach, describe, expect, it } from "vitest";
import { createDemoDataSource } from "@/lib/data/demo";
import { demoStore, resetDemoStore } from "@/lib/data/demo/store";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import { captureYelpReview } from "@/lib/yelp/capture";
import {
  deriveOverriddenCaptureKey,
  deriveYelpCaptureKey,
} from "@/lib/yelp/dedupe";

/**
 * Manual review capture.
 *
 * The two things under test are the provenance (a typed review must never be
 * storable as an imported one) and the deduplication contract (nothing merges
 * silently, nothing is refused without a way forward).
 */

let dataSource: LiaDataSource;
let scope: OrganizationScope;
let otherScope: OrganizationScope;
let profileId: string;
let connectionId: string;
const NOW = "2026-08-18T12:00:00.000Z";

beforeEach(() => {
  resetDemoStore();
  dataSource = createDemoDataSource();

  const store = demoStore();
  const [organization, second] = store.organizations;
  const user = store.users[0];
  if (!organization || !second || !user) throw new Error("seed fixtures missing");

  scope = { organizationId: organization.id, userId: user.id, role: "owner" };
  otherScope = { organizationId: second.id, userId: user.id, role: "owner" };

  const profile = store.platformProfiles.find(
    (row) => row.organizationId === organization.id,
  );
  if (!profile) throw new Error("seed has no platform profile");
  profileId = profile.id;
  connectionId = profile.platformConnectionId;
});

function capture(overrides: Record<string, unknown> = {}) {
  return captureYelpReview({
    dataSource,
    scope,
    actorUserId: scope.userId,
    now: NOW,
    input: {
      platformProfileId: profileId,
      sourceType: "yelp_review",
      rating: 2,
      content: "Waited forty minutes for a table we had booked.",
      authorName: "Dana R.",
      reviewedOn: "2026-08-17",
      confirmDistinct: false,
      ...overrides,
    } as never,
  });
}

/* -------------------------------------------------------------------------- */
/* Provenance                                                                  */
/* -------------------------------------------------------------------------- */

describe("provenance", () => {
  it("marks the review as manually entered, with its typist and moment", async () => {
    const { outcome, mention } = await capture();

    expect(outcome).toBe("captured");
    expect(mention.captureMethod).toBe("manual_entry");
    expect(mention.capturedByUserId).toBe(scope.userId);
    expect(mention.capturedAt).toBe(NOW);
  });

  it("stores it as a Yelp review under the connected listing", async () => {
    const { mention } = await capture();

    expect(mention.sourceType).toBe("yelp_review");
    expect(mention.platformProfileId).toBe(profileId);
    expect(mention.platformConnectionId).toBe(connectionId);
  });

  it("stamps the actor from the session, not from the payload", async () => {
    // The field does not exist on the input schema, so a crafted request
    // cannot attribute the typing to somebody else. Passing one is ignored.
    const { mention } = await capture({
      capturedByUserId: "00000000-0000-4000-8000-999999999999",
    });

    expect(mention.capturedByUserId).toBe(scope.userId);
  });

  it("enters the pipeline as an ordinary new mention", async () => {
    const { mention } = await capture();

    // Status `new` is what makes the analysis sweep pick it up, which is what
    // gives a typed review the same classification, routing, and escalation
    // eligibility as an imported one.
    expect(mention.status).toBe("new");
    expect(mention.relevanceScore).toBeNull();

    const unanalyzed = await dataSource.mentions.listUnanalyzed(scope, 50);
    expect(unanalyzed.some((row) => row.id === mention.id)).toBe(true);
  });

  it("records an audit event that names the capture but not the review text", async () => {
    const { mention } = await capture();

    const events = await dataSource.auditEvents.list(scope, { limit: 50 });
    const event = events.find((e) => e.eventType === "mention.captured_manually");

    expect(event?.entityId).toBe(mention.id);
    expect(JSON.stringify(event)).not.toContain("forty minutes");
  });
});

/* -------------------------------------------------------------------------- */
/* Validation                                                                  */
/* -------------------------------------------------------------------------- */

describe("validation", () => {
  it("refuses a source type that cannot be captured by hand", async () => {
    await expect(capture({ sourceType: "news_article" })).rejects.toThrow();
  });

  it("refuses a rating outside one to five", async () => {
    await expect(capture({ rating: 0 })).rejects.toThrow();
    await expect(capture({ rating: 6 })).rejects.toThrow();
  });

  it("refuses empty content", async () => {
    await expect(capture({ content: "" })).rejects.toThrow();
  });

  it("refuses a non-Yelp review URL rather than storing it", async () => {
    // Validated at write time, not at render time: a hostile URL must not sit
    // in the database waiting for somebody to click it.
    await expect(
      capture({ reviewUrl: "https://evil.test/biz/spoof" }),
    ).rejects.toThrow(/Yelp link/i);
  });

  it("stores a canonicalised review URL when one is supplied", async () => {
    const { mention } = await capture({
      reviewUrl: "https://www.yelp.com/biz/example?utm_source=share",
    });

    expect(mention.sourceUrl).toBe("https://www.yelp.com/biz/example");
  });

  it("refuses a listing belonging to another organization", async () => {
    // The scope filter is the boundary: the profile id is real, but not in
    // this tenant.
    await expect(
      captureYelpReview({
        dataSource,
        scope: otherScope,
        actorUserId: otherScope.userId,
        now: NOW,
        input: {
          platformProfileId: profileId,
          sourceType: "yelp_review",
          rating: 4,
          content: "Lovely evening.",
          confirmDistinct: false,
        } as never,
      }),
    ).rejects.toThrow(/not found/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Deduplication                                                               */
/* -------------------------------------------------------------------------- */

describe("the deduplication key", () => {
  it("prefers a normalised review URL over the fingerprint", () => {
    const key = deriveYelpCaptureKey({
      reviewUrl: "https://www.yelp.com/biz/example?utm_source=x",
      rating: 4,
      content: "Great",
    });
    expect(key.basis).toBe("review_url");
    expect(key.externalId.startsWith("url:")).toBe(true);
  });

  it("gives the same key for the same URL written two ways", () => {
    const a = deriveYelpCaptureKey({
      reviewUrl: "https://www.yelp.com/biz/example?utm_source=share",
      rating: 4,
      content: "Great",
    });
    const b = deriveYelpCaptureKey({
      reviewUrl: "https://WWW.YELP.COM/biz/example/#reviews",
      rating: 4,
      content: "Great",
    });
    expect(a.externalId).toBe(b.externalId);
  });

  it("falls back to a fingerprint when there is no URL", () => {
    const key = deriveYelpCaptureKey({ rating: 4, content: "Great" });
    expect(key.basis).toBe("fingerprint");
    expect(key.externalId.startsWith("manual:")).toBe(true);
  });

  it("ignores punctuation, casing, and smart quotes in the fingerprint", () => {
    const a = deriveYelpCaptureKey({ rating: 4, content: "It's great!" });
    const b = deriveYelpCaptureKey({ rating: 4, content: "  it’s   GREAT  " });
    expect(a.externalId).toBe(b.externalId);
  });

  it("separates two diners who wrote the same short review", () => {
    const a = deriveYelpCaptureKey({ rating: 5, content: "Great!", authorName: "Dana" });
    const b = deriveYelpCaptureKey({ rating: 5, content: "Great!", authorName: "Sam" });
    expect(a.externalId).not.toBe(b.externalId);
  });

  it("separates a repeat visitor's two similar reviews by date", () => {
    const a = deriveYelpCaptureKey({ rating: 5, content: "Great", reviewedOn: "2026-01-01" });
    const b = deriveYelpCaptureKey({ rating: 5, content: "Great", reviewedOn: "2026-06-01" });
    expect(a.externalId).not.toBe(b.externalId);
  });

  it("separates the same words at different ratings", () => {
    const a = deriveYelpCaptureKey({ rating: 1, content: "Fine" });
    const b = deriveYelpCaptureKey({ rating: 5, content: "Fine" });
    expect(a.externalId).not.toBe(b.externalId);
  });

  it("derives an override key deterministically, so a retry cannot triple", () => {
    const base = deriveYelpCaptureKey({ rating: 4, content: "Great" });
    expect(deriveOverriddenCaptureKey(base, NOW)).toBe(
      deriveOverriddenCaptureKey(base, NOW),
    );
    expect(deriveOverriddenCaptureKey(base, NOW)).not.toBe(base.externalId);
  });
});

describe("duplicate handling", () => {
  it("reports a duplicate rather than creating a second review", async () => {
    const first = await capture();
    const second = await capture();

    expect(second.outcome).toBe("duplicate");
    // Hands back the review Lia already holds, so the interface can show it.
    expect(second.mention.id).toBe(first.mention.id);
    expect(second.duplicateBasis).toBe("fingerprint");
  });

  it("does not merge silently — nothing about the stored review changes", async () => {
    const first = await capture();
    await capture({ content: "Waited forty minutes for a table we had booked." });

    const stored = await dataSource.mentions.get(scope, first.mention.id);
    expect(stored?.content).toBe(first.mention.content);
  });

  it("creates a second review when the override is set deliberately", async () => {
    const first = await capture();
    const second = await capture({ confirmDistinct: true });

    expect(second.outcome).toBe("captured");
    expect(second.mention.id).not.toBe(first.mention.id);
  });

  it("records the override in the audit trail", async () => {
    await capture();
    await capture({ confirmDistinct: true });

    const events = await dataSource.auditEvents.list(scope, { limit: 50 });
    const overrides = events.filter(
      (e) =>
        e.eventType === "mention.captured_manually" &&
        e.metadata?.overrodeDuplicate === true,
    );
    expect(overrides).toHaveLength(1);
  });

  it("treats two different reviews as distinct with no override needed", async () => {
    await capture();
    const other = await capture({ content: "Completely different experience.", authorName: "Sam" });

    expect(other.outcome).toBe("captured");
  });

  it("reports the URL basis when that is how the duplicate was found", async () => {
    const url = "https://www.yelp.com/biz/example";
    await capture({ reviewUrl: url });
    // Different text, same review URL — still the same review.
    const second = await capture({ reviewUrl: url, content: "Different words entirely." });

    expect(second.outcome).toBe("duplicate");
    expect(second.duplicateBasis).toBe("review_url");
  });
});

/* -------------------------------------------------------------------------- */
/* Activity occurrences                                                        */
/* -------------------------------------------------------------------------- */

describe("capturing against a detected change", () => {
  async function openOccurrence() {
    const older = await dataSource.yelpListingSnapshots.record(scope, {
      platformProfileId: profileId,
      syncRunId: null,
      observedAt: "2026-08-17T12:00:00.000Z",
      reviewCount: 128,
      rating: 4.5,
      isClosed: false,
    });
    const newer = await dataSource.yelpListingSnapshots.record(scope, {
      platformProfileId: profileId,
      syncRunId: null,
      observedAt: "2026-08-18T11:00:00.000Z",
      reviewCount: 129,
      rating: 4.5,
      isClosed: false,
    });
    const { occurrence } = await dataSource.yelpActivityOccurrences.record(scope, {
      platformProfileId: profileId,
      locationId: null,
      fromSnapshotId: older.id,
      toSnapshotId: newer.id,
      detectedAt: "2026-08-18T11:00:00.000Z",
      changeKind: "count_increased",
      previousReviewCount: 128,
      currentReviewCount: 129,
      previousRating: 4.5,
      currentRating: 4.5,
    });
    return occurrence;
  }

  it("links the review to the occurrence and closes it as captured", async () => {
    const occurrence = await openOccurrence();
    const { mention } = await capture({ activityOccurrenceId: occurrence.id });

    expect(mention.yelpActivityOccurrenceId).toBe(occurrence.id);

    const resolved = await dataSource.yelpActivityOccurrences.get(scope, occurrence.id);
    expect(resolved?.status).toBe("captured");
    expect(resolved?.capturedMentionId).toBe(mention.id);
  });

  it("leaves the occurrence open when no review is captured against it", async () => {
    const occurrence = await openOccurrence();
    await capture();

    const untouched = await dataSource.yelpActivityOccurrences.get(scope, occurrence.id);
    expect(untouched?.status).toBe("open");
  });

  it("refuses to resolve an occurrence twice", async () => {
    const occurrence = await openOccurrence();
    await capture({ activityOccurrenceId: occurrence.id });

    // Two people answering the same notice must not both succeed — the second
    // is told it is handled rather than overwriting who dealt with it.
    await expect(
      capture({ activityOccurrenceId: occurrence.id, confirmDistinct: true }),
    ).rejects.toThrow(/already been handled/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Structural guarantees                                                       */
/* -------------------------------------------------------------------------- */

describe("a synchronisation cannot touch capture provenance", () => {
  it("has no field for it on IngestMentionInput", async () => {
    // The structural half of D182. A comment saying "syncs must not set this"
    // is a rule somebody has to remember; a type with no such field is not.
    const { ingestMentionInputSchema } = await import("@/domain");
    const keys = Object.keys(
      (ingestMentionInputSchema as unknown as { shape: Record<string, unknown> }).shape,
    );

    for (const field of [
      "captureMethod",
      "capturedByUserId",
      "capturedAt",
      "yelpActivityOccurrenceId",
    ]) {
      expect(keys).not.toContain(field);
    }
  });

  it("does not list it among the fields a sync owns", async () => {
    const { SOURCE_OWNED_MENTION_FIELDS } = await import("@/domain");
    const owned = SOURCE_OWNED_MENTION_FIELDS as readonly string[];

    for (const field of [
      "captureMethod",
      "capturedByUserId",
      "capturedAt",
      "yelpActivityOccurrenceId",
    ]) {
      expect(owned).not.toContain(field);
    }
  });

  it("leaves a captured review untouched when a sync ingests over it", async () => {
    // The behavioural half: an ingest that collides with a captured review's
    // external id must not be able to relabel it as provider-returned.
    const { mention } = await capture();

    await dataSource.mentions.ingest(scope, {
      locationId: mention.locationId,
      platformConnectionId: mention.platformConnectionId,
      platformProfileId: mention.platformProfileId,
      sourceType: "yelp_review",
      externalId: mention.externalId,
      externalParentId: null,
      sourceUrl: null,
      title: null,
      content: "Rewritten by a sync.",
      authorName: null,
      authorExternalId: null,
      rating: 5,
      language: null,
      publishedAt: mention.publishedAt,
      rawPayload: {},
      externalResourceName: null,
      authorAvatarUrl: null,
      authorIsAnonymous: false,
      sourceUpdatedAt: null,
      sourceReplyText: null,
      sourceReplyUpdatedAt: null,
      sourceMetadata: {},
      syncedAt: NOW,
      publisherName: null,
      publisherDomain: null,
      monitoringQueryId: null,
    } as never);

    const after = await dataSource.mentions.get(scope, mention.id);
    expect(after?.captureMethod).toBe("manual_entry");
    expect(after?.capturedByUserId).toBe(scope.userId);
  });
});
