"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { INVITABLE_ROLES, INVITATION_TTL_DAYS } from "@/domain";
import { authorize } from "@/lib/actions/guard";
import { runAction, type ActionResult } from "@/lib/actions/result";
import { recordAuditEvent } from "@/lib/audit/record";
import {
  generateInvitationToken,
  hashInvitationToken,
  invitationUrl,
  isInvitationTokenShaped,
} from "@/lib/auth/invitation-token";
import { requireSession } from "@/lib/auth/session";
import { getDataSource } from "@/lib/data";
import { deliverInvitation } from "@/lib/email/invitation-delivery";
import type { InvitationDeliveryStatus } from "@/lib/email/invitation-message";
import { appOrigin } from "@/lib/env";
import { setActiveOrganizationCookie } from "@/lib/tenancy/organization-context";

/**
 * Invitations.
 *
 * The delivery decision shapes this file. D55 originally made an invitation a
 * link the inviter copies rather than an email Lia sends, because there was no
 * delivery mechanism that worked: Supabase's built-in SMTP on a new project is
 * rate-limited to a handful of messages an hour and may deliver only to project
 * members, so an email-only invitation would fail silently and look like a bug
 * in Lia. D55 recorded that "the delivery mechanism can be added without
 * changing the model", and D191 is that addition — Lia now emails the link
 * through Resend when a verified sender is configured.
 *
 * The model is unchanged, and so is the copy-link fallback. Email is an extra
 * delivery path, never the only one: the send is attempted after the invitation
 * exists, it is caught rather than thrown, and its outcome is reported to the
 * inviter alongside the link. An invitation that could not be emailed is still
 * a valid invitation, and the person who just issued it is the one person able
 * to pass it on by hand.
 *
 * The link is still the credential, which drives two rules:
 *
 * - the raw token is returned to the inviter exactly once — never persisted,
 *   never logged, never written to an audit event; and
 * - accepting requires the signed-in account to own the invited address, so a
 *   link forwarded to the wrong person admits nobody.
 *
 * Without the second rule a copyable link would be a standing grant of whatever
 * role it carries to anyone who ever sees it.
 */

const inviteSchema = z.object({
  email: z.email("Enter a valid email address."),
  role: z.enum(INVITABLE_ROLES),
});

export interface IssuedInvitation {
  invitationId: string;
  email: string;
  /** Shown once. Not stored anywhere it could be read a second time. */
  url: string;
  expiresAt: string;
  /**
   * What became of the email. Never `sent` unless it actually left, so the UI
   * can tell the inviter to pass the link on themselves when it did not.
   */
  delivery: InvitationDeliveryStatus;
}

/**
 * Invite somebody to the active organization.
 *
 * Owner is not an option. Ownership is transferred between people who already
 * share an organization, not handed to an address that has not yet proved it
 * can receive mail — a link that mints an owner is the most valuable thing an
 * attacker could intercept.
 */
export async function inviteMemberAction(
  input: unknown,
): Promise<ActionResult<IssuedInvitation>> {
  return runAction("membership.invite", async () => {
    const { email, role } = inviteSchema.parse(input);
    const context = await authorize("organization.manage_members");

    // Read before the invitation is created so a missing profile fails here,
    // where nothing has been written yet, rather than after a row exists.
    const session = await requireSession();

    const token = generateInvitationToken();
    const expiresAt = new Date(
      Date.now() + INVITATION_TTL_DAYS * 24 * 60 * 60 * 1000,
    ).toISOString();

    const invitation = await context.dataSource.invitations.create(context.scope, {
      email,
      role,
      // Only the digest is handed to the repository. The token exists in this
      // function and in the value returned to the caller, and nowhere else.
      tokenHash: hashInvitationToken(token),
      invitedByUserId: context.scope.userId,
      expiresAt,
    });

    const url = invitationUrl(appOrigin(), token);

    // After the row exists, so a mail outage cannot cost us the invitation, and
    // before the audit event, so the record says what actually happened to it.
    const delivery = await deliverInvitation({
      email: invitation.email,
      organizationName: context.organization.name,
      inviterName: session.fullName,
      role: invitation.role,
      url,
      expiresAt,
    });

    await recordAuditEvent(context, {
      eventType: "membership.invited",
      entityType: "membership",
      entityId: invitation.id,
      previousState: null,
      // The address and the role, never the token. An audit trail carrying the
      // token would be a way in rather than a record of one.
      newState: { email: invitation.email, role: invitation.role },
      // `delivery` and not the link, for the same reason. Worth recording:
      // "they never got it" is the first question asked about an invitation
      // that went unaccepted, and this is the only place the answer survives.
      metadata: { expiresAt, delivery },
    });

    revalidatePath("/settings");

    return {
      invitationId: invitation.id,
      email: invitation.email,
      url,
      expiresAt,
      delivery,
    };
  });
}

const revokeSchema = z.object({ invitationId: z.uuid() });

/**
 * Withdraw a pending invitation.
 *
 * The link stops working immediately. That is the only remedy available once a
 * link has been sent to the wrong address, which is why it is one click and
 * not buried.
 */
export async function revokeInvitationAction(
  input: unknown,
): Promise<ActionResult<{ invitationId: string }>> {
  return runAction("membership.revoke_invitation", async () => {
    const { invitationId } = revokeSchema.parse(input);
    const context = await authorize("organization.manage_members");

    const invitation = await context.dataSource.invitations.revoke(
      context.scope,
      invitationId,
    );

    await recordAuditEvent(context, {
      eventType: "membership.invitation_revoked",
      entityType: "membership",
      entityId: invitation.id,
      previousState: { status: "pending" },
      newState: { status: "revoked" },
      metadata: { email: invitation.email },
    });

    revalidatePath("/settings");
    return { invitationId };
  });
}

/* -------------------------------------------------------------------------- */
/* Acceptance                                                                  */
/* -------------------------------------------------------------------------- */

const acceptSchema = z.object({
  token: z
    .string()
    .refine(isInvitationTokenShaped, "That invitation link is not valid."),
});

/**
 * Accept as somebody who is already signed in.
 *
 * The email match is enforced inside `accept_invitation`, not here. That
 * placement is deliberate: a check in application code protects the one path
 * that runs it, and a check in the database protects every path there will
 * ever be.
 *
 * Not wrapped in `authorize()` — the whole point is that the caller holds no
 * membership in the organization being joined.
 */
export async function acceptInvitationAction(
  input: unknown,
): Promise<ActionResult<{ organizationId: string }>> {
  return runAction("membership.accept_invitation", async () => {
    const { token } = acceptSchema.parse(input);
    const session = await requireSession();
    const dataSource = await getDataSource();

    const result = await dataSource.invitations.accept(
      hashInvitationToken(token),
      session.id,
    );

    // Select the organization they just joined.
    //
    // Without this, acceptance is silent about where it put you: the active
    // organization stays whatever it was. That was invisible while an invitee
    // could only ever belong to one organization — `getOrganizationContext`
    // falls back to the first membership, which was the right one by accident.
    // It stops being right the moment somebody belongs to two, which is now an
    // ordinary thing to do, and the symptom would be accepting an invitation
    // and landing in the wrong workspace.
    await setActiveOrganizationCookie(result.organizationId);

    // The layout, not just settings: the sidebar, the switcher, and the badge
    // counts all read the active organization, and all three just changed.
    revalidatePath("/", "layout");
    revalidatePath("/settings");
    return result;
  });
}
