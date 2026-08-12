import { beforeEach, describe, expect, it, vi } from "vitest";
import { updateEscalationStatusAction } from "@/app/actions/escalations";
import { demoStore } from "@/lib/data/demo/store";
import type { Escalation, Mention } from "@/domain";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import { LOC_SOHO, LOC_UES } from "@/lib/seed/dataset";
import { freshDataSource, ushg } from "./helpers/scope";

/**
 * Location scoping on `updateEscalationStatusAction` (P0-4).
 *
 * `escalation.update_status` is granted to `location_manager` in the
 * permission matrix "only where scoping constrains them" — but the action
 * used org-wide `authorize()`, which never looked at the escalation's
 * location at all. A location manager could move the status of any
 * organization's escalation, not just the ones for restaurants they manage.
 *
 * The fix follows `updateMentionStatusAction`'s pattern
 * (`src/app/actions/mentions.ts`): resolve via `mutationContext()`, load the
 * escalation, load its mention *explicitly* (no optional chaining — a
 * missing mention fails closed rather than silently granting access), then
 * check `assertPermissionForLocation` against the mention's location.
 *
 * `@/lib/actions/guard` is partially mocked: `mutationContext` is replaced
 * with a controllable stub (there is no `next/headers` session machinery
 * under Vitest), but `assertPermissionForLocation` and `assertPermission`
 * pass through to their real implementations via `importOriginal`, so these
 * tests exercise the genuine role/location matrix against a real demo
 * `dataSource`, not a test-only shortcut.
 */

const mutationContextMock = vi.fn();

vi.mock("@/lib/actions/guard", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/actions/guard")>();
  return {
    ...actual,
    mutationContext: () => mutationContextMock(),
  };
});

// `revalidatePath` requires a live Next.js request scope that does not exist
// under Vitest; the action calls it on the success path, so it is stubbed to
// a no-op the same way a route or component test would get it for free from
// the Next test runtime.
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

/** The first escalation whose mention has exactly this location (or null). */
async function escalationAtLocation(
  scope: OrganizationScope,
  locationId: string | null,
): Promise<Escalation> {
  const escalations = await dataSource.escalations.list(scope);
  for (const escalation of escalations) {
    const mention = await dataSource.mentions.get(scope, escalation.mentionId);
    if (mention && mention.locationId === locationId) return escalation;
  }
  throw new Error(`Fixture expected an escalation at location ${String(locationId)}.`);
}

/** An escalation whose mention belongs to a real location Priya does not manage. */
async function escalationAtOtherManagedLocation(
  scope: OrganizationScope,
): Promise<Escalation> {
  const escalations = await dataSource.escalations.list(scope);
  for (const escalation of escalations) {
    const mention = await dataSource.mentions.get(scope, escalation.mentionId);
    if (mention && mention.locationId !== null && mention.locationId !== LOC_SOHO && mention.locationId !== LOC_UES) {
      return escalation;
    }
  }
  throw new Error("Fixture expected an escalation at a location outside Priya's assignment.");
}

beforeEach(() => {
  dataSource = freshDataSource();
  mutationContextMock.mockReset();
});

describe("updateEscalationStatusAction location scoping", () => {
  it("refuses a location manager acting on an escalation whose mention belongs to another location", async () => {
    const scope = ushg.locationManager();
    mutationContextMock.mockResolvedValue(contextFor(scope));

    const escalation = await escalationAtOtherManagedLocation(scope);

    const result = await updateEscalationStatusAction({
      escalationId: escalation.id,
      status: "pending_approval",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/only act on records for the locations you manage/);

    const unchanged = await dataSource.escalations.get(scope, escalation.id);
    expect(unchanged?.status).toBe(escalation.status);
  });

  it("lets a location manager act on an escalation whose mention belongs to their own location", async () => {
    const scope = ushg.locationManager();
    mutationContextMock.mockResolvedValue(contextFor(scope));

    const escalation = await escalationAtLocation(scope, LOC_SOHO);

    const result = await updateEscalationStatusAction({
      escalationId: escalation.id,
      status: "pending_approval",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("pending_approval");
  });

  it("refuses a location manager when the escalation's mention has no location (organization-wide)", async () => {
    const scope = ushg.locationManager();
    mutationContextMock.mockResolvedValue(contextFor(scope));

    const escalation = await escalationAtLocation(scope, null);

    const result = await updateEscalationStatusAction({
      escalationId: escalation.id,
      status: "pending_approval",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/only act on records for the locations you manage/);
  });

  it("fails closed with 'Mention was not found' when the escalation's mention is missing", async () => {
    const scope = ushg.locationManager();
    mutationContextMock.mockResolvedValue(contextFor(scope));

    const escalation = await escalationAtLocation(scope, LOC_SOHO);

    // Store surgery: the mention this escalation points at is gone, e.g. a
    // data-integrity gap. The action must not treat "no mention" as
    // "no restriction" — it has to fail closed with a typed not-found error.
    const mentions = demoStore().mentions;
    const index = mentions.findIndex((row: Mention) => row.id === escalation.mentionId);
    expect(index).toBeGreaterThanOrEqual(0);
    mentions.splice(index, 1);

    const result = await updateEscalationStatusAction({
      escalationId: escalation.id,
      status: "pending_approval",
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("Mention was not found.");
  });

  it("lets an owner update any escalation regardless of location", async () => {
    const scope = ushg.owner();
    mutationContextMock.mockResolvedValue(contextFor(scope));

    const escalation = await escalationAtOtherManagedLocation(scope);

    const result = await updateEscalationStatusAction({
      escalationId: escalation.id,
      status: "pending_approval",
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("pending_approval");
  });
});
