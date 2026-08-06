import { beforeEach, describe, expect, it } from "vitest";
import { freshDataSource, harbor, ORG_HARBOR, ORG_USHG, ushg } from "./helpers/scope";
import { firstIncompleteStep, isOnboardingComplete } from "@/domain";
import type { LiaDataSource } from "@/lib/data/types";
import { USER_DANIEL } from "@/lib/seed/dataset";

/**
 * The onboarding repository, against the demo adapter.
 *
 * Two properties matter more than the individual transitions:
 *
 * - **Idempotence.** Every transition is reachable twice — a double-submitted
 *   form, a refreshed confirmation, a retried action — and must not restamp
 *   progress. A trail that claims somebody finished a step an hour later than
 *   they did is a trail support cannot use.
 * - **Isolation.** Advancing one organization's setup must be invisible to
 *   every other. The scope is the only thing standing between them.
 */

let data: LiaDataSource;

beforeEach(() => {
  data = freshDataSource();
});

/** Provision a fresh organization the way sign-up does. */
async function provisionFresh() {
  const membership = await data.organizations.provision({
    userId: USER_DANIEL,
    name: "Bramble & Co",
  });

  return {
    organizationId: membership.organization.id,
    scope: {
      organizationId: membership.organization.id,
      userId: USER_DANIEL,
      role: "owner" as const,
    },
  };
}

describe("provisioning", () => {
  it("creates the onboarding row with the organization", async () => {
    const { scope } = await provisionFresh();

    const state = await data.onboarding.get(scope);
    expect(state).not.toBeNull();
    expect(state?.status).toBe("in_progress");
    expect(state?.currentStep).toBe("organization");
    expect(firstIncompleteStep(state!)).toBe("organization");
  });

  it("creates exactly one organization and one onboarding row", async () => {
    const before = await data.organizations.listForUser(USER_DANIEL);
    await provisionFresh();
    const after = await data.organizations.listForUser(USER_DANIEL);

    expect(after.length).toBe(before.length + 1);
  });
});

describe("seeded organizations", () => {
  it("are already complete, so established users are not sent to a wizard", async () => {
    for (const scope of [ushg.owner(), harbor.owner()]) {
      const state = await data.onboarding.get(scope);
      expect(state).not.toBeNull();
      expect(isOnboardingComplete(state!)).toBe(true);
      expect(state?.completedAt).not.toBeNull();
      // Backfilled at the organization's own creation instant, not "now": a
      // fabricated completion date is a fabricated fact.
      expect(state?.completedAt).toBe(state?.createdAt);
    }
  });

  it("records the ready screen as already seen", async () => {
    const state = await data.onboarding.get(ushg.owner());
    expect(state?.readyViewedAt).not.toBeNull();
  });
});

describe("transitions", () => {
  it("advances step by step", async () => {
    const { scope } = await provisionFresh();

    const one = await data.onboarding.completeOrganizationStep(scope, "6-20");
    expect(one.organizationCompletedAt).not.toBeNull();
    expect(one.organizationSize).toBe("6-20");
    expect(one.currentStep).toBe("connect_sources");

    const two = await data.onboarding.completeSourceStep(scope);
    expect(two.sourceCompletedAt).not.toBeNull();
    expect(two.currentStep).toBe("locations");

    const three = await data.onboarding.completeLocationsStep(scope);
    expect(three.locationsCompletedAt).not.toBeNull();

    const four = await data.onboarding.completeBrandVoiceStep(scope);
    expect(four.brandVoiceCompletedAt).not.toBeNull();

    const five = await data.onboarding.completeTeamStep(scope);
    expect(five.teamCompletedAt).not.toBeNull();
    expect(firstIncompleteStep(five)).toBeNull();
  });

  it("does not restamp a step that is already settled", async () => {
    const { scope } = await provisionFresh();

    const first = await data.onboarding.completeOrganizationStep(scope, "1");
    const again = await data.onboarding.completeOrganizationStep(scope, "51+");

    // The timestamp is the audit-relevant value and it holds. The size is
    // genuinely re-answerable — somebody correcting it on a second pass through
    // step 1 should have the correction stick.
    expect(again.organizationCompletedAt).toBe(first.organizationCompletedAt);
    expect(again.organizationSize).toBe("51+");
  });

  it("clears a skip when the step is later completed", async () => {
    const { scope } = await provisionFresh();
    await data.onboarding.completeOrganizationStep(scope, null);

    const skipped = await data.onboarding.skipSourceStep(scope);
    expect(skipped.sourceSkippedAt).not.toBeNull();
    expect(skipped.sourceCompletedAt).toBeNull();

    // They went back and connected. Both timestamps set at once would violate
    // the table's own check constraint.
    const completed = await data.onboarding.completeSourceStep(scope);
    expect(completed.sourceCompletedAt).not.toBeNull();
    expect(completed.sourceSkippedAt).toBeNull();
  });

  it("records a skip for each of the three skippable steps", async () => {
    const { scope } = await provisionFresh();
    await data.onboarding.completeOrganizationStep(scope, null);
    await data.onboarding.skipSourceStep(scope);
    await data.onboarding.skipLocationsStep(scope);
    await data.onboarding.completeBrandVoiceStep(scope);
    const state = await data.onboarding.skipTeamStep(scope);

    expect(state.sourceSkippedAt).not.toBeNull();
    expect(state.locationsSkippedAt).not.toBeNull();
    expect(state.teamSkippedAt).not.toBeNull();
    expect(firstIncompleteStep(state)).toBeNull();
  });
});

describe("completion", () => {
  async function settleEverything() {
    const { scope } = await provisionFresh();
    await data.onboarding.completeOrganizationStep(scope, null);
    await data.onboarding.completeSourceStep(scope);
    await data.onboarding.completeLocationsStep(scope);
    await data.onboarding.completeBrandVoiceStep(scope);
    await data.onboarding.completeTeamStep(scope);
    return scope;
  }

  it("marks the organization complete once every step is settled", async () => {
    const scope = await settleEverything();
    const done = await data.onboarding.completeOnboarding(scope);

    expect(done.status).toBe("completed");
    expect(done.completedAt).not.toBeNull();
    expect(done.currentStep).toBe("ready");
  });

  it("refuses to complete while a step is unsettled", async () => {
    const { scope } = await provisionFresh();
    await data.onboarding.completeOrganizationStep(scope, null);

    await expect(data.onboarding.completeOnboarding(scope)).rejects.toThrow();

    const state = await data.onboarding.get(scope);
    expect(state?.status).toBe("in_progress");
  });

  it("does not restamp an already-completed setup", async () => {
    const scope = await settleEverything();
    const first = await data.onboarding.completeOnboarding(scope);
    const second = await data.onboarding.completeOnboarding(scope);

    expect(second.completedAt).toBe(first.completedAt);
  });

  it("stamps the ready view once", async () => {
    const scope = await settleEverything();
    await data.onboarding.completeOnboarding(scope);

    const first = await data.onboarding.markReadyViewed(scope);
    const second = await data.onboarding.markReadyViewed(scope);

    expect(first.readyViewedAt).not.toBeNull();
    expect(second.readyViewedAt).toBe(first.readyViewedAt);
  });
});

describe("organization update", () => {
  it("writes the profile fields and leaves the slug alone", async () => {
    const scope = ushg.admin();
    const before = (await data.organizations.getById(ORG_USHG, scope.userId))!;

    const updated = await data.organizations.update(scope, {
      name: "Union Square Hospitality",
      websiteUrl: "https://ushg.example",
      industry: "Hotel or hospitality group",
      defaultTimezone: "America/Chicago",
      defaultLanguage: "en-GB",
    });

    expect(updated.name).toBe("Union Square Hospitality");
    expect(updated.websiteUrl).toBe("https://ushg.example");
    expect(updated.industry).toBe("Hotel or hospitality group");
    // The slug is not on the input type at all, so it cannot move.
    expect(updated.slug).toBe(before.organization.slug);
    expect(updated.id).toBe(ORG_USHG);
  });
});

describe("cross-organization isolation", () => {
  it("never returns another organization's progress", async () => {
    const mine = await data.onboarding.get(ushg.owner());
    const theirs = await data.onboarding.get(harbor.owner());

    expect(mine?.organizationId).toBe(ORG_USHG);
    expect(theirs?.organizationId).toBe(ORG_HARBOR);
  });

  it("keeps a transition inside the organization it was scoped to", async () => {
    const { scope } = await provisionFresh();
    await data.onboarding.completeOrganizationStep(scope, "21-50");

    // The other tenants are untouched: still completed, still no size.
    const untouched = await data.onboarding.get(ushg.owner());
    expect(untouched?.organizationSize).toBeNull();
    expect(untouched?.status).toBe("completed");
  });

  it("refuses to update an organization the scope does not name", async () => {
    // The scope carries Harbor's id, so the write lands on Harbor or nowhere —
    // there is no parameter through which USHG could be named.
    const updated = await data.organizations.update(harbor.owner(), {
      name: "Harbor renamed",
      websiteUrl: null,
      industry: "Retail",
      defaultTimezone: "UTC",
      defaultLanguage: "en-US",
    });

    expect(updated.id).toBe(ORG_HARBOR);

    const ushgOrganization = await data.organizations.getById(
      ORG_USHG,
      ushg.owner().userId,
    );
    expect(ushgOrganization?.organization.name).not.toBe("Harbor renamed");
  });
});
