import { beforeEach, describe, expect, it } from "vitest";
import { deriveYelpActivityChange } from "@/domain";
import { createDemoDataSource } from "@/lib/data/demo";
import { demoStore, resetDemoStore } from "@/lib/data/demo/store";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import { checkYelpListing } from "@/lib/yelp/check-service";
import { MockYelpProvider } from "@/yelp/mock-provider";
import { REFERENCE_NOW } from "@/lib/seed/clock";

/**
 * Review-activity detection.
 *
 * The properties under test are the ones that decide whether this feature ever
 * tells a customer something untrue. Every case below corresponds to a numbered
 * guarantee in `check-service.ts`'s own doc comment.
 */

let dataSource: LiaDataSource;
let scope: OrganizationScope;
let profile: { id: string; platformConnectionId: string; locationId: string | null; externalProfileId: string };

/** A distinct instant per check, so snapshots order deterministically. */
function minutesAfterReference(minutes: number): string {
  return new Date(Date.parse(REFERENCE_NOW) + minutes * 60_000).toISOString();
}

beforeEach(() => {
  resetDemoStore();
  dataSource = createDemoDataSource();

  const store = demoStore();
  const organization = store.organizations[0];
  const user = store.users[0];
  if (!organization || !user) throw new Error("seed fixtures missing");

  scope = { organizationId: organization.id, userId: user.id, role: "owner" };

  const seededProfile = store.platformProfiles.find(
    (row) => row.organizationId === organization.id,
  );
  if (!seededProfile) throw new Error("seed has no platform profile");

  // The seeded profile stands in for a connected Yelp listing: the check
  // service reads only its ids, and nothing here is Google-specific.
  profile = {
    id: seededProfile.id,
    platformConnectionId: seededProfile.platformConnectionId,
    locationId: seededProfile.locationId,
    externalProfileId: "mock-yelp-listing",
  };
});

/** Run one check against a scripted provider. */
async function check(
  provider: MockYelpProvider,
  now: string,
  trigger: "manual" | "scheduled" = "scheduled",
) {
  return checkYelpListing({
    dataSource,
    scope,
    // The service reads only these four fields off the profile.
    profile: profile as never,
    provider,
    trigger,
    actorUserId: trigger === "manual" ? scope.userId : null,
    now,
  });
}

/* -------------------------------------------------------------------------- */
/* The derivation rule                                                         */
/* -------------------------------------------------------------------------- */

describe("deriveYelpActivityChange", () => {
  it("reports nothing when neither counter moved", () => {
    expect(
      deriveYelpActivityChange({ reviewCount: 128, rating: 4.5 }, { reviewCount: 128, rating: 4.5 }),
    ).toBeNull();
  });

  it("names an increase and a decrease separately", () => {
    expect(
      deriveYelpActivityChange({ reviewCount: 128, rating: 4.5 }, { reviewCount: 129, rating: 4.5 }),
    ).toBe("count_increased");
    expect(
      deriveYelpActivityChange({ reviewCount: 128, rating: 4.5 }, { reviewCount: 127, rating: 4.5 }),
    ).toBe("count_decreased");
  });

  it("reports a rating-only move, which is what an edited review looks like", () => {
    expect(
      deriveYelpActivityChange({ reviewCount: 128, rating: 4.5 }, { reviewCount: 128, rating: 4.0 }),
    ).toBe("rating_only");
  });

  it("reports both when both moved", () => {
    expect(
      deriveYelpActivityChange({ reviewCount: 128, rating: 4.5 }, { reviewCount: 130, rating: 4.0 }),
    ).toBe("count_and_rating");
  });

  it("refuses to read a null counter as a change, in either direction", () => {
    // Yelp omitting a count is Lia failing to observe, not the listing moving.
    // Treating 128 → null as a decrease would announce that every review had
    // been deleted, off the back of a provider hiccup.
    expect(
      deriveYelpActivityChange({ reviewCount: 128, rating: 4.5 }, { reviewCount: null, rating: 4.5 }),
    ).toBeNull();
    expect(
      deriveYelpActivityChange({ reviewCount: null, rating: 4.5 }, { reviewCount: 128, rating: 4.5 }),
    ).toBeNull();
  });

  it("checks the rating's nullness independently of the count's", () => {
    expect(
      deriveYelpActivityChange({ reviewCount: 128, rating: null }, { reviewCount: 129, rating: 4.5 }),
    ).toBe("count_increased");
  });
});

/* -------------------------------------------------------------------------- */
/* Baseline                                                                    */
/* -------------------------------------------------------------------------- */

describe("the first check", () => {
  it("establishes a baseline and reports no activity", async () => {
    const provider = new MockYelpProvider().scriptListing("mock-yelp-listing", [
      { reviewCount: 128, rating: 4.5 },
    ]);

    const outcome = await check(provider, minutesAfterReference(1));

    expect(outcome.status).toBe("completed");
    expect(outcome.baselineEstablished).toBe(true);
    // The guarantee: Lia's own arrival is not review activity.
    expect(outcome.occurrence).toBeNull();
    expect(outcome.snapshot?.reviewCount).toBe(128);
  });

  it("writes no activity occurrence at all", async () => {
    const provider = new MockYelpProvider().scriptListing("mock-yelp-listing", [
      { reviewCount: 400, rating: 5 },
    ]);
    await check(provider, minutesAfterReference(1));

    expect(await dataSource.yelpActivityOccurrences.countOpen(scope)).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Detection                                                                   */
/* -------------------------------------------------------------------------- */

describe("subsequent checks", () => {
  it("records nothing when the listing is unchanged", async () => {
    const provider = new MockYelpProvider().scriptListing("mock-yelp-listing", [
      { reviewCount: 128, rating: 4.5 },
      { reviewCount: 128, rating: 4.5 },
    ]);

    await check(provider, minutesAfterReference(1));
    const second = await check(provider, minutesAfterReference(2));

    expect(second.status).toBe("completed");
    expect(second.occurrence).toBeNull();
    // The snapshot is still written: it is the evidence Lia was checking.
    expect(second.snapshot).not.toBeNull();
    expect(await dataSource.yelpActivityOccurrences.countOpen(scope)).toBe(0);
  });

  it("creates exactly one occurrence for a review-count increase", async () => {
    const provider = new MockYelpProvider().scriptListing("mock-yelp-listing", [
      { reviewCount: 128, rating: 4.5 },
      { reviewCount: 129, rating: 4.5 },
    ]);

    await check(provider, minutesAfterReference(1));
    const second = await check(provider, minutesAfterReference(2));

    expect(second.occurrence?.changeKind).toBe("count_increased");
    expect(second.occurrence?.previousReviewCount).toBe(128);
    expect(second.occurrence?.currentReviewCount).toBe(129);
    expect(second.occurrenceCreated).toBe(true);
    expect(await dataSource.yelpActivityOccurrences.countOpen(scope)).toBe(1);
  });

  it("creates one accurately worded occurrence for a decrease", async () => {
    const provider = new MockYelpProvider().scriptListing("mock-yelp-listing", [
      { reviewCount: 128, rating: 4.5 },
      { reviewCount: 126, rating: 4.5 },
    ]);

    await check(provider, minutesAfterReference(1));
    const second = await check(provider, minutesAfterReference(2));

    // A decrease is real activity a customer wants to know about, and it is
    // named as a count change rather than as reviews being deleted — which the
    // counters cannot establish.
    expect(second.occurrence?.changeKind).toBe("count_decreased");
    expect(second.occurrence?.currentReviewCount).toBe(126);
  });

  it("creates an occurrence for a rating-only change", async () => {
    const provider = new MockYelpProvider().scriptListing("mock-yelp-listing", [
      { reviewCount: 128, rating: 4.5 },
      { reviewCount: 128, rating: 4.0 },
    ]);

    await check(provider, minutesAfterReference(1));
    const second = await check(provider, minutesAfterReference(2));

    expect(second.occurrence?.changeKind).toBe("rating_only");
    expect(second.occurrence?.previousRating).toBe(4.5);
    expect(second.occurrence?.currentRating).toBe(4.0);
  });

  it("records no occurrence when Yelp stops reporting a count", async () => {
    const provider = new MockYelpProvider().scriptListing("mock-yelp-listing", [
      { reviewCount: 128, rating: 4.5 },
      { reviewCount: null, rating: 4.5 },
    ]);

    await check(provider, minutesAfterReference(1));
    const second = await check(provider, minutesAfterReference(2));

    expect(second.occurrence).toBeNull();
    // The observation is still recorded — Lia did check, and saw nothing.
    expect(second.snapshot?.reviewCount).toBeNull();
  });

  it("carries no field claiming a number of new reviews", async () => {
    // The structural half of the honesty guarantee: there is nowhere to put
    // such a number, so no screen can ever render one.
    const provider = new MockYelpProvider().scriptListing("mock-yelp-listing", [
      { reviewCount: 128, rating: 4.5 },
      { reviewCount: 133, rating: 4.5 },
    ]);
    await check(provider, minutesAfterReference(1));
    const second = await check(provider, minutesAfterReference(2));

    const keys = Object.keys(second.occurrence ?? {});
    expect(keys.some((key) => /newReview|reviewsAdded|newCount/i.test(key))).toBe(false);
  });
});

/* -------------------------------------------------------------------------- */
/* Failure handling                                                            */
/* -------------------------------------------------------------------------- */

describe("provider failures", () => {
  it("does not turn a rate limit into review activity", async () => {
    const provider = new MockYelpProvider().scriptListing("mock-yelp-listing", [
      { reviewCount: 128, rating: 4.5 },
      { failWith: "rate_limited" },
    ]);

    await check(provider, minutesAfterReference(1));
    const failed = await check(provider, minutesAfterReference(2));

    expect(failed.status).toBe("failed");
    expect(failed.errorCode).toBe("rate_limited");
    expect(failed.occurrence).toBeNull();
    expect(await dataSource.yelpActivityOccurrences.countOpen(scope)).toBe(0);
  });

  it("preserves the last successful baseline through a failure", async () => {
    const provider = new MockYelpProvider().scriptListing("mock-yelp-listing", [
      { reviewCount: 128, rating: 4.5 },
      { failWith: "provider_error" },
    ]);

    await check(provider, minutesAfterReference(1));
    await check(provider, minutesAfterReference(2));

    const latest = await dataSource.yelpListingSnapshots.latestForProfile(
      scope,
      profile.id,
    );
    // Still 128. A failed check that moved the baseline would make the *next*
    // successful one report a change that never happened.
    expect(latest?.reviewCount).toBe(128);
  });

  it("detects the real change on a successful retry after a failure", async () => {
    const provider = new MockYelpProvider().scriptListing("mock-yelp-listing", [
      { reviewCount: 128, rating: 4.5 },
      { failWith: "provider_error" },
      { reviewCount: 129, rating: 4.5 },
    ]);

    await check(provider, minutesAfterReference(1));
    await check(provider, minutesAfterReference(2));
    const third = await check(provider, minutesAfterReference(3));

    expect(third.status).toBe("completed");
    // Compared against the last *successful* observation, not against the
    // failure — so the one genuine new review is reported once.
    expect(third.occurrence?.changeKind).toBe("count_increased");
    expect(third.occurrence?.previousReviewCount).toBe(128);
    expect(third.occurrence?.currentReviewCount).toBe(129);
  });

  it("stores Lia's own sentence, never the provider's", async () => {
    const provider = new MockYelpProvider().scriptListing("mock-yelp-listing", [
      { failWith: "rate_limited" },
    ]);

    const failed = await check(provider, minutesAfterReference(1));

    expect(failed.errorMessage).toBeTruthy();
    // The mock's own message is "Mock Yelp provider raised rate_limited."
    expect(failed.errorMessage).not.toContain("Mock Yelp provider");
    expect(failed.errorMessage).toMatch(/Yelp's request limit/i);
  });
});

/* -------------------------------------------------------------------------- */
/* Idempotency                                                                 */
/* -------------------------------------------------------------------------- */

describe("idempotency", () => {
  it("does not re-announce a change on a later unchanged check", async () => {
    const provider = new MockYelpProvider().scriptListing("mock-yelp-listing", [
      { reviewCount: 128, rating: 4.5 },
      { reviewCount: 129, rating: 4.5 },
      { reviewCount: 129, rating: 4.5 },
    ]);

    await check(provider, minutesAfterReference(1));
    await check(provider, minutesAfterReference(2));
    const third = await check(provider, minutesAfterReference(3));

    expect(third.occurrence).toBeNull();
    // One change, one notice — not one per check thereafter.
    expect(await dataSource.yelpActivityOccurrences.countOpen(scope)).toBe(1);
  });

  it("returns the stored occurrence rather than recording a second one", async () => {
    // The replay case the unique index arbitrates in Postgres. Recording the
    // same transition twice must hand back the first row with created: false.
    const provider = new MockYelpProvider().scriptListing("mock-yelp-listing", [
      { reviewCount: 128, rating: 4.5 },
      { reviewCount: 129, rating: 4.5 },
    ]);
    await check(provider, minutesAfterReference(1));
    const second = await check(provider, minutesAfterReference(2));

    const snapshots = await dataSource.yelpListingSnapshots.listForProfile(
      scope,
      profile.id,
    );
    const [newer, older] = snapshots;
    if (!newer || !older) throw new Error("expected two snapshots");

    const replay = await dataSource.yelpActivityOccurrences.record(scope, {
      platformProfileId: profile.id,
      locationId: profile.locationId,
      fromSnapshotId: older.id,
      toSnapshotId: newer.id,
      detectedAt: minutesAfterReference(4),
      changeKind: "count_increased",
      previousReviewCount: 128,
      currentReviewCount: 129,
      previousRating: 4.5,
      currentRating: 4.5,
    });

    expect(replay.created).toBe(false);
    expect(replay.occurrence.id).toBe(second.occurrence?.id);
  });

  it("skips rather than fails when a check is already running for the listing", async () => {
    const provider = new MockYelpProvider();

    // Open a run by hand to hold the lock, exactly as a concurrent check would.
    //
    // Started at the real clock rather than the seed clock, deliberately: the
    // demo adapter measures lease staleness against `Date.now()`, so a run
    // stamped with `REFERENCE_NOW` reads as abandoned and is reclaimed on the
    // spot — which would make this assert the opposite of what it means to.
    await dataSource.platformSyncRuns.start(scope, {
      platformConnectionId: profile.platformConnectionId,
      platformProfileId: profile.id,
      resource: "listing_activity",
      trigger: "scheduled",
      actorUserId: null,
      startedAt: new Date().toISOString(),
    });

    const outcome = await check(provider, minutesAfterReference(2));

    // Skipped, not failed: one busy listing must not fail a whole sweep.
    expect(outcome.status).toBe("skipped");
    expect(outcome.runId).toBeNull();
  });

  it("does not share a lock with a Google review sync of the same profile", async () => {
    // The `resource` column is what keeps these apart. A Yelp check blocked by
    // a review import would silently stop checking whenever a sync was running.
    await dataSource.platformSyncRuns.start(scope, {
      platformConnectionId: profile.platformConnectionId,
      platformProfileId: profile.id,
      resource: "reviews",
      trigger: "scheduled",
      actorUserId: null,
      // Real clock, so the run genuinely holds its lock — see the note above.
      startedAt: new Date().toISOString(),
    });

    const provider = new MockYelpProvider().scriptListing("mock-yelp-listing", [
      { reviewCount: 128, rating: 4.5 },
    ]);
    const outcome = await check(provider, minutesAfterReference(2));

    expect(outcome.status).toBe("completed");
  });
});

/* -------------------------------------------------------------------------- */
/* Audit                                                                       */
/* -------------------------------------------------------------------------- */

describe("the audit trail", () => {
  it("records a check, and a detection only when something changed", async () => {
    const provider = new MockYelpProvider().scriptListing("mock-yelp-listing", [
      { reviewCount: 128, rating: 4.5 },
      { reviewCount: 129, rating: 4.5 },
    ]);

    await check(provider, minutesAfterReference(1));
    await check(provider, minutesAfterReference(2));

    const events = await dataSource.auditEvents.list(scope, { limit: 50 });
    const checks = events.filter((e) => e.eventType === "integration.listing_checked");
    const detections = events.filter((e) => e.eventType === "yelp_activity.detected");

    expect(checks).toHaveLength(2);
    expect(detections).toHaveLength(1);
  });

  it("never names a synchronisation or an import", async () => {
    const provider = new MockYelpProvider().scriptListing("mock-yelp-listing", [
      { reviewCount: 128, rating: 4.5 },
    ]);
    await check(provider, minutesAfterReference(1));

    const events = await dataSource.auditEvents.list(scope, { limit: 50 });
    expect(
      events.some((e) => e.eventType === "integration.reviews_synced"),
    ).toBe(false);
  });
});
