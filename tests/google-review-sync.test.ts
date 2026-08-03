import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import { can } from "@/lib/auth/permissions";
import { DataError } from "@/lib/data/errors";
import {
  listConnectedLocationStatus,
  reviewToMentionInput,
  syncGoogleReviews,
} from "@/lib/integrations/google-reviews";
import { CONN_GOOGLE, CONN_REDDIT, LOC_SOHO } from "@/lib/seed/dataset";
import {
  clearTestVault,
  connectGoogle,
  fakeGoogleConnector,
  installTestVault,
  setFakeConnector,
  TEST_ACCOUNT,
  testReview,
  type FakeConnector,
  type FakeConnectorOptions,
} from "./helpers/google";
import { freshDataSource, harbor, ushg } from "./helpers/scope";

/**
 * Review synchronisation, end to end through the service layer.
 *
 * Only the connector is faked. Repositories, encryption, the ingest path, the
 * sync-run lock, and audit are all production code — because what these tests
 * are for is how those fit together. A sync that imports correctly but
 * overwrites the status somebody set, or one that reports success while leaving
 * the last-successful timestamp untouched, is exactly the bug a unit test of
 * any single piece would miss.
 */

vi.mock("@/integrations/registry", () => {
  const read = () =>
    (globalThis as Record<symbol, unknown>)[
      Symbol.for("lia.tests.google-connector")
    ] as never;

  return {
    getConnector: read,
    getGoogleConnector: read,
    isGoogleConnectorAvailable: () => true,
  };
});

/**
 * The seeded USHG organization already has a Google connection with four mapped
 * profiles and seven seeded Google reviews. These tests run against that rather
 * than a blank tenant, because syncing an organization that already has history
 * is the normal case.
 *
 * The fixtures therefore use review ids the seed does not, and every assertion
 * filters to them rather than counting rows, so a seeded review cannot make a
 * test pass or fail for the wrong reason.
 */
const SOHO_PROFILE = "locations/1001";

let dataSource: LiaDataSource;
let scope: OrganizationScope;
let connector: FakeConnector;

/** The `platform_profiles` row id for the seeded SoHo Google listing. */
async function sohoProfileId(activeScope: OrganizationScope = scope): Promise<string> {
  const profiles = await dataSource.platformProfiles.listForConnection(
    activeScope,
    CONN_GOOGLE,
  );
  const profile = profiles.find((row) => row.externalProfileId === SOHO_PROFILE);
  if (!profile) throw new Error("seed fixture changed: no SoHo Google profile");
  return profile.id;
}

/** Point the fake connector at a set of reviews and reconnect Google. */
async function withReviews(
  reviews: FakeConnectorOptions["reviews"],
  options: Omit<FakeConnectorOptions, "reviews"> = {},
): Promise<FakeConnector> {
  connector = fakeGoogleConnector({
    accounts: [TEST_ACCOUNT],
    reviews,
    ...options,
  });
  setFakeConnector(connector);
  await connectGoogle(dataSource, scope);
  return connector;
}

/** The imported mention for one Google review id, if it exists. */
async function importedReview(externalId: string, activeScope = scope) {
  const mentions = await dataSource.mentions.list(activeScope, {
    sourceTypes: ["google_review"],
  });
  return mentions.find((mention) => mention.externalId === externalId) ?? null;
}

beforeEach(async () => {
  installTestVault();
  dataSource = freshDataSource();
  scope = ushg.admin();
  connector = fakeGoogleConnector();
  setFakeConnector(connector);
});

afterEach(() => {
  clearTestVault();
  vi.restoreAllMocks();
});

/* -------------------------------------------------------------------------- */
/* Mapping into the canonical model                                            */
/* -------------------------------------------------------------------------- */

describe("mapping a review onto a mention", () => {
  it("fills the canonical fields from the source", () => {
    const input = reviewToMentionInput(
      testReview("r1", {
        comment: "Great night.",
        rating: 5,
        authorName: "Alex R.",
        ownerReply: { comment: "Thank you!", updatedAt: "2026-07-05T09:00:00.000Z" },
      }),
      {
        profile: { id: "profile-id", locationId: LOC_SOHO } as never,
        connectionId: CONN_GOOGLE,
      },
      "2026-08-01T00:00:00.000Z",
    );

    expect(input.sourceType).toBe("google_review");
    expect(input.externalId).toBe("r1");
    expect(input.locationId).toBe(LOC_SOHO);
    expect(input.rating).toBe(5);
    expect(input.content).toBe("Great night.");
    expect(input.sourceReplyText).toBe("Thank you!");
    expect(input.sourceReplyUpdatedAt).toBe("2026-07-05T09:00:00.000Z");
  });

  it("gives a rating-only review empty content rather than invented prose", () => {
    // "No comment provided" would put words in a customer's mouth that a
    // drafting workflow could later quote back at them.
    const input = reviewToMentionInput(
      testReview("r2", { comment: null }),
      { profile: { id: "p", locationId: null } as never, connectionId: CONN_GOOGLE },
      "2026-08-01T00:00:00.000Z",
    );

    expect(input.content).toBe("");
  });

  it("stores no raw Google payload", () => {
    // A verbatim copy would put a reviewer's name and photo URL into a second,
    // unmanaged place for no capability gained.
    const input = reviewToMentionInput(
      testReview("r3"),
      { profile: { id: "p", locationId: null } as never, connectionId: CONN_GOOGLE },
      "2026-08-01T00:00:00.000Z",
    );

    expect(input.rawPayload).toEqual({});
  });
});

/* -------------------------------------------------------------------------- */
/* Importing                                                                   */
/* -------------------------------------------------------------------------- */

describe("the initial import", () => {
  it("creates a mention for every review", async () => {
    await withReviews({
      [SOHO_PROFILE]: [testReview("new-1"), testReview("new-2"), testReview("new-3")],
    });

    const result = await syncGoogleReviews({ dataSource, scope }, {
      platformProfileId: await sohoProfileId(),
    });

    expect(result.status).toBe("completed");
    expect(result.counts).toMatchObject({
      fetched: 3,
      created: 3,
      updated: 0,
      unchanged: 0,
      failed: 0,
    });
  });

  it("puts imported reviews into the unified mentions model", async () => {
    await withReviews({
      [SOHO_PROFILE]: [
        testReview("inbox-1", { comment: "Wonderful service.", rating: 5 }),
      ],
    });

    await syncGoogleReviews({ dataSource, scope }, {
      platformProfileId: await sohoProfileId(),
    });

    // Read back through the same repository the inbox uses, with no
    // Google-specific filter — that is the whole claim of "unified".
    const mentions = await dataSource.mentions.list(scope);
    const imported = mentions.find((mention) => mention.externalId === "inbox-1");

    expect(imported).toBeDefined();
    expect(imported?.sourceType).toBe("google_review");
    expect(imported?.platformConnectionId).toBe(CONN_GOOGLE);
    expect(imported?.locationId).toBe(LOC_SOHO);
    expect(imported?.status).toBe("new");
  });

  it("imports a rating-only review", async () => {
    await withReviews({
      [SOHO_PROFILE]: [testReview("rating-only", { comment: null, rating: 3 })],
    });

    await syncGoogleReviews({ dataSource, scope }, {
      platformProfileId: await sohoProfileId(),
    });

    const imported = await importedReview("rating-only");
    expect(imported?.rating).toBe(3);
    expect(imported?.content).toBe("");
  });

  it("imports an anonymous review without inventing an author", async () => {
    await withReviews({
      [SOHO_PROFILE]: [
        testReview("anon", { authorName: null, authorIsAnonymous: true }),
      ],
    });

    await syncGoogleReviews({ dataSource, scope }, {
      platformProfileId: await sohoProfileId(),
    });

    const imported = await importedReview("anon");
    expect(imported?.authorName).toBeNull();
    expect(imported?.authorIsAnonymous).toBe(true);
  });

  it("stores the owner reply Google already shows", async () => {
    await withReviews({
      [SOHO_PROFILE]: [
        testReview("replied", {
          ownerReply: { comment: "Sorry about the wait.", updatedAt: "2026-07-09T10:00:00.000Z" },
        }),
      ],
    });

    await syncGoogleReviews({ dataSource, scope }, {
      platformProfileId: await sohoProfileId(),
    });

    const imported = await importedReview("replied");
    expect(imported?.sourceReplyText).toBe("Sorry about the wait.");
    expect(imported?.sourceReplyUpdatedAt).toBe("2026-07-09T10:00:00.000Z");
  });

  it("reports an empty location without failing", async () => {
    await withReviews({ [SOHO_PROFILE]: [] });

    const result = await syncGoogleReviews({ dataSource, scope }, {
      platformProfileId: await sohoProfileId(),
    });

    expect(result.status).toBe("completed");
    expect(result.counts.fetched).toBe(0);
    expect(result.errorMessage).toBeNull();
  });

  it("carries Google's own total when it reports one", async () => {
    await withReviews({ [SOHO_PROFILE]: [testReview("t1")] }, { totalReviewCount: 412 });

    const result = await syncGoogleReviews({ dataSource, scope }, {
      platformProfileId: await sohoProfileId(),
    });

    expect(result.totalReviewCount).toBe(412);
  });
});

/* -------------------------------------------------------------------------- */
/* Idempotency                                                                 */
/* -------------------------------------------------------------------------- */

describe("re-running a sync", () => {
  it("creates no duplicates", async () => {
    await withReviews({
      [SOHO_PROFILE]: [testReview("dup-1"), testReview("dup-2")],
    });
    const profileId = await sohoProfileId();

    await syncGoogleReviews({ dataSource, scope }, { platformProfileId: profileId });
    const second = await syncGoogleReviews({ dataSource, scope }, {
      platformProfileId: profileId,
    });

    expect(second.counts).toMatchObject({
      fetched: 2,
      created: 0,
      updated: 0,
      unchanged: 2,
    });

    const mentions = await dataSource.mentions.list(scope, {
      sourceTypes: ["google_review"],
    });
    expect(mentions.filter((row) => row.externalId === "dup-1")).toHaveLength(1);
  });

  it("keeps the same mention id, so drafts and escalations still point at it", async () => {
    await withReviews({ [SOHO_PROFILE]: [testReview("stable")] });
    const profileId = await sohoProfileId();

    await syncGoogleReviews({ dataSource, scope }, { platformProfileId: profileId });
    const first = await importedReview("stable");

    await syncGoogleReviews({ dataSource, scope }, { platformProfileId: profileId });
    const second = await importedReview("stable");

    expect(second?.id).toBe(first?.id);
  });

  it("updates a review the author edited", async () => {
    await withReviews({
      [SOHO_PROFILE]: [testReview("edited", { comment: "It was fine.", rating: 3 })],
    });
    const profileId = await sohoProfileId();
    await syncGoogleReviews({ dataSource, scope }, { platformProfileId: profileId });

    setFakeConnector(
      fakeGoogleConnector({
        accounts: [TEST_ACCOUNT],
        reviews: {
          [SOHO_PROFILE]: [
            testReview("edited", {
              comment: "On reflection it was excellent.",
              rating: 5,
              sourceUpdatedAt: "2026-07-20T10:00:00.000Z",
            }),
          ],
        },
      }),
    );

    const result = await syncGoogleReviews({ dataSource, scope }, {
      platformProfileId: profileId,
    });

    expect(result.counts).toMatchObject({ created: 0, updated: 1, unchanged: 0 });

    const imported = await importedReview("edited");
    expect(imported?.content).toBe("On reflection it was excellent.");
    expect(imported?.rating).toBe(5);
    expect(imported?.sourceUpdatedAt).toBe("2026-07-20T10:00:00.000Z");
  });

  it("picks up an owner reply added since the last sync", async () => {
    await withReviews({ [SOHO_PROFILE]: [testReview("reply-later")] });
    const profileId = await sohoProfileId();
    await syncGoogleReviews({ dataSource, scope }, { platformProfileId: profileId });

    expect((await importedReview("reply-later"))?.sourceReplyText).toBeNull();

    setFakeConnector(
      fakeGoogleConnector({
        accounts: [TEST_ACCOUNT],
        reviews: {
          [SOHO_PROFILE]: [
            testReview("reply-later", {
              ownerReply: { comment: "Thanks for coming in.", updatedAt: null },
            }),
          ],
        },
      }),
    );

    await syncGoogleReviews({ dataSource, scope }, { platformProfileId: profileId });

    expect((await importedReview("reply-later"))?.sourceReplyText).toBe(
      "Thanks for coming in.",
    );
  });
});

/* -------------------------------------------------------------------------- */
/* Lia's own workflow state                                                    */
/* -------------------------------------------------------------------------- */

describe("Lia-owned fields", () => {
  it("does not reset a status somebody set", async () => {
    // The failure this guards against is quiet and expensive: a re-import that
    // moved an escalated review back to "new" would drop it out of the queue
    // somebody is actively working.
    await withReviews({ [SOHO_PROFILE]: [testReview("worked-on")] });
    const profileId = await sohoProfileId();
    await syncGoogleReviews({ dataSource, scope }, { platformProfileId: profileId });

    const imported = await importedReview("worked-on");
    await dataSource.mentions.updateStatus(scope, imported!.id, "escalated");

    setFakeConnector(
      fakeGoogleConnector({
        accounts: [TEST_ACCOUNT],
        reviews: {
          [SOHO_PROFILE]: [testReview("worked-on", { comment: "Edited text." })],
        },
      }),
    );
    await syncGoogleReviews({ dataSource, scope }, { platformProfileId: profileId });

    const after = await importedReview("worked-on");
    // The source field moved.
    expect(after?.content).toBe("Edited text.");
    // Lia's did not.
    expect(after?.status).toBe("escalated");
  });

  it("preserves the first-seen timestamp across re-imports", async () => {
    await withReviews({ [SOHO_PROFILE]: [testReview("received")] });
    const profileId = await sohoProfileId();

    await syncGoogleReviews({ dataSource, scope }, { platformProfileId: profileId });
    const first = await importedReview("received");

    setFakeConnector(
      fakeGoogleConnector({
        accounts: [TEST_ACCOUNT],
        reviews: { [SOHO_PROFILE]: [testReview("received", { comment: "Changed." })] },
      }),
    );
    await syncGoogleReviews({ dataSource, scope }, { platformProfileId: profileId });

    // A re-sync did not receive it again.
    expect((await importedReview("received"))?.receivedAt).toBe(first?.receivedAt);
  });

  it("leaves an existing response draft attached and untouched", async () => {
    await withReviews({ [SOHO_PROFILE]: [testReview("drafted")] });
    const profileId = await sohoProfileId();
    await syncGoogleReviews({ dataSource, scope }, { platformProfileId: profileId });

    const imported = await importedReview("drafted");
    const before = await dataSource.responseDrafts.list(scope, {
      mentionId: imported!.id,
    });

    setFakeConnector(
      fakeGoogleConnector({
        accounts: [TEST_ACCOUNT],
        reviews: {
          [SOHO_PROFILE]: [
            testReview("drafted", {
              ownerReply: { comment: "Owner replied on Google.", updatedAt: null },
            }),
          ],
        },
      }),
    );
    await syncGoogleReviews({ dataSource, scope }, { platformProfileId: profileId });

    const after = await dataSource.responseDrafts.list(scope, { mentionId: imported!.id });

    // The owner reply is stored as source state and does not become a draft,
    // and does not disturb the drafts that exist.
    expect(after).toEqual(before);
    expect((await importedReview("drafted"))?.sourceReplyText).toBe(
      "Owner replied on Google.",
    );
  });

  it("does not touch the seeded reviews it did not fetch", async () => {
    await withReviews({ [SOHO_PROFILE]: [testReview("only-this-one")] });

    const before = await dataSource.mentions.list(scope, {
      sourceTypes: ["google_review"],
    });
    const seeded = before.find((row) => row.externalId === "1029384756");

    await syncGoogleReviews({ dataSource, scope }, {
      platformProfileId: await sohoProfileId(),
    });

    const after = await dataSource.mentions.list(scope, {
      sourceTypes: ["google_review"],
    });
    expect(after.find((row) => row.externalId === "1029384756")).toEqual(seeded);
  });
});

/* -------------------------------------------------------------------------- */
/* Authorization                                                               */
/* -------------------------------------------------------------------------- */

describe("authorization", () => {
  it("gives the sync permission to the roles that run the inbox", () => {
    expect(can("owner", "integration.sync_reviews")).toBe(true);
    expect(can("admin", "integration.sync_reviews")).toBe(true);
    expect(can("communications_lead", "integration.sync_reviews")).toBe(true);
  });

  it("withholds it from read-only roles and from location managers", () => {
    expect(can("analyst", "integration.sync_reviews")).toBe(false);
    expect(can("viewer", "integration.sync_reviews")).toBe(false);
    // No location to scope them to: a sync covers a whole connected listing.
    expect(can("location_manager", "integration.sync_reviews")).toBe(false);
  });

  it("refuses a connected location belonging to another organization", async () => {
    await withReviews({ [SOHO_PROFILE]: [testReview("cross-tenant")] });
    const profileId = await sohoProfileId();

    // Harbor & Vine asking for a USHG profile id. The scoped lookup means it is
    // simply not found, so a forged id buys nothing.
    await expect(
      syncGoogleReviews(
        { dataSource, scope: harbor.owner() },
        { platformProfileId: profileId },
      ),
    ).rejects.toBeInstanceOf(DataError);

    // And nothing was imported into either tenant.
    expect(await importedReview("cross-tenant", harbor.owner())).toBeNull();
    expect(await importedReview("cross-tenant")).toBeNull();
  });

  it("refuses a channel that is not a Google connection", async () => {
    await withReviews({ [SOHO_PROFILE]: [] });

    const reddit = await dataSource.platformProfiles.listForConnection(
      scope,
      CONN_REDDIT,
    );

    const error = await syncGoogleReviews(
      { dataSource, scope },
      { platformProfileId: reddit[0]!.id },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DataError);
    expect((error as DataError).message).toContain("not a Google Business Profile");
  });

  it("refuses an unknown connected location", async () => {
    await withReviews({ [SOHO_PROFILE]: [] });

    await expect(
      syncGoogleReviews(
        { dataSource, scope },
        { platformProfileId: "00000000-0000-4000-8000-000000000000" },
      ),
    ).rejects.toBeInstanceOf(DataError);
  });

  it("refuses a disconnected connection", async () => {
    await withReviews({ [SOHO_PROFILE]: [testReview("after-disconnect")] });
    const profileId = await sohoProfileId();

    await dataSource.platformConnections.markDisconnected(scope, CONN_GOOGLE);

    const error = await syncGoogleReviews(
      { dataSource, scope },
      { platformProfileId: profileId },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DataError);
    expect((error as DataError).message).toContain("disconnected");
    expect(connector.listReviewCalls).toBe(0);
  });
});

/* -------------------------------------------------------------------------- */
/* Failures                                                                    */
/* -------------------------------------------------------------------------- */

describe("failures", () => {
  it("reports a revoked authorization as a sanitised reauthorization prompt", async () => {
    await withReviews({ [SOHO_PROFILE]: [] }, { reviewsFailWith: "authorization_revoked" });

    const result = await syncGoogleReviews({ dataSource, scope }, {
      platformProfileId: await sohoProfileId(),
    });

    expect(result.status).toBe("failed");
    expect(result.errorCode).toBe("authorization_revoked");
    expect(result.errorMessage).toContain("Reauthorize");
    // Lia's own wording. No Google text, no URL, no token.
    expect(result.errorMessage).not.toMatch(/googleapis|Bearer|token/i);
  });

  it("marks the connection as needing attention after a revoked authorization", async () => {
    await withReviews({ [SOHO_PROFILE]: [] }, { reviewsFailWith: "authorization_revoked" });

    await syncGoogleReviews({ dataSource, scope }, {
      platformProfileId: await sohoProfileId(),
    });

    const connection = await dataSource.platformConnections.get(scope, CONN_GOOGLE);
    expect(connection?.lastHealthStatus).toBe("authorization_required");
    expect(connection?.status).toBe("action_required");
  });

  it("does not move the last successful sync time when a sync fails", async () => {
    await withReviews({ [SOHO_PROFILE]: [testReview("before-failure")] });
    const profileId = await sohoProfileId();

    const good = await syncGoogleReviews({ dataSource, scope }, {
      platformProfileId: profileId,
    });
    expect(good.lastSuccessfulSyncAt).not.toBeNull();

    setFakeConnector(
      fakeGoogleConnector({
        accounts: [TEST_ACCOUNT],
        reviewsFailWith: "provider_unavailable",
      }),
    );

    const bad = await syncGoogleReviews({ dataSource, scope }, {
      platformProfileId: profileId,
    });

    expect(bad.status).toBe("failed");
    // Showing "synced a minute ago" beside an error is how an operator concludes
    // their reviews are current when they are not.
    expect(bad.lastSuccessfulSyncAt).toBe(good.lastSuccessfulSyncAt);

    const profile = (
      await dataSource.platformProfiles.listForConnection(scope, CONN_GOOGLE)
    ).find((row) => row.id === profileId);
    expect(profile?.lastSyncedAt).toBe(good.lastSuccessfulSyncAt);
  });

  it("imports the good reviews on a page that also held an unreadable one", async () => {
    await withReviews(
      { [SOHO_PROFILE]: [testReview("good-1"), testReview("good-2")] },
      { malformedCount: 1 },
    );

    const result = await syncGoogleReviews({ dataSource, scope }, {
      platformProfileId: await sohoProfileId(),
    });

    expect(result.status).toBe("partial");
    expect(result.counts).toMatchObject({ fetched: 3, created: 2, failed: 1 });
    expect(await importedReview("good-1")).not.toBeNull();
  });

  it("records the failure as a run rather than losing it", async () => {
    await withReviews({ [SOHO_PROFILE]: [] }, { reviewsFailWith: "quota_exceeded" });
    const profileId = await sohoProfileId();

    await syncGoogleReviews({ dataSource, scope }, { platformProfileId: profileId });

    const runs = await dataSource.platformSyncRuns.listForProfile(scope, profileId);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.errorCode).toBe("quota_exceeded");
    expect(runs[0]?.completedAt).not.toBeNull();
  });
});

/* -------------------------------------------------------------------------- */
/* Concurrency                                                                 */
/* -------------------------------------------------------------------------- */

describe("concurrent syncs", () => {
  it("lets only one run hold a location at a time", async () => {
    await withReviews({ [SOHO_PROFILE]: [testReview("race-1")] });
    const profileId = await sohoProfileId();

    // Open a run and leave it open, exactly as a request still in flight would.
    const held = await dataSource.platformSyncRuns.start(scope, {
      platformConnectionId: CONN_GOOGLE,
      platformProfileId: profileId,
      resource: "reviews",
      trigger: "manual",
      actorUserId: scope.userId,
      startedAt: new Date().toISOString(),
    });

    const error = await syncGoogleReviews(
      { dataSource, scope },
      { platformProfileId: profileId },
    ).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(DataError);
    expect((error as DataError).code).toBe("conflict");
    expect((error as DataError).message).toContain("already running");
    // The refused attempt never reached Google.
    expect(connector.listReviewCalls).toBe(0);

    // And it left no failed run behind to confuse the history.
    const runs = await dataSource.platformSyncRuns.listForProfile(scope, profileId);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe(held.id);
  });

  it("reclaims a run abandoned by a process that died", async () => {
    // Without this a single crashed function would block a location's syncs
    // until somebody edited the database.
    await withReviews({ [SOHO_PROFILE]: [testReview("after-crash")] });
    const profileId = await sohoProfileId();

    const abandoned = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    await dataSource.platformSyncRuns.start(scope, {
      platformConnectionId: CONN_GOOGLE,
      platformProfileId: profileId,
      resource: "reviews",
      trigger: "manual",
      actorUserId: scope.userId,
      startedAt: abandoned,
    });

    const result = await syncGoogleReviews({ dataSource, scope }, {
      platformProfileId: profileId,
    });

    expect(result.status).toBe("completed");
    expect(await importedReview("after-crash")).not.toBeNull();
  });

  it("does not block a different location", async () => {
    await withReviews({ [SOHO_PROFILE]: [testReview("independent")] });
    const profiles = await dataSource.platformProfiles.listForConnection(
      scope,
      CONN_GOOGLE,
    );
    const soho = profiles.find((row) => row.externalProfileId === SOHO_PROFILE)!;
    const other = profiles.find((row) => row.externalProfileId !== SOHO_PROFILE)!;

    await dataSource.platformSyncRuns.start(scope, {
      platformConnectionId: CONN_GOOGLE,
      platformProfileId: other.id,
      resource: "reviews",
      trigger: "manual",
      actorUserId: scope.userId,
      startedAt: new Date().toISOString(),
    });

    const result = await syncGoogleReviews({ dataSource, scope }, {
      platformProfileId: soho.id,
    });

    expect(result.status).toBe("completed");
  });
});

/* -------------------------------------------------------------------------- */
/* Observability                                                               */
/* -------------------------------------------------------------------------- */

describe("observability", () => {
  it("records an audit event carrying counts but no review text", async () => {
    await withReviews({
      [SOHO_PROFILE]: [testReview("audited", { comment: "Secret customer words." })],
    });
    const profileId = await sohoProfileId();

    await syncGoogleReviews({ dataSource, scope }, { platformProfileId: profileId });

    const events = await dataSource.auditEvents.list(scope, {
      entityType: "platform_profile",
      entityId: profileId,
    });
    const synced = events.find((event) => event.eventType === "integration.reviews_synced");

    expect(synced).toBeDefined();
    expect(synced?.metadata).toMatchObject({ created: 1, fetched: 1 });
    expect(JSON.stringify(synced)).not.toContain("Secret customer words");
  });

  it("records a failure event when the import did not happen", async () => {
    await withReviews({ [SOHO_PROFILE]: [] }, { reviewsFailWith: "provider_unavailable" });
    const profileId = await sohoProfileId();

    await syncGoogleReviews({ dataSource, scope }, { platformProfileId: profileId });

    const events = await dataSource.auditEvents.list(scope, {
      entityType: "platform_profile",
      entityId: profileId,
    });

    expect(
      events.some((event) => event.eventType === "integration.review_sync_failed"),
    ).toBe(true);
  });

  it("reports per-location status for the integration screen", async () => {
    await withReviews({
      [SOHO_PROFILE]: [testReview("status-1"), testReview("status-2")],
    });
    const profileId = await sohoProfileId();
    await syncGoogleReviews({ dataSource, scope }, { platformProfileId: profileId });

    const status = await listConnectedLocationStatus({ dataSource, scope }, CONN_GOOGLE);
    const soho = status.find((entry) => entry.profile.id === profileId);

    expect(soho?.sync.lastSuccessful?.status).toBe("completed");
    expect(soho?.syncing).toBe(false);
    expect(soho?.locationName).toBeTruthy();
    // Seeded reviews for this profile plus the two just imported.
    expect(soho?.importedReviewCount).toBeGreaterThanOrEqual(2);
  });

  it("shows a location as syncing while a run holds it", async () => {
    await withReviews({ [SOHO_PROFILE]: [] });
    const profileId = await sohoProfileId();

    await dataSource.platformSyncRuns.start(scope, {
      platformConnectionId: CONN_GOOGLE,
      platformProfileId: profileId,
      resource: "reviews",
      trigger: "manual",
      actorUserId: scope.userId,
      startedAt: new Date().toISOString(),
    });

    const status = await listConnectedLocationStatus({ dataSource, scope }, CONN_GOOGLE);
    expect(status.find((entry) => entry.profile.id === profileId)?.syncing).toBe(true);
  });

  it("counts a scheduled run as having no human actor", async () => {
    await withReviews({ [SOHO_PROFILE]: [testReview("scheduled")] });
    const profileId = await sohoProfileId();

    await syncGoogleReviews(
      { dataSource, scope },
      { platformProfileId: profileId, trigger: "scheduled" },
    );

    const runs = await dataSource.platformSyncRuns.listForProfile(scope, profileId);
    // Attributing a scheduled run to whoever connected Google months ago would
    // be a lie in the audit trail.
    expect(runs[0]?.actorUserId).toBeNull();
    expect(runs[0]?.trigger).toBe("scheduled");
  });
});
