import "server-only";

import {
  composeInvitationEmail,
  type InvitationDeliveryStatus,
  type InvitationMessageInput,
} from "@/lib/email/invitation-message";
import { sendEmail } from "@/lib/email/send";
import { inviteFromAddress, resolveEmailMode } from "@/lib/env";

/**
 * Email an invitation link, and report what happened instead of throwing.
 *
 * Shared by the two places an invitation is issued — `/settings` and the
 * onboarding team step — because the interesting behaviour here is a set of
 * refusals, and two copies of a refusal drift into one path that sends and one
 * that quietly does not.
 *
 * Never throws. By the time this runs the invitation is already created,
 * audited and revocable, and the inviter holds a working link — so a refused
 * send is a thing to report, not a reason to fail an action that has already
 * succeeded. Throwing would show an error for an invitation that exists, which
 * is the one message guaranteed to make somebody issue a second one.
 */
export async function deliverInvitation(
  input: InvitationMessageInput,
): Promise<InvitationDeliveryStatus> {
  const from = inviteFromAddress();

  // No verified sender means no send at all. Falling back to the support
  // identity would hand the message to Resend's shared domain, which delivers
  // only to the account owner — accepted by the provider, reported as sent, and
  // read by nobody. That is precisely the silent failure D55 refused.
  if (from === null) return "not_configured";

  // Separately checked: a sender can be configured on a deployment that has no
  // API key at all, and `sendEmail` would throw `ConfigurationError` for it.
  if (resolveEmailMode() === "unconfigured") return "not_configured";

  const { subject, text } = composeInvitationEmail(input);

  try {
    const result = await sendEmail({ from, to: [input.email], subject, text });
    // Log mode deliberately delivers nothing, so it is reported as its own
    // state rather than as a send. Nobody should read "emailed" off a run that
    // only wrote to stdout.
    return result.mode === "live" ? "sent" : "logged";
  } catch (error) {
    // The provider's own text stays in the log; `sendEmail` has already
    // recorded the status and its reason.
    console.error("[invitation] delivery failed", error);
    return "failed";
  }
}
