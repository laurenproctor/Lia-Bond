import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { freshDataSource, harbor, ushg } from "./helpers/scope";
import {
  generateInvitationToken,
  hashInvitationToken,
} from "@/lib/auth/invitation-token";
import {
  INVITATION_TTL_DAYS,
  isOnboardingComplete,
  ONBOARDING_READY_PATH,
  resumePath,
} from "@/domain";
import { can } from "@/lib/auth/permissions";
import { DEFAULT_SIGN_IN_DESTINATION, safeDestination } from "@/lib/auth/redirect";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import { USER_DANIEL, USER_KATE } from "@/lib/seed/dataset";

/**
 * Sign-up, sign-in, and the guards' routing decisions.
 *
 * The guards themselves call `redirect()`, which throws inside Next's request
 * context and cannot be exercised in a plain Node test. What *can* be tested —
 * and what actually decides the outcome — is the pure function each guard asks:
 * `resumePath` for where to go, `can(role, "onboarding.manage")` for whether to
 * divert at all, and the repository for what state the organization is in. This
 * file exercises those against real provisioning and real invitations.
 */

const root = process.cwd();

function source(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

let data: LiaDataSource;

beforeEach(() => {
  data = freshDataSource();
});

/**
 * The decision `onboardingRedirectFor` makes, reproduced from its own inputs.
 *
 * Kept in step with the real function by the source assertions further down: if
 * the guard ever stops consulting `resumePath` or the permission, those fail.
 */
async function divertTo(
  scope: OrganizationScope,
  role: Parameters<typeof can>[0],
): Promise<string | null> {
  const state = await data.onboarding.get(scope);
  if (!state) return null;
  if (isOnboardingComplete(state)) return null;
  if (!can(role, "onboarding.manage")) return null;
  return resumePath(state);
}

describe("self-serve sign-up", () => {
  it("provisions exactly one organization with one onboarding row", async () => {
    const before = await data.organizations.listForUser(USER_DANIEL);

    const membership = await data.organizations.provision({
      userId: USER_DANIEL,
      name: "Bramble & Co",
    });

    const after = await data.organizations.listForUser(USER_DANIEL);
    expect(after.length).toBe(before.length + 1);

    const scope: OrganizationScope = {
      organizationId: membership.organization.id,
      userId: USER_DANIEL,
      role: "owner",
    };
    const state = await data.onboarding.get(scope);
    expect(state).not.toBeNull();
    expect(state?.status).toBe("in_progress");
  });

  it("sends the new owner to step 1, not the overview", async () => {
    const membership = await data.organizations.provision({
      userId: USER_DANIEL,
      name: "Bramble & Co",
    });
    const scope: OrganizationScope = {
      organizationId: membership.organization.id,
      userId: USER_DANIEL,
      role: "owner",
    };

    expect(await divertTo(scope, "owner")).toBe("/onboarding/organization");
  });

  it("redirects to onboarding from the sign-up action itself", () => {
    const auth = source("src/app/actions/auth.ts");
    expect(auth).toContain('const ONBOARDING_FIRST_STEP = "/onboarding/organization"');
    expect(auth).toContain("redirect(ONBOARDING_FIRST_STEP)");
  });

  it("carries the organization name in signup metadata for the confirm path", () => {
    const auth = source("src/app/actions/auth.ts");
    expect(auth).toContain("PENDING_ORGANIZATION_METADATA_KEY");
    expect(auth).toContain("emailRedirectTo");
  });
});

describe("invitation-based sign-up", () => {
  it("creates no organization of its own", async () => {
    const token = generateInvitationToken();
    await data.invitations.create(ushg.admin(), {
      email: "newcomer@example.com",
      role: "communications_lead",
      tokenHash: hashInvitationToken(token),
      invitedByUserId: USER_KATE,
      expiresAt: new Date(
        Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000,
      ).toISOString(),
    });

    const organizationsBefore = (await data.organizations.listForUser(USER_DANIEL))
      .length;

    // `acceptInvitationWithSignUpAction` never calls `provision`. What it does
    // call is `accept`, which grants a membership in an existing organization.
    const auth = source("src/app/actions/auth.ts");
    const acceptBlock = auth.slice(auth.indexOf("acceptInvitationWithSignUpAction"));
    expect(acceptBlock).not.toContain("organizations.provision");
    expect(acceptBlock).toContain("invitations.accept");

    const organizationsAfter = (await data.organizations.listForUser(USER_DANIEL))
      .length;
    expect(organizationsAfter).toBe(organizationsBefore);
  });

  it("does not provision for anybody who already belongs somewhere", () => {
    // The guarantee is a membership check, not a check on which form was
    // submitted — so it holds for an invitee no matter how they arrive.
    const postAuth = source("src/lib/onboarding/post-auth.ts");
    expect(postAuth).toContain("organizations.listForUser");
    expect(postAuth).toContain("if (memberships.length > 0)");
  });

  it("lands an invitee in a completed organization on the overview", async () => {
    // The seeded tenants are complete, so no diversion happens for any role.
    expect(await divertTo(ushg.comms(), "communications_lead")).toBeNull();
    expect(safeDestination(undefined)).toBe(DEFAULT_SIGN_IN_DESTINATION);
  });
});

describe("completed organizations", () => {
  it("are never diverted into the wizard", async () => {
    for (const scope of [ushg.owner(), ushg.admin(), harbor.owner()]) {
      expect(await divertTo(scope, scope.role)).toBeNull();
    }
  });

  it("keep their requested destination on sign-in", () => {
    expect(safeDestination("/reviews/google/abc")).toBe("/reviews/google/abc");
  });
});

describe("incomplete organizations", () => {
  async function partiallySetUp(): Promise<OrganizationScope> {
    const membership = await data.organizations.provision({
      userId: USER_DANIEL,
      name: "Half Way Co",
    });
    const scope: OrganizationScope = {
      organizationId: membership.organization.id,
      userId: USER_DANIEL,
      role: "owner",
    };
    await data.onboarding.completeOrganizationStep(scope, "2-5");
    await data.onboarding.skipSourceStep(scope);
    return scope;
  }

  it("resume at the step they left off on", async () => {
    const scope = await partiallySetUp();
    expect(await divertTo(scope, "owner")).toBe("/onboarding/locations");
  });

  it("resume at the same step after signing out and back in", async () => {
    const scope = await partiallySetUp();
    const first = await divertTo(scope, "owner");

    // Nothing is held in a cookie or in wizard state, so a second resolution
    // from a cold session gives the same answer.
    const second = await divertTo(scope, "owner");
    expect(second).toBe(first);
  });

  it("divert owners and admins but not other roles", async () => {
    const scope = await partiallySetUp();

    expect(await divertTo(scope, "owner")).toBe("/onboarding/locations");
    expect(await divertTo(scope, "admin")).toBe("/onboarding/locations");
    // An analyst cannot operate a single step of the wizard, so sending them
    // there would strand them at a form with every control refused.
    expect(await divertTo(scope, "analyst")).toBeNull();
    expect(await divertTo(scope, "viewer")).toBeNull();
    expect(await divertTo(scope, "communications_lead")).toBeNull();
  });

  it("send a finished-but-unmarked setup back to the last step", async () => {
    const scope = await partiallySetUp();
    await data.onboarding.completeLocationsStep(scope);
    await data.onboarding.completeBrandVoiceStep(scope);
    await data.onboarding.completeTeamStep(scope);

    // Every step settled, status still in progress: the completion write never
    // landed. They must be able to press Finish setup again.
    expect(await divertTo(scope, "owner")).toBe("/onboarding/team");
  });

  it("send a completed setup to the ready screen", async () => {
    const scope = await partiallySetUp();
    await data.onboarding.completeLocationsStep(scope);
    await data.onboarding.completeBrandVoiceStep(scope);
    await data.onboarding.completeTeamStep(scope);
    const done = await data.onboarding.completeOnboarding(scope);

    expect(resumePath(done)).toBe(ONBOARDING_READY_PATH);
    // …and from then on, no diversion at all.
    expect(await divertTo(scope, "owner")).toBeNull();
  });
});

describe("the guards themselves", () => {
  const context = source("src/lib/onboarding/context.ts");

  it("recompute the resume point rather than trusting `current_step`", () => {
    // A stored step is advisory. Trusting it would let a tampered or stale
    // value unlock a step whose prerequisites were never met.
    expect(context).toContain("isStepReachable");
    expect(context).toContain("resumePath");
  });

  it("check the permission before diverting", () => {
    expect(context).toContain('can(context.role, "onboarding.manage")');
  });

  it("point in opposite directions, so they cannot loop", () => {
    // The wizard guard sends *completed* organizations out.
    expect(context).toMatch(/isOnboardingComplete\(state\)[\s\S]{0,80}redirect\("\/overview"\)/);
    // The app-shell guard sends *incomplete* ones in, and returns null
    // otherwise.
    expect(context).toContain("if (isOnboardingComplete(state)) return null;");
  });

  it("run before the app shell renders anything", () => {
    const layout = source("src/app/(app)/layout.tsx");
    const guardAt = layout.indexOf("redirectIfOnboarding()");
    const shellAt = layout.indexOf("<AppShell");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(shellAt);
  });

  it("keep the ready screen out of the five-step guard", () => {
    // `/onboarding/ready` uses its own guard with the mirror-image rules.
    expect(context).toContain("requireOnboardingReady");
    const ready = source("src/app/onboarding/ready/page.tsx");
    expect(ready).toContain("requireOnboardingReady");
    expect(ready).not.toContain("requireOnboardingStep");
  });
});

describe("the ready screen's framing", () => {
  it("renders no five-step progress strip", () => {
    const ready = source("src/app/onboarding/ready/page.tsx");
    // The shell only renders the strip for a non-null step.
    expect(ready).toContain("step={null}");
    expect(ready).not.toContain("OnboardingProgress");

    const shell = source("src/components/onboarding/onboarding-shell.tsx");
    expect(shell).toContain("{step ? <OnboardingProgress");
  });

  it("shows no current-step badge", () => {
    const ready = source("src/app/onboarding/ready/page.tsx");
    expect(ready).not.toContain("stepEyebrow");
    expect(ready).not.toMatch(/STEP \d OF/i);
  });
});
