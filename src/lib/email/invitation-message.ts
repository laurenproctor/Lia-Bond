import type { MembershipRole } from "@/domain";
import { formatDateTime } from "@/lib/format";
import { MEMBERSHIP_ROLE_LABELS } from "@/lib/labels";
import { stripControlCharacters } from "@/lib/site/form-text";

/**
 * What an invitation email says.
 *
 * Pure: no session, no provider, no I/O. The action supplies the transport and
 * the identity; everything about *what the recipient reads* is decided here so
 * it can be asserted on without sending anything — the same split
 * `@/lib/site/contact-message` and `@/lib/support/help-request` use.
 *
 * Two things interpolated here were typed by a person rather than written by
 * Lia: the organization name (set by an owner or admin in settings) and the
 * inviter's display name (from their profile, or from Supabase user metadata).
 * Both reach a subject line, so both go through `stripControlCharacters` first
 * — a CR or LF in a subject is the opening move of a header injection, and the
 * transform is imported rather than reimplemented because two copies of a
 * security-relevant transform drift.
 */

/** Bounds for the two names, applied after sanitising. */
const MAX_NAME_LENGTH = 160;

function oneLine(value: string, fallback: string): string {
  const cleaned = stripControlCharacters(value).trim().slice(0, MAX_NAME_LENGTH);
  return cleaned.length > 0 ? cleaned : fallback;
}

export interface InvitationMessageInput {
  /** The address the invitation was issued to. Also the address it is sent to. */
  email: string;
  organizationName: string;
  /** Display name of whoever issued it. */
  inviterName: string;
  role: MembershipRole;
  /** Absolute, from `invitationUrl`. */
  url: string;
  /** ISO 8601. */
  expiresAt: string;
}

export function composeInvitationEmail(input: InvitationMessageInput): {
  subject: string;
  text: string;
} {
  const organization = oneLine(input.organizationName, "a team");
  const inviter = oneLine(input.inviterName, "Someone");
  const role = MEMBERSHIP_ROLE_LABELS[input.role];

  const lines = [
    `${inviter} invited you to join ${organization} on Lia as ${role.toLowerCase()}.`,
    "",
    "Lia watches your reviews, Reddit threads and news coverage, drafts replies in your brand voice, and flags anything that needs a person.",
    "",
    "Accept your invitation:",
    input.url,
    "",
    // D56, in the recipient's words rather than as an error they hit later.
    // Someone who forwards this to a colleague otherwise finds out the link is
    // address-bound only after that colleague has created an account.
    `Sign in with ${input.email}. The invitation only works for that address, so forwarding this message will not let someone else join in your place.`,
    "",
    `The link can be used once and expires on ${formatDateTime(input.expiresAt)} UTC.`,
    "",
    "If you weren't expecting this, you can ignore it — the invitation expires on its own, and nothing happens until someone opens the link.",
  ];

  return {
    // Single line by construction: both interpolated names have been through
    // `oneLine`, so nothing typed into either can introduce a second header
    // line or run away with the subject.
    subject: `${inviter} invited you to ${organization} on Lia`,
    text: lines.join("\n"),
  };
}

/* -------------------------------------------------------------------------- */
/* Delivery outcome                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What became of the invitation email.
 *
 * Four states rather than a boolean, because the inviter's next action differs
 * in each and only one of them is a fault:
 *
 * - `sent` — it left for the recipient's inbox.
 * - `logged` — `LIA_EMAIL_MODE=log`, so it was written to the server log and
 *   delivered nowhere. Local development. Not a failure, and never claimed as
 *   a send.
 * - `not_configured` — no `INVITE_FROM_EMAIL`. An operator gap, not something
 *   the inviter did, and not worth blocking them over: they still hold a
 *   working link.
 * - `failed` — the provider refused or could not be reached.
 *
 * In every case except `sent` the invitation itself is perfectly valid. That is
 * why this is reported alongside the link rather than in place of it.
 */
export type InvitationDeliveryStatus =
  | "sent"
  | "logged"
  | "not_configured"
  | "failed";

/** Whether the recipient can be expected to have received anything. */
export function invitationWasEmailed(status: InvitationDeliveryStatus): boolean {
  return status === "sent";
}
