import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import { DataError } from "@/lib/data/errors";

/**
 * The manual sync endpoint.
 *
 * The guard and the service are both mocked, because what is under test here is
 * the route's own job and nothing else: does it validate the body, does it
 * authorise before doing any work, does it map a typed failure onto the right
 * status, and does it keep provider detail out of the response. The behaviour
 * of the sync itself is covered against real repositories in
 * `google-review-sync.test.ts`.
 */

const authorize = vi.fn();
const syncGoogleReviews = vi.fn();

vi.mock("@/lib/actions/guard", () => ({
  authorize: (permission: string) => authorize(permission),
}));

vi.mock("@/lib/integrations/google-reviews", () => ({
  syncGoogleReviews: (context: unknown, input: unknown) =>
    syncGoogleReviews(context, input),
}));

const PROFILE_ID = "11111111-1111-4111-8111-111111111111";

const SYNC_RESULT = {
  syncRunId: "22222222-2222-4222-8222-222222222222",
  platformProfileId: PROFILE_ID,
  status: "completed" as const,
  counts: { fetched: 4, created: 3, updated: 1, unchanged: 0, failed: 0 },
  totalReviewCount: 4,
  lastSuccessfulSyncAt: "2026-08-03T10:00:00.000Z",
  errorMessage: null,
  errorCode: null,
};

async function post(body: unknown): Promise<Response> {
  const { POST } = await import(
    "@/app/api/integrations/google-business-profile/reviews/sync/route"
  );

  return POST(
    new NextRequest("https://lia.test/api/integrations/google-business-profile/reviews/sync", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: typeof body === "string" ? body : JSON.stringify(body),
    }),
  );
}

beforeEach(() => {
  authorize.mockReset().mockResolvedValue({ dataSource: {}, scope: {} });
  syncGoogleReviews.mockReset().mockResolvedValue(SYNC_RESULT);
  // The route logs sanitised codes on failure paths; keep the run quiet.
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("request validation", () => {
  it("rejects a missing channelId without touching the service", async () => {
    const response = await post({});

    expect(response.status).toBe(400);
    expect(syncGoogleReviews).not.toHaveBeenCalled();
  });

  it("rejects a channelId that is not an id", async () => {
    const response = await post({ channelId: "../../etc/passwd" });

    expect(response.status).toBe(400);
    expect(syncGoogleReviews).not.toHaveBeenCalled();
  });

  it("rejects a body that is not JSON", async () => {
    const response = await post("not json at all");
    expect(response.status).toBe(400);
  });

  it("accepts the internal spelling as well as the published one", async () => {
    // A caller written against either name should not get a validation error
    // for a naming decision they had no part in.
    const response = await post({ platformProfileId: PROFILE_ID });

    expect(response.status).toBe(200);
    expect(syncGoogleReviews).toHaveBeenCalledWith(
      expect.anything(),
      { platformProfileId: PROFILE_ID, trigger: "manual" },
    );
  });
});

describe("authorization", () => {
  it("checks the sync permission before doing any work", async () => {
    await post({ channelId: PROFILE_ID });
    expect(authorize).toHaveBeenCalledWith("integration.sync_reviews");
  });

  it("returns 403 and syncs nothing when the caller may not", async () => {
    authorize.mockRejectedValue(
      new DataError("forbidden", "Your role (analyst) cannot perform this action."),
    );

    const response = await post({ channelId: PROFILE_ID });

    expect(response.status).toBe(403);
    expect(syncGoogleReviews).not.toHaveBeenCalled();
  });

  it("returns 404 for a channel in another workspace", async () => {
    // The service resolves the id inside the caller's own organization, so a
    // cross-workspace id is not found rather than refused.
    syncGoogleReviews.mockRejectedValue(
      new DataError("not_found", "Connected location was not found."),
    );

    expect((await post({ channelId: PROFILE_ID })).status).toBe(404);
  });

  it("returns 409 when a sync is already running", async () => {
    syncGoogleReviews.mockRejectedValue(
      new DataError("conflict", "A sync is already running for this location."),
    );

    const response = await post({ channelId: PROFILE_ID });
    const body = await response.json();

    expect(response.status).toBe(409);
    expect(body.error).toContain("already running");
  });

  it("returns 400 for a channel that is not a Google connection", async () => {
    syncGoogleReviews.mockRejectedValue(
      new DataError("invalid_input", "That location is not a Google Business Profile location."),
    );

    expect((await post({ channelId: PROFILE_ID })).status).toBe(400);
  });
});

describe("the success response", () => {
  it("returns the run id, the counts, and the last successful sync", async () => {
    const body = await (await post({ channelId: PROFILE_ID })).json();

    expect(body).toEqual({
      ok: true,
      syncRunId: SYNC_RESULT.syncRunId,
      channelId: PROFILE_ID,
      status: "completed",
      counts: SYNC_RESULT.counts,
      totalReviewCount: 4,
      lastSuccessfulSyncAt: SYNC_RESULT.lastSuccessfulSyncAt,
    });
  });

  it("carries a sanitised error on a partial run", async () => {
    syncGoogleReviews.mockResolvedValue({
      ...SYNC_RESULT,
      status: "partial",
      counts: { fetched: 4, created: 3, updated: 0, unchanged: 0, failed: 1 },
      errorCode: "ingest_failed",
      errorMessage: "Some reviews could not be stored. Try the sync again.",
    });

    const body = await (await post({ channelId: PROFILE_ID })).json();

    expect(body.status).toBe("partial");
    expect(body.error).toBe("Some reviews could not be stored. Try the sync again.");
  });

  it("never returns a token or a Google payload", async () => {
    const raw = await (await post({ channelId: PROFILE_ID })).text();

    expect(raw).not.toMatch(/token|Bearer|googleapis|refresh/i);
  });
});
