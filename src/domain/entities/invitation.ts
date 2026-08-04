import { z } from "zod";
import {
  invitationStateSchema,
  invitationStatusSchema,
  membershipRoleSchema,
} from "@/domain/enums";
import {
  organizationOwnedSchema,
  timestampSchema,
  timestampsSchema,
  uuidSchema,
} from "@/domain/primitives";

/**
 * An offer of membership that has not been accepted yet.
 *
 * The token is never stored. What is stored is its SHA-256 hash, for the same
 * reason `oauth_states` holds a hash rather than a state value (D11): read
 * access to this table — a backup, a log shipper, a mis-scoped query — must not
 * be enough to join somebody else's organization.
 *
 * Two things make a copyable link safe to send over any channel:
 *
 * - the token is 32 random bytes, so it cannot be guessed; and
 * - acceptance requires the signed-in account to own the invited address, so
 *   a forwarded link admits nobody but its intended recipient.
 *
 * The second is the load-bearing one. Without it a link pasted into the wrong
 * chat is a standing grant of whatever role it carries.
 */
export const invitationSchema = z
  .object({
    id: uuidSchema,
    /** Lower-cased on write. Compared against the accepting account's address. */
    email: z.email(),
    role: membershipRoleSchema,
    status: invitationStatusSchema,
    /** Null when the inviter's account has since been deleted. */
    invitedByUserId: uuidSchema.nullable(),
    expiresAt: timestampSchema,
    acceptedAt: timestampSchema.nullable(),
    acceptedByUserId: uuidSchema.nullable(),
    revokedAt: timestampSchema.nullable(),
  })
  .extend(organizationOwnedSchema.shape)
  .extend(timestampsSchema.shape);

export type Invitation = z.infer<typeof invitationSchema>;

/**
 * An invitation joined to the person who sent it.
 *
 * The pending list is a list of decisions somebody made, and "who let this
 * person in" is the question worth being able to answer without a second query.
 */
export const invitationWithInviterSchema = invitationSchema.extend({
  invitedByName: z.string().nullable(),
});

export type InvitationWithInviter = z.infer<typeof invitationWithInviterSchema>;

/** What an invitation looks like to somebody holding the link. */
export const invitationPreviewSchema = z.object({
  organizationName: z.string(),
  email: z.email(),
  role: membershipRoleSchema,
  state: invitationStateSchema,
});

export type InvitationPreview = z.infer<typeof invitationPreviewSchema>;

/**
 * How long an invitation stays valid.
 *
 * Long enough to survive a holiday, short enough that a link forgotten in an
 * inbox does not stay usable indefinitely. Expiry is checked against
 * `expiresAt` at acceptance, so changing this affects new invitations only.
 */
export const INVITATION_TTL_DAYS = 7;

/**
 * Roles an invitation may carry.
 *
 * Owner is excluded deliberately. Ownership is transferred between people who
 * already share an organization, not handed to an address that has not yet
 * proved it can receive mail — an invitation is a link, and a link that mints
 * an owner is the most valuable thing an attacker could intercept.
 */
export const INVITABLE_ROLES = [
  "admin",
  "communications_lead",
  "location_manager",
  "approver",
  "analyst",
  "viewer",
] as const;

export type InvitableRole = (typeof INVITABLE_ROLES)[number];

export function isInvitableRole(value: unknown): value is InvitableRole {
  return (
    typeof value === "string" && (INVITABLE_ROLES as readonly string[]).includes(value)
  );
}

export function isExpired(invitation: Invitation, now: Date = new Date()): boolean {
  return new Date(invitation.expiresAt).getTime() <= now.getTime();
}

/** Status as a person holding the link would describe it, expiry included. */
export function invitationState(
  invitation: Invitation,
  now: Date = new Date(),
): "pending" | "accepted" | "revoked" | "expired" {
  if (invitation.status !== "pending") return invitation.status;
  return isExpired(invitation, now) ? "expired" : "pending";
}
