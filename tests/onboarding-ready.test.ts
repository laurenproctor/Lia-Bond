import { beforeEach, describe, expect, it } from "vitest";
import { freshDataSource, ushg } from "./helpers/scope";
import { readImportStatus, NO_IMPORT_STATUS } from "@/lib/onboarding/import-status";
import { activeProfiles, resolveQuickWin } from "@/lib/onboarding/quick-win";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import { EMPTY_SYNC_COUNTS, NO_CAPABILITIES } from "@/domain";

/**
 * The Workspace Ready screen's two data sources.
 *
 * Both exist to stop the same class of lie. The quick win must never offer to
 * open a draft that was never generated, and the import panel must never report
 * a number that did not come from a `platform_sync_runs` row — no estimate, no
 * projection, and above all no percentage, because there is no denominator to
 * compute one from.
 */

let data: LiaDataSource;
let scope: OrganizationScope;

beforeEach(() => {
  data = freshDataSource();
  scope = ushg.owner();
});

/**
 * Settle every draft that is still awaiting a decision.
 *
 * Leaves the mentions and their analyses untouched, which is the state the
 * second rung of the hierarchy is for: Lia has read the feedback and formed a
 * view, but there is no draft waiting on anybody. Only the two decidable
 * statuses are settled — an already-published draft cannot be decided again,
 * and is not work either way.
 */
async function withoutDrafts(): Promise<void> {
  const drafts = await data.responseDrafts.list(scope, {
    statuses: ["draft", "awaiting_approval"],
  });
  for (const draft of drafts) {
    await data.responseDrafts.decide(scope, draft.id, "approved", scope.userId);
  }
}

describe("quick-win hierarchy", () => {
  it("prefers a real response draft above everything else", async () => {
    // The seeded tenant has drafts awaiting a decision.
    const quickWin = await resolveQuickWin({ dataSource: data, scope });

    expect(quickWin.kind).toBe("review_draft");
    expect(quickWin.href).toBeTruthy();
    // Routed to the workspace for the mention it answers, so the reviewer sees
    // what is being replied to.
    expect(quickWin.href).toMatch(/^\/(reviews|reddit|media|mentions|responses)/);
  });

  it("falls back to an analysed mention when no draft is waiting", async () => {
    await withoutDrafts();

    const quickWin = await resolveQuickWin({ dataSource: data, scope });
    expect(quickWin.kind).toBe("analyzed_mention");
    expect(quickWin.href).toBeTruthy();
  });

  it("offers the import when profiles are connected but nothing is imported", async () => {
    // A fresh organization: connections and profiles can exist while the
    // mention table is empty, which is exactly the state at the end of setup.
    const empty = freshDataSource();
    const membership = await empty.organizations.provision({
      userId: scope.userId,
      name: "Bramble & Co",
    });
    const fresh: OrganizationScope = {
      organizationId: membership.organization.id,
      userId: scope.userId,
      role: "owner",
    };

    const connection = await empty.platformConnections.upsert(fresh, {
      platform: "google_business_profile",
      externalAccountId: "accounts/1",
      externalAccountName: "Bramble",
      status: "connected",
      capabilities: { ...NO_CAPABILITIES, canReadMentions: true },
      tokenExpiresAt: null,
      grantedScopes: [],
      providerMetadata: {},
      connectedByUserId: scope.userId,
      connectedAt: new Date().toISOString(),
    });

    const location = await empty.locations.create(fresh, {
      name: "Bramble Downtown",
      addressLine1: "1 Main St",
      addressLine2: null,
      city: "Austin",
      region: "TX",
      postalCode: "78701",
      countryCode: "US",
      timezone: "America/Chicago",
      status: "setup",
      managerUserId: null,
    });

    await empty.platformProfiles.upsert(fresh, {
      platformConnectionId: connection.id,
      locationId: location.id,
      externalProfileId: "locations/1",
      externalProfileName: "Bramble Downtown",
      externalAccountId: "accounts/1",
      profileUrl: null,
      status: "active",
      verificationState: "VERIFIED",
      providerMetadata: {},
      lastConfirmedAt: new Date().toISOString(),
    });

    const quickWin = await resolveQuickWin({ dataSource: empty, scope: fresh });
    expect(quickWin.kind).toBe("start_import");
    // Not a navigation: the action runs a real sync and reports what happened.
    expect(quickWin.href).toBeNull();
  });

  it("offers connecting a source when nothing is connected at all", async () => {
    const empty = freshDataSource();
    const membership = await empty.organizations.provision({
      userId: scope.userId,
      name: "Nothing Connected Co",
    });
    const fresh: OrganizationScope = {
      organizationId: membership.organization.id,
      userId: scope.userId,
      role: "owner",
    };

    const quickWin = await resolveQuickWin({ dataSource: empty, scope: fresh });
    expect(quickWin.kind).toBe("connect_source");
    expect(quickWin.href).toBe("/integrations/google-business-profile");
  });

  it("never invents content — every branch is decided by a repository read", async () => {
    const quickWin = await resolveQuickWin({ dataSource: data, scope });
    // The description says what is waiting, in general terms. It must not
    // contain a fabricated review, name, or count.
    expect(quickWin.description).not.toMatch(/\d{2,}/);
  });
});

describe("active profiles", () => {
  it("counts only profiles Lia is actually monitoring", () => {
    const rows = [
      { status: "active" },
      { status: "disconnected" },
      { status: "pending" },
      { status: "active" },
    ] as Parameters<typeof activeProfiles>[0];

    expect(activeProfiles(rows)).toHaveLength(2);
  });
});

describe("import status", () => {
  it("reports nothing at all when no profile is connected", async () => {
    const empty = freshDataSource();
    const membership = await empty.organizations.provision({
      userId: scope.userId,
      name: "No Profiles Co",
    });

    const status = await readImportStatus(empty, {
      organizationId: membership.organization.id,
      userId: scope.userId,
      role: "owner",
    });

    expect(status).toEqual(NO_IMPORT_STATUS);
    expect(status.hasStarted).toBe(false);
  });

  it("says an import has not started when no sync run exists", async () => {
    // The seeded tenant has connected profiles and — deliberately — no sync
    // runs: a seeded run would claim reviews were imported from a Google
    // account that does not exist.
    const status = await readImportStatus(data, scope);

    expect(status.connectedProfiles).toBeGreaterThan(0);
    expect(status.hasStarted).toBe(false);
    expect(status.reviewsFetched).toBe(0);
    expect(status.lastSuccessfulAt).toBeNull();
  });

  it("counts a finished run's real tallies", async () => {
    const profiles = await data.platformProfiles.list(scope);
    const profile = profiles.find((row) => row.status === "active");
    expect(profile).toBeDefined();

    const run = await data.platformSyncRuns.start(scope, {
      platformConnectionId: profile!.platformConnectionId,
      platformProfileId: profile!.id,
      resource: "reviews",
      trigger: "manual",
      actorUserId: scope.userId,
      startedAt: new Date().toISOString(),
    });

    const running = await readImportStatus(data, scope);
    expect(running.hasStarted).toBe(true);
    expect(running.isRunning).toBe(true);
    // A run still in flight contributes no counts: its tallies are not final.
    expect(running.reviewsFetched).toBe(0);

    await data.platformSyncRuns.finish(scope, run.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
      counts: { ...EMPTY_SYNC_COUNTS, fetched: 12, created: 9, unchanged: 3 },
      pagesFetched: 1,
      totalReviewCount: 40,
      errorCode: null,
      errorMessage: null,
    });

    const finished = await readImportStatus(data, scope);
    expect(finished.isRunning).toBe(false);
    expect(finished.reviewsFetched).toBe(12);
    expect(finished.reviewsCreated).toBe(9);
    expect(finished.totalReviewCount).toBe(40);
    expect(finished.lastSuccessfulAt).not.toBeNull();
  });

  it("has no field that could hold a fabricated percentage", async () => {
    const status = await readImportStatus(data, scope);
    // Structural: if somebody adds one, this fails and they have to justify the
    // denominator first.
    expect(Object.keys(status)).not.toContain("percent");
    expect(Object.keys(status)).not.toContain("percentage");
    expect(Object.keys(status)).not.toContain("progress");
  });

  it("leaves the provider total null when the provider did not report one", async () => {
    const profiles = await data.platformProfiles.list(scope);
    const profile = profiles.find((row) => row.status === "active")!;

    const run = await data.platformSyncRuns.start(scope, {
      platformConnectionId: profile.platformConnectionId,
      platformProfileId: profile.id,
      resource: "reviews",
      trigger: "manual",
      actorUserId: scope.userId,
      startedAt: new Date().toISOString(),
    });

    await data.platformSyncRuns.finish(scope, run.id, {
      status: "completed",
      completedAt: new Date().toISOString(),
      counts: { ...EMPTY_SYNC_COUNTS, fetched: 3, created: 3 },
      pagesFetched: 1,
      totalReviewCount: null,
      errorCode: null,
      errorMessage: null,
    });

    const status = await readImportStatus(data, scope);
    expect(status.totalReviewCount).toBeNull();
  });

  it("reports a failed run rather than absorbing it into the counts", async () => {
    const profiles = await data.platformProfiles.list(scope);
    const profile = profiles.find((row) => row.status === "active")!;

    const run = await data.platformSyncRuns.start(scope, {
      platformConnectionId: profile.platformConnectionId,
      platformProfileId: profile.id,
      resource: "reviews",
      trigger: "manual",
      actorUserId: scope.userId,
      startedAt: new Date().toISOString(),
    });

    await data.platformSyncRuns.finish(scope, run.id, {
      status: "failed",
      completedAt: new Date().toISOString(),
      counts: EMPTY_SYNC_COUNTS,
      pagesFetched: 0,
      totalReviewCount: null,
      errorCode: "provider_unavailable",
      errorMessage: "Google was unavailable.",
    });

    const status = await readImportStatus(data, scope);
    expect(status.failedRuns).toBe(1);
    expect(status.lastSuccessfulAt).toBeNull();
  });
});
