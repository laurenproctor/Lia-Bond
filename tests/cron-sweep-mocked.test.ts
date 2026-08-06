import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DataError } from "@/lib/data/errors";
import type { OrganizationScope } from "@/lib/data/types";

const SECRET = "test-cron-secret-value";
const LEAK_MARKER = "connection string postgres://cron_user:s3cr3t@db.internal/lia";

/**
 * Behaviour the real demo data source cannot exercise on its own:
 *
 * - Per-organization isolation on the analyse-mentions sweep — one
 *   organization's lock conflict, and a separate organization's unexpected
 *   failure, must not stop the sweep from reaching every other organization.
 * - The counts the sweep reports, including `mentionsFailed`
 *   (`result.counts.failed`, which an earlier version of this route dropped)
 *   and `erroredOrganizations`.
 * - The 500 path on both routes, and specifically that whatever caused it
 *   never reaches the response body or a log line — the property the brief
 *   calls out explicitly and that reading the code cannot verify on its own.
 *
 * `@/lib/data` and `@/lib/analysis/analyze` are mocked so each organization's
 * outcome can be scripted directly, and so a thrown error can carry a marker
 * string standing in for the kind of driver detail (a connection string) a
 * real failure could leak.
 */

const { listWithUnanalyzedMentions, analyzeMentionsMock, getServiceDataSourceMock } =
  vi.hoisted(() => ({
    listWithUnanalyzedMentions: vi.fn(),
    analyzeMentionsMock: vi.fn(),
    getServiceDataSourceMock: vi.fn(),
  }));

const { pollDueQueriesMock } = vi.hoisted(() => ({
  pollDueQueriesMock: vi.fn(),
}));

vi.mock("@/lib/data", () => ({
  getServiceDataSource: getServiceDataSourceMock,
}));

vi.mock("@/lib/analysis/analyze", () => ({
  analyzeMentions: analyzeMentionsMock,
}));

vi.mock("@/lib/monitoring/poll-service", () => ({
  pollDueQueries: pollDueQueriesMock,
}));

function fakeDataSource(): { kind: "demo"; organizations: { listWithUnanalyzedMentions: typeof listWithUnanalyzedMentions } } {
  return { kind: "demo", organizations: { listWithUnanalyzedMentions } };
}

beforeEach(() => {
  vi.stubEnv("CRON_SECRET", SECRET);
  vi.stubEnv("LIA_AI_MODE", "mock");
  vi.stubEnv("LIA_NEWS_MODE", "mock");
  vi.stubEnv("NODE_ENV", "test");

  listWithUnanalyzedMentions.mockReset();
  analyzeMentionsMock.mockReset();
  pollDueQueriesMock.mockReset();
  getServiceDataSourceMock.mockReset();
  getServiceDataSourceMock.mockResolvedValue(fakeDataSource());
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

function authorizedRequest(path: string): Request {
  return new Request(`https://lia.test${path}`, {
    method: "POST",
    headers: { authorization: `Bearer ${SECRET}` },
  });
}

function emptyCounts(overrides: Partial<{
  analyzed: number;
  heuristic: number;
  escalated: number;
  failed: number;
  remaining: number;
}> = {}) {
  return { analyzed: 0, heuristic: 0, escalated: 0, failed: 0, remaining: 0, ...overrides };
}

describe("POST /api/cron/analyze-mentions: per-organization isolation", () => {
  it("does not let one organization's lock conflict or failure stop the sweep", async () => {
    // Asymmetric on purpose: two conflicts and one error means `skipped` and
    // `erroredOrganizations` land on different numbers (2 vs 1). If the two
    // branches at the route's catch site were ever swapped — a lock conflict
    // counted as an error, or the reverse — the previous, symmetric version
    // of this test (one of each) produced an identical body either way and
    // could not have caught that. This version can.
    listWithUnanalyzedMentions.mockResolvedValue([
      "org-conflict-1",
      "org-conflict-2",
      "org-broken",
      "org-clean",
    ]);

    analyzeMentionsMock.mockImplementation(
      async (context: { scope: OrganizationScope }) => {
        if (context.scope.organizationId.startsWith("org-conflict")) {
          throw new DataError(
            "conflict",
            "An analysis is already running. Wait for it to finish before starting another.",
          );
        }
        if (context.scope.organizationId === "org-broken") {
          throw new Error(LEAK_MARKER);
        }
        return {
          analysisRunId: "run-clean",
          status: "partial" as const,
          counts: emptyCounts({ analyzed: 2, heuristic: 1, escalated: 1, failed: 3 }),
          errorMessage: null,
          errorCode: null,
        };
      },
    );

    const { POST } = await import("@/app/api/cron/analyze-mentions/route");
    const response = await POST(authorizedRequest("/api/cron/analyze-mentions"));
    const body = await response.json();

    // All four organizations were attempted — neither throw stopped the loop
    // from reaching the rest. This is the assertion that actually pins
    // isolation; a route with no try/catch inside the loop would fail here
    // (a 500 with only the first result recorded, and the later
    // organizations never attempted).
    expect(analyzeMentionsMock).toHaveBeenCalledTimes(4);

    expect(response.status).toBe(200);
    expect(body).toEqual({
      status: "ok",
      organizations: 1, // only org-clean's call returned normally
      skipped: 2, // org-conflict-1, org-conflict-2
      analyzed: 2,
      heuristic: 1,
      escalated: 1,
      mentionsFailed: 3, // result.counts.failed, carried through rather than dropped
      erroredOrganizations: 1, // org-broken
    });
  });

  it("builds each organization's scope from that organization's own id, with the system actor", async () => {
    listWithUnanalyzedMentions.mockResolvedValue(["org-a", "org-b"]);
    analyzeMentionsMock.mockResolvedValue({
      analysisRunId: "run",
      status: "completed" as const,
      counts: emptyCounts(),
      errorMessage: null,
      errorCode: null,
    });

    const { POST } = await import("@/app/api/cron/analyze-mentions/route");
    await POST(authorizedRequest("/api/cron/analyze-mentions"));

    const scopes = analyzeMentionsMock.mock.calls.map((call: unknown[]) => {
      const [context] = call as [{ scope: OrganizationScope }];
      return context.scope;
    });
    expect(scopes).toHaveLength(2);
    for (const scope of scopes) {
      // D88: never an ambient organization, never the request's own session
      // (there is none) — each scope is built from the row's own id.
      expect(["org-a", "org-b"]).toContain(scope.organizationId);
      expect(scope.userId).toBe("00000000-0000-0000-0000-000000000000");
      expect(scope.role).toBe("owner");
    }
  });

  it("returns a clean sweep with no organizations when none have unanalysed mentions", async () => {
    listWithUnanalyzedMentions.mockResolvedValue([]);

    const { POST } = await import("@/app/api/cron/analyze-mentions/route");
    const response = await POST(authorizedRequest("/api/cron/analyze-mentions"));
    const body = await response.json();

    expect(analyzeMentionsMock).not.toHaveBeenCalled();
    expect(body).toEqual({
      status: "ok",
      organizations: 0,
      skipped: 0,
      analyzed: 0,
      heuristic: 0,
      escalated: 0,
      mentionsFailed: 0,
      erroredOrganizations: 0,
    });
  });
});

describe("POST /api/cron/analyze-mentions: failure outside the per-organization loop", () => {
  it("returns 500 with no internal detail when listWithUnanalyzedMentions fails", async () => {
    listWithUnanalyzedMentions.mockRejectedValue(new Error(LEAK_MARKER));

    const { POST } = await import("@/app/api/cron/analyze-mentions/route");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(authorizedRequest("/api/cron/analyze-mentions"));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain(LEAK_MARKER);
    expect(body).not.toContain(SECRET);

    // The log line is part of the surface this route must not leak through —
    // the brief is explicit that no internal error detail may appear "in a
    // response body or a log line."
    for (const call of consoleSpy.mock.calls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(LEAK_MARKER);
      }
    }

    consoleSpy.mockRestore();
  });
});

describe("POST /api/cron/news-poll: failure outside pollDueQueries's own isolation", () => {
  it("returns 500 with no internal detail when the sweep throws", async () => {
    pollDueQueriesMock.mockRejectedValue(new Error(LEAK_MARKER));

    const { POST } = await import("@/app/api/cron/news-poll/route");
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    const response = await POST(authorizedRequest("/api/cron/news-poll"));
    const body = await response.text();

    expect(response.status).toBe(500);
    expect(body).not.toContain(LEAK_MARKER);
    expect(body).not.toContain(SECRET);

    for (const call of consoleSpy.mock.calls) {
      for (const arg of call) {
        expect(String(arg)).not.toContain(LEAK_MARKER);
      }
    }

    consoleSpy.mockRestore();
  });
});
