"use server";

import { sendEmail } from "@/lib/email/send";
import { runAction, type ActionResult } from "@/lib/actions/result";
import { requireSession } from "@/lib/auth/session";
import {
  appOrigin,
  isUnintentionalDemoMode,
  supportInboxAddress,
} from "@/lib/env";
import { MEMBERSHIP_ROLE_LABELS } from "@/lib/labels";
import { composeHelpRequest, helpRequestSchema } from "@/lib/support/help-request";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";

/**
 * Help requests.
 *
 * No `authorize()` call and no permission: every member of every role can ask
 * for help, including — especially — someone whose problem is that their role
 * does not let them do something. A permission gate on the support channel
 * would lock out exactly the people most likely to need it.
 *
 * Nothing is persisted. There is no help_requests table because a support
 * message is not one of Lia's nouns; the inbox is the record. That also keeps
 * the request out of the audit trail, which is scoped to changes made to
 * customer data.
 */

export interface HelpRequestReceipt {
  /** Where it went, echoed back so the confirmation can name the address. */
  sentTo: string;
  cc: string[];
  /** False when the server is in `LIA_EMAIL_MODE=log` and nothing was sent. */
  delivered: boolean;
}

export async function submitHelpRequestAction(
  input: unknown,
): Promise<ActionResult<HelpRequestReceipt>> {
  return runAction("support.help_request", async () => {
    const request = helpRequestSchema.parse(input);

    // Identity from the session, never from the form — see the note in
    // `@/lib/support/help-request`.
    const [session, context] = await Promise.all([
      requireSession(),
      getOrganizationContext(),
    ]);

    const inbox = supportInboxAddress();

    const { subject, text } = composeHelpRequest({
      request,
      sender: {
        fullName: session.fullName || session.email,
        email: session.email,
        roleLabel: MEMBERSHIP_ROLE_LABELS[context.role],
      },
      organization: {
        name: context.organization.name,
        slug: context.organization.slug,
      },
      origin: appOrigin(),
      demoMode: isUnintentionalDemoMode(),
      sentAt: new Date(),
    });

    const delivery = await sendEmail({
      to: [inbox],
      cc: request.cc,
      // The reply lands with the person who asked, not with the sending
      // identity — which is a no-reply address on a verified domain.
      replyTo: [request.replyTo],
      subject,
      text,
    });

    return {
      sentTo: inbox,
      cc: request.cc,
      delivered: delivery.mode === "live",
    };
  });
}
