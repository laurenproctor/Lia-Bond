import { beforeEach, describe, expect, it } from "vitest";
import { freshDataSource, harbor, ORG_USHG, ushg } from "./helpers/scope";
import {
  generateInvitationToken,
  hashInvitationToken,
  isInvitationTokenShaped,
} from "@/lib/auth/invitation-token";
import { INVITABLE_ROLES, INVITATION_TTL_DAYS, invitationState } from "@/domain";
import type { LiaDataSource } from "@/lib/data/types";
import { USER_DANIEL, USER_JORDAN, USER_KATE } from "@/lib/seed/dataset";

/**
 * Membership: provisioning, invitations, and the guardrails around ownership.
 *
 * Against the demo adapter, which is where the rules can be exercised without
 * a database. The Supabase adapter enforces the same rules a second time in
 * SQL — the last-owner check is a constraint trigger and the email match is
 * inside `accept_invitation` — because a rule that lives only in application
 * code protects only the paths that remember to call it.
 */

let data: LiaDataSource;

beforeEach(() => {
  data = freshDataSource();
});

function inSevenDays(): string {
  return new Date(Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000).toISOString();
}

/** Issue an invitation and keep the token, as the action does. */
async function invite(
  email: string,
  role: (typeof INVITABLE_ROLES)[number] = "viewer",
) {
  const token = generateInvitationToken();
  const invitation = await data.invitations.create(ushg.admin(), {
    email,
    role,
    tokenHash: hashInvitationToken(token),
    invitedByUserId: USER_KATE,
    expiresAt: inSevenDays(),
  });
  return { token, invitation };
}

describe("invitation tokens", () => {
  it("issues something long and unguessable", () => {
    const token = generateInvitationToken();
    // 32 bytes, base64url — 43 characters, no padding.
    expect(token).toHaveLength(43);
    expect(isInvitationTokenShaped(token)).toBe(true);
  });

  it("does not repeat", () => {
    const tokens = new Set(Array.from({ length: 500 }, generateInvitationToken));
    expect(tokens.size).toBe(500);
  });

  it("hashes to something that is not the token", () => {
    const token = generateInvitationToken();
    const hash = hashInvitationToken(token);

    expect(hash).not.toBe(token);
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    // Stable, or the lookup would never match twice.
    expect(hashInvitationToken(token)).toBe(hash);
  });

  it("rejects values it did not issue", () => {
    expect(isInvitationTokenShaped("")).toBe(false);
    expect(isInvitationTokenShaped("short")).toBe(false);
    // Path traversal and SQL-ish payloads never reach a query.
    expect(isInvitationTokenShaped("../../etc/passwd")).toBe(false);
    expect(isInvitationTokenShaped("' or 1=1--")).toBe(false);
  });
});

describe("provisioning an organization", () => {
  it("creates the organization and makes the caller its owner", async () => {
    const result = await data.organizations.provision({
      userId: USER_JORDAN,
      name: "Blue Door Group",
    });

    expect(result.organization.name).toBe("Blue Door Group");
    expect(result.role).toBe("owner");
    expect(result.status).toBe("active");
  });

  it("derives a url-safe slug rather than accepting one", async () => {
    const result = await data.organizations.provision({
      userId: USER_JORDAN,
      name: "  Chez Marie's Bistro & Bar!  ",
    });

    expect(result.organization.slug).toMatch(/^[a-z0-9]+(-[a-z0-9]+)*$/);
    expect(result.organization.name).toBe("Chez Marie's Bistro & Bar!");
  });

  it("does not collide when two groups share a name", async () => {
    const first = await data.organizations.provision({
      userId: USER_JORDAN,
      name: "Harbor and Vine",
    });
    const second = await data.organizations.provision({
      userId: USER_KATE,
      name: "Harbor and Vine",
    });

    expect(second.organization.slug).not.toBe(first.organization.slug);
  });

  it("makes the new organization visible to its owner and nobody else", async () => {
    const created = await data.organizations.provision({
      userId: USER_JORDAN,
      name: "Blue Door Group",
    });

    const mine = await data.organizations.listForUser(USER_JORDAN);
    expect(mine.map((entry) => entry.organization.id)).toContain(
      created.organization.id,
    );

    const theirs = await data.organizations.listForUser(USER_DANIEL);
    expect(theirs.map((entry) => entry.organization.id)).not.toContain(
      created.organization.id,
    );
  });

  it("refuses a blank name", async () => {
    await expect(
      data.organizations.provision({ userId: USER_JORDAN, name: "   " }),
    ).rejects.toThrow();
  });
});

describe("issuing invitations", () => {
  it("stores the hash, and nothing that resembles the token", async () => {
    const { token, invitation } = await invite("new.person@example.com");

    // The token must not be recoverable from anything the repository returns.
    const serialised = JSON.stringify(invitation);
    expect(serialised).not.toContain(token);
    expect(serialised).not.toContain(hashInvitationToken(token));
  });

  it("lower-cases the address, so case cannot break acceptance", async () => {
    const { invitation } = await invite("Mixed.Case@Example.COM");
    expect(invitation.email).toBe("mixed.case@example.com");
  });

  it("refuses a second live invitation for the same address", async () => {
    await invite("twice@example.com");
    await expect(invite("twice@example.com")).rejects.toThrow(/pending invitation/i);
  });

  it("refuses to invite somebody who is already a member", async () => {
    const members = await data.memberships.listMembers(ushg.admin());
    const existing = members[0]!;

    await expect(invite(existing.user.email)).rejects.toThrow(/already a member/i);
  });

  it("lists pending invitations for the organization that issued them", async () => {
    await invite("pending@example.com");

    const ours = await data.invitations.listPending(ushg.admin());
    expect(ours.map((row) => row.email)).toContain("pending@example.com");

    // The other tenant must not see it. This is the isolation that matters:
    // an invitation carries an address and a role.
    const theirs = await data.invitations.listPending(harbor.owner());
    expect(theirs.map((row) => row.email)).not.toContain("pending@example.com");
  });
});

describe("previewing an invitation", () => {
  it("answers for a valid token", async () => {
    const { token } = await invite("preview@example.com", "approver");
    const preview = await data.invitations.preview(hashInvitationToken(token));

    expect(preview).not.toBeNull();
    expect(preview?.email).toBe("preview@example.com");
    expect(preview?.role).toBe("approver");
    expect(preview?.state).toBe("pending");
  });

  it("says nothing about a token that was never issued", async () => {
    const preview = await data.invitations.preview(
      hashInvitationToken(generateInvitationToken()),
    );
    expect(preview).toBeNull();
  });

  it("reports a revoked invitation as revoked rather than missing", async () => {
    const { token, invitation } = await invite("revoked@example.com");
    await data.invitations.revoke(ushg.admin(), invitation.id);

    // The lookup survives revocation on purpose, so the page can say what
    // happened. Acceptance is gated on the status, not on the hash existing.
    const preview = await data.invitations.preview(hashInvitationToken(token));
    expect(preview?.state).toBe("revoked");
  });

  it("reports a spent invitation as accepted", async () => {
    const token = generateInvitationToken();
    const members = await data.memberships.listMembers(ushg.admin());
    const jordan = members.find((member) => member.userId === USER_JORDAN)!;

    await data.invitations.create(harbor.owner(), {
      email: jordan.user.email,
      role: "viewer",
      tokenHash: hashInvitationToken(token),
      invitedByUserId: harbor.owner().userId,
      expiresAt: inSevenDays(),
    });
    await data.invitations.accept(hashInvitationToken(token), USER_JORDAN);

    // "Already used — sign in instead" is a far better dead end than
    // "not valid", which reads as a bug in the link.
    const preview = await data.invitations.preview(hashInvitationToken(token));
    expect(preview?.state).toBe("accepted");
  });
});

describe("accepting an invitation", () => {
  it("grants the invited role to the invited person", async () => {
    // Jordan is an analyst in USHG already; invite them into Harbor instead,
    // where they hold nothing.
    const token = generateInvitationToken();
    const members = await data.memberships.listMembers(ushg.admin());
    const jordan = members.find((member) => member.userId === USER_JORDAN)!;

    await data.invitations.create(harbor.owner(), {
      email: jordan.user.email,
      role: "approver",
      tokenHash: hashInvitationToken(token),
      invitedByUserId: harbor.owner().userId,
      expiresAt: inSevenDays(),
    });

    const result = await data.invitations.accept(
      hashInvitationToken(token),
      USER_JORDAN,
    );

    const joined = await data.organizations.listForUser(USER_JORDAN);
    const entry = joined.find(
      (row) => row.organization.id === result.organizationId,
    );
    expect(entry?.role).toBe("approver");
    expect(entry?.status).toBe("active");
  });

  it("refuses when the accepting account is not the invited address", async () => {
    const { token } = await invite("someone.else@example.com");

    // Kate holds the link but it was not addressed to her. This is the check
    // that makes a copyable link safe to send over any channel.
    await expect(
      data.invitations.accept(hashInvitationToken(token), USER_KATE),
    ).rejects.toThrow(/cannot be accepted/i);
  });

  it("cannot be used twice", async () => {
    const token = generateInvitationToken();
    const members = await data.memberships.listMembers(ushg.admin());
    const jordan = members.find((member) => member.userId === USER_JORDAN)!;

    await data.invitations.create(harbor.owner(), {
      email: jordan.user.email,
      role: "viewer",
      tokenHash: hashInvitationToken(token),
      invitedByUserId: harbor.owner().userId,
      expiresAt: inSevenDays(),
    });

    await data.invitations.accept(hashInvitationToken(token), USER_JORDAN);

    await expect(
      data.invitations.accept(hashInvitationToken(token), USER_JORDAN),
    ).rejects.toThrow(/cannot be accepted/i);
  });

  it("refuses an expired invitation", async () => {
    const token = generateInvitationToken();
    const members = await data.memberships.listMembers(ushg.admin());
    const jordan = members.find((member) => member.userId === USER_JORDAN)!;

    await data.invitations.create(harbor.owner(), {
      email: jordan.user.email,
      role: "viewer",
      tokenHash: hashInvitationToken(token),
      invitedByUserId: harbor.owner().userId,
      // Already dead when it was written.
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    });

    await expect(
      data.invitations.accept(hashInvitationToken(token), USER_JORDAN),
    ).rejects.toThrow(/cannot be accepted/i);
  });

  it("refuses a revoked invitation", async () => {
    const token = generateInvitationToken();
    const members = await data.memberships.listMembers(ushg.admin());
    const jordan = members.find((member) => member.userId === USER_JORDAN)!;

    const invitation = await data.invitations.create(harbor.owner(), {
      email: jordan.user.email,
      role: "viewer",
      tokenHash: hashInvitationToken(token),
      invitedByUserId: harbor.owner().userId,
      expiresAt: inSevenDays(),
    });

    await data.invitations.revoke(harbor.owner(), invitation.id);

    await expect(
      data.invitations.accept(hashInvitationToken(token), USER_JORDAN),
    ).rejects.toThrow(/cannot be accepted/i);
  });
});

describe("the last owner", () => {
  it("cannot be demoted", async () => {
    // Daniel is the only owner of USHG in the seed.
    const owners = (await data.memberships.listMembers(ushg.owner())).filter(
      (member) => member.role === "owner" && member.status === "active",
    );
    expect(owners).toHaveLength(1);

    await expect(
      data.memberships.updateRole(ushg.owner(), USER_DANIEL, "admin"),
    ).rejects.toThrow(/only owner/i);
  });

  it("cannot be suspended", async () => {
    await expect(
      data.memberships.updateStatus(ushg.owner(), USER_DANIEL, "suspended"),
    ).rejects.toThrow(/only owner/i);
  });

  it("cannot be removed", async () => {
    await expect(
      data.memberships.remove(ushg.owner(), USER_DANIEL),
    ).rejects.toThrow(/only owner/i);
  });

  it("can be demoted once somebody else is an owner", async () => {
    // The handover an organization actually needs to be able to perform.
    await data.memberships.updateRole(ushg.owner(), USER_KATE, "owner");
    const updated = await data.memberships.updateRole(
      ushg.owner(),
      USER_DANIEL,
      "admin",
    );

    expect(updated.role).toBe("admin");
    expect(await data.memberships.countActiveOwners(ushg.owner())).toBe(1);
  });
});

describe("member management", () => {
  it("suspending revokes access without deleting anything", async () => {
    const suspended = await data.memberships.updateStatus(
      ushg.owner(),
      USER_JORDAN,
      "suspended",
    );
    expect(suspended.status).toBe("suspended");

    // Still on the roster — the record is intact.
    const members = await data.memberships.listMembers(ushg.owner());
    expect(members.map((member) => member.userId)).toContain(USER_JORDAN);

    // But no longer holds the organization.
    const theirs = await data.organizations.listForUser(USER_JORDAN);
    expect(theirs.map((entry) => entry.organization.id)).not.toContain(ORG_USHG);
  });

  it("suspending removes them from assignee pickers", async () => {
    await data.memberships.updateStatus(ushg.owner(), USER_JORDAN, "suspended");

    const assignable = await data.memberships.listAssignableUsers(ushg.owner());
    expect(assignable.map((user) => user.id)).not.toContain(USER_JORDAN);
  });

  it("removing takes them off the roster", async () => {
    await data.memberships.remove(ushg.owner(), USER_JORDAN);

    const members = await data.memberships.listMembers(ushg.owner());
    expect(members.map((member) => member.userId)).not.toContain(USER_JORDAN);
  });

  it("cannot reach into another organization", async () => {
    // Harbor's owner naming a USHG user. The scope is the tenant boundary, and
    // it is the only thing that decides which rows are reachable.
    await expect(
      data.memberships.updateRole(harbor.owner(), USER_JORDAN, "admin"),
    ).rejects.toThrow();
  });

  it("counts only active owners", async () => {
    expect(await data.memberships.countActiveOwners(ushg.owner())).toBe(1);

    await data.memberships.updateRole(ushg.owner(), USER_KATE, "owner");
    expect(await data.memberships.countActiveOwners(ushg.owner())).toBe(2);

    await data.memberships.updateStatus(ushg.owner(), USER_KATE, "suspended");
    expect(await data.memberships.countActiveOwners(ushg.owner())).toBe(1);
  });
});

describe("invitation state", () => {
  it("reports expiry without a stored status", () => {
    const base = {
      id: "x",
      organizationId: ORG_USHG,
      email: "a@example.com",
      role: "viewer" as const,
      status: "pending" as const,
      invitedByUserId: null,
      acceptedAt: null,
      acceptedByUserId: null,
      revokedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };

    expect(
      invitationState({ ...base, expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    ).toBe("pending");

    expect(
      invitationState({ ...base, expiresAt: new Date(Date.now() - 60_000).toISOString() }),
    ).toBe("expired");
  });

  it("keeps a terminal status regardless of the clock", () => {
    expect(
      invitationState({
        id: "x",
        organizationId: ORG_USHG,
        email: "a@example.com",
        role: "viewer",
        status: "revoked",
        invitedByUserId: null,
        // Long expired, but revoked is what happened to it.
        expiresAt: new Date(Date.now() - 60_000).toISOString(),
        acceptedAt: null,
        acceptedByUserId: null,
        revokedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    ).toBe("revoked");
  });
});

describe("invitable roles", () => {
  it("excludes owner", () => {
    // Ownership is transferred between people who already share an
    // organization, never granted by a link somebody could intercept.
    expect(INVITABLE_ROLES).not.toContain("owner");
  });

  it("covers every other role", () => {
    expect([...INVITABLE_ROLES].sort()).toEqual(
      ["admin", "analyst", "approver", "communications_lead", "location_manager", "viewer"].sort(),
    );
  });
});

describe("scope isolation for invitations", () => {
  it("revoke refuses an invitation belonging to another organization", async () => {
    const { invitation } = await invite("target@example.com");

    await expect(
      data.invitations.revoke(harbor.owner(), invitation.id),
    ).rejects.toThrow();
  });
});
