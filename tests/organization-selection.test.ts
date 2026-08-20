import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { freshDataSource, ORG_HARBOR, ORG_USHG } from "./helpers/scope";
import type { LiaDataSource } from "@/lib/data/types";
import {
  generateInvitationToken,
  hashInvitationToken,
} from "@/lib/auth/invitation-token";
import { INVITATION_TTL_DAYS } from "@/domain";
import { USER_DANIEL, USER_KATE, USER_SOFIA } from "@/lib/seed/dataset";

/**
 * Which organization a request acts as, and how it gets chosen.
 *
 * The single most important thing about this file: **every assertion uses a
 * user with more than one membership.** `getOrganizationContext` falls back to
 * the first organization a person belongs to when the cookie names one they do
 * not, so for a single-membership account every selection bug produces the
 * right answer anyway. That fallback is why the invitation-acceptance defect
 * survived unnoticed, and a test written against a one-organization user would
 * have gone on not noticing it.
 */

const { requireSession } = vi.hoisted(() => ({ requireSession: vi.fn() }));
const { cookieSet, cookieGet } = vi.hoisted(() => ({
  cookieSet: vi.fn(),
  cookieGet: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  requireSession: () => requireSession(),
  getSession: () => requireSession(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    set: cookieSet,
    get: (name: string) => cookieGet(name),
  }),
}));

vi.mock("next/cache", () => ({ revalidatePath: () => {} }));

let dataSource: LiaDataSource;

vi.mock("@/lib/data", () => ({
  getDataSource: async () => dataSource,
}));

beforeEach(() => {
  dataSource = freshDataSource();
  requireSession.mockReset();
  cookieSet.mockReset();
  cookieGet.mockReset();
  cookieGet.mockReturnValue(undefined);
  requireSession.mockResolvedValue({ id: USER_DANIEL, email: "daniel@example.com" });
});

describe("an account with no memberships", () => {
  it("is sent to create an organization rather than to a dead end", async () => {
    const { postAuthDestination } = await import("@/lib/onboarding/post-auth");

    // An account holding no membership rows at all.
    //
    // Deliberately a signed-in id that no membership references, rather than
    // stripping a seeded user's memberships: every seeded user is the last
    // active owner of something, and the constraint trigger that protects
    // against an ownerless organization refuses to remove them — correctly.
    // The condition being tested is "belongs to nothing", and an id with no
    // rows is that condition exactly.
    requireSession.mockResolvedValue({
      id: "00000000-0000-4000-8000-0000000000aa",
      email: "nobody@example.com",
    });

    expect(await postAuthDestination("/mentions")).toEqual("/organizations/new");
  });

  it("does not divert somebody who does belong somewhere", async () => {
    const { postAuthDestination } = await import("@/lib/onboarding/post-auth");

    const destination = await postAuthDestination("/mentions");
    expect(destination).not.toEqual("/organizations/new");
  });
});

describe("accepting an invitation selects the organization joined", () => {
  it("switches a user who already belonged elsewhere", async () => {
    const { acceptInvitationAction } = await import("@/app/actions/invitations");

    // Kate is an admin in USHG. Harbor invites her — so at the moment she
    // accepts she holds two memberships, and "the first one" is the wrong
    // answer. This is the case the old code got wrong silently.
    const token = generateInvitationToken();
    await dataSource.invitations.create(
      { organizationId: ORG_HARBOR, userId: USER_SOFIA, role: "owner" },
      {
        email: "kate.morgan@example.com",
        role: "communications_lead",
        tokenHash: hashInvitationToken(token),
        invitedByUserId: USER_SOFIA,
        expiresAt: new Date(
          Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000,
        ).toISOString(),
      },
    );

    requireSession.mockResolvedValue({ id: USER_KATE, email: "kate.morgan@example.com" });

    const result = await acceptInvitationAction({ token });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.organizationId).toEqual(ORG_HARBOR);
    expect(cookieSet).toHaveBeenCalledWith(
      "lia_active_organization",
      ORG_HARBOR,
      expect.objectContaining({ httpOnly: true, sameSite: "lax", path: "/" }),
    );
  });
});

describe("a forged active-organization cookie", () => {
  it("grants nothing, and resolves to a membership the caller really holds", async () => {
    const { getOrganizationContext } = await import("@/lib/tenancy/organization-context");

    // Daniel belongs to USHG and Harbor. A cookie naming an organization he is
    // not in must not select it — and because he has two real memberships, the
    // fallback landing on a *correct* one is a meaningful result rather than
    // the only possible one.
    const forged = "00000000-0000-4000-8000-00000000dead";
    cookieGet.mockReturnValue({ value: forged });

    const context = await getOrganizationContext();

    expect(context.organization.id).not.toEqual(forged);
    expect([ORG_USHG, ORG_HARBOR]).toContain(context.organization.id);
    expect(context.scope.organizationId).toEqual(context.organization.id);
  });

  it("ignores a value that is not a uuid at all", async () => {
    const { getOrganizationContext } = await import("@/lib/tenancy/organization-context");

    cookieGet.mockReturnValue({ value: "'; drop table organizations; --" });

    const context = await getOrganizationContext();
    expect([ORG_USHG, ORG_HARBOR]).toContain(context.organization.id);
  });

  it("honours a cookie that names an organization the caller does belong to", async () => {
    const { getOrganizationContext } = await import("@/lib/tenancy/organization-context");

    // The control. Without it the two checks above would pass against a
    // resolver that ignored the cookie entirely.
    cookieGet.mockReturnValue({ value: ORG_HARBOR });

    const context = await getOrganizationContext();
    expect(context.organization.id).toEqual(ORG_HARBOR);
    expect(context.role).toEqual("viewer");
  });
});

describe("the switcher's own wiring", () => {
  /**
   * Source-text guards, not behavioural proof.
   *
   * Vitest runs in a node environment here with no testing-library dependency
   * (D74), so a component's rendered output is not reachable from this suite.
   * These pin the two things about `OrgSwitcher` that are easy to delete by
   * accident and expensive to discover: the navigation after a switch, and the
   * create entry. The acceptance proof for both is the browser pass in the
   * plan's Task F2 — this is a tripwire, not a substitute.
   */
  const source = readFileSync("src/components/shell/org-switcher.tsx", "utf8");

  it("navigates to the overview after switching", () => {
    // Switching used to leave the browser on the current URL, which 404s from
    // any record-detail route: the page re-renders under the new scope and asks
    // it for the old organization's record id.
    expect(source).toContain('router.push("/overview")');
  });

  it("offers a way to create an organization", () => {
    expect(source).toContain('href="/organizations/new"');
  });

  it("does not gate the create entry on a permission", () => {
    // Creating an organization is a property of holding an account, not of any
    // role in the one currently active. A `can(` call in this file would mean
    // somebody had added a check that does not belong.
    expect(source).not.toContain("can(");
  });

  it("keeps the listbox role on the options list, not the popover", () => {
    // Everything inside a listbox is announced as an option. The popover also
    // holds an error line and the create link, neither of which is selectable.
    expect(source).toContain('<ul\n            role="listbox"');
  });
});

describe("the onboarding wizard is escapable when there is somewhere to go", () => {
  /**
   * Found in a browser, not by a test: creating a second organization makes it
   * active, `redirectIfOnboarding` diverts its owner into setup, and every
   * product route bounces back — so somebody with three working organizations
   * could be locked out of all of them by the fourth. Even
   * `/organizations/new`'s "Back to Lia" link led to `/overview`, which
   * redirected straight back.
   *
   * These are source guards. The behaviour itself is proven in the browser; what
   * they catch is the regression that costs nothing to make and is invisible
   * until somebody is stuck — a new step page that forgets to pass the
   * memberships through, which would silently render the wizard without its
   * only way out.
   */
  const STEP_PAGES = [
    "organization",
    "connect-sources",
    "locations",
    "brand-voice",
    "team",
    "ready",
  ];

  it("hands every onboarding screen the caller's memberships", () => {
    for (const step of STEP_PAGES) {
      const source = readFileSync(`src/app/onboarding/${step}/page.tsx`, "utf8");
      expect(source, `${step} must pass organizations to OnboardingShell`).toContain(
        "organizations={context.available}",
      );
      expect(source, `${step} must pass the active organization`).toContain(
        "activeOrganizationId={context.organization.id}",
      );
    }
  });

  it("only offers the escape when another organization exists", () => {
    // A single-organization signup — still the common path — must see the
    // wizard exactly as it was: no navigation, nothing to click away to.
    const source = readFileSync(
      "src/components/onboarding/onboarding-org-escape.tsx",
      "utf8",
    );
    expect(source).toContain("if (others.length === 0) return null;");
  });

  it("leaves setup for the overview rather than staying put", () => {
    const source = readFileSync(
      "src/components/onboarding/onboarding-org-escape.tsx",
      "utf8",
    );
    expect(source).toContain('router.push("/overview")');
  });
});
