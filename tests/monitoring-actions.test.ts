import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import { freshDataSource, ushg } from "./helpers/scope";
import { LOC_HARBOR_HOUSE, LOC_SOHO } from "@/lib/seed/dataset";

/**
 * Cross-tenant `locationId` on the monitoring-query actions.
 *
 * `monitoringQueries.create`/`update` accept a caller-supplied `locationId`
 * with no check that it belongs to the caller's organization — RLS on
 * `monitoring_queries` checks `organization_id` only, and the foreign key to
 * `locations` does not enforce same-organization. Without a resolve-through-
 * scope step, org A can bind a query to org B's location id, and every
 * mention that query ingests inherits it. `updateLocationManagerAction`
 * (`src/app/actions/locations.ts`) already resolves a caller-supplied
 * location through `locations.get(context.scope, locationId)` before
 * trusting it; `src/app/actions/monitoring.ts` now does the same.
 *
 * `@/lib/actions/guard`'s `authorize` is mocked so this runs with no
 * `next/headers` session machinery — the same pattern
 * `google-review-sync-route.test.ts` uses for a route handler — while the
 * mocked context still carries a *real* demo `dataSource`, so the resolve
 * step underneath exercises the genuine tenant boundary rather than a
 * test-only shortcut.
 */

const authorizeMock = vi.fn();

vi.mock("@/lib/actions/guard", () => ({
  authorize: (permission: string) => authorizeMock(permission),
}));

// `revalidatePath` requires a live Next.js request scope that does not exist
// under Vitest; every action under test calls it on the success path, so it
// is stubbed to a no-op the same way a route or component test would get it
// for free from the Next test runtime.
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

let dataSource: LiaDataSource;

function contextFor(scope: OrganizationScope) {
  return {
    // Only `scope`, `userId`, `role`, and `dataSource` are read by the code
    // under test; the rest of `MutationContext` is unused here.
    organization: { id: scope.organizationId },
    role: scope.role,
    userId: scope.userId,
    scope,
    available: [],
    dataSource,
  };
}

const BASE_INPUT = {
  name: "Brand mentions",
  queryType: "brand" as const,
  keywords: ["Gramercy Tavern"],
  exclusions: [],
  allowedDomains: [],
  deniedDomains: [],
  sourceCountry: "us",
  language: null,
  relevanceThreshold: 0.35,
  enabled: true,
  pollIntervalMinutes: 360,
};

beforeEach(() => {
  dataSource = freshDataSource();
  vi.stubEnv("LIA_NEWS_MODE", "mock");
  vi.stubEnv("NODE_ENV", "test");
  authorizeMock.mockReset();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

describe("createMonitoringQueryAction", () => {
  it("rejects a locationId belonging to another organization", async () => {
    authorizeMock.mockResolvedValue(contextFor(ushg.admin()));
    const { createMonitoringQueryAction } = await import("@/app/actions/monitoring");

    const result = await createMonitoringQueryAction({
      ...BASE_INPUT,
      locationId: LOC_HARBOR_HOUSE, // Harbor's location, caller is USHG
    });

    expect(result.ok).toBe(false);

    // And nothing was written under the attacking id.
    const created = await dataSource.monitoringQueries.list(ushg.admin());
    expect(created.every((q) => q.locationId !== LOC_HARBOR_HOUSE)).toBe(true);
  });

  it("accepts a locationId that genuinely belongs to the caller's organization", async () => {
    authorizeMock.mockResolvedValue(contextFor(ushg.admin()));
    const { createMonitoringQueryAction } = await import("@/app/actions/monitoring");

    const result = await createMonitoringQueryAction({
      ...BASE_INPUT,
      locationId: LOC_SOHO, // USHG's own location
    });

    expect(result.ok).toBe(true);
  });
});

describe("updateMonitoringQueryAction", () => {
  it("rejects reassigning a query to another organization's locationId", async () => {
    const scope = ushg.admin();
    authorizeMock.mockResolvedValue(contextFor(scope));
    const { createMonitoringQueryAction, updateMonitoringQueryAction } = await import(
      "@/app/actions/monitoring"
    );

    const created = await createMonitoringQueryAction({ ...BASE_INPUT, locationId: null });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await updateMonitoringQueryAction({
      queryId: created.data.id,
      locationId: LOC_HARBOR_HOUSE,
    });

    expect(result.ok).toBe(false);

    const unchanged = await dataSource.monitoringQueries.get(scope, created.data.id);
    expect(unchanged?.locationId).toBeNull();
  });
});
