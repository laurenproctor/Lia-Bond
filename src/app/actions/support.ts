"use server";

import { sendEmail, type OutboundAttachment } from "@/lib/email/send";
import { runAction, type ActionResult } from "@/lib/actions/result";
import { requireSession } from "@/lib/auth/session";
import { invalidInput } from "@/lib/data/errors";
import {
  appOrigin,
  isUnintentionalDemoMode,
  supportInboxAddress,
} from "@/lib/env";
import { MEMBERSHIP_ROLE_LABELS } from "@/lib/labels";
import {
  reviewAttachments,
  safeAttachmentName,
  type AttachmentDescriptor,
} from "@/lib/support/help-attachments";
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
  /** How many files rode along, so the receipt can say they went too. */
  attached: number;
  /** False when the server is in `LIA_EMAIL_MODE=log` and nothing was sent. */
  delivered: boolean;
}

/**
 * Send a help request, with any screenshots or clips attached.
 *
 * Attachments arrive as their own argument rather than inside `input` because
 * they are `File`s, not data — Zod parses the message, and the file review in
 * `@/lib/support/help-attachments` handles the rest. The dropzone runs that
 * same review before anything is uploaded; this one is the one that counts.
 */
export async function submitHelpRequestAction(
  input: unknown,
  attachments: unknown = [],
): Promise<ActionResult<HelpRequestReceipt>> {
  return runAction("support.help_request", async () => {
    const request = helpRequestSchema.parse(input);
    const files = await readAttachments(attachments);

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
      attachments: files.map(({ name, type, size }) => ({ name, type, size })),
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
      attachments: files.map((file) => file.outbound),
    });

    return {
      sentTo: inbox,
      cc: request.cc,
      attached: files.length,
      delivered: delivery.mode === "live",
    };
  });
}

interface ReadAttachment extends AttachmentDescriptor {
  outbound: OutboundAttachment;
}

/**
 * Turn the uploaded files into mail attachments, or refuse the request.
 *
 * The client filters before uploading, so anything rejected here was either
 * hand-crafted or a bug. Either way the answer is one field error naming the
 * files, not a silently shortened list — somebody who attached a recording and
 * got a reply that never mentions it has been failed quietly.
 */
async function readAttachments(input: unknown): Promise<ReadAttachment[]> {
  if (input === undefined || input === null) return [];

  if (!Array.isArray(input) || !input.every(isUploadedFile)) {
    throw invalidInput("Those attachments couldn't be read. Try again.", {
      attachments: "Those attachments couldn't be read.",
    });
  }

  const { accepted, rejected } = reviewAttachments(input);

  if (rejected.length > 0) {
    const detail = rejected
      .map((file) => `${safeAttachmentName(file.name)} (${file.reason})`)
      .join(", ");

    throw invalidInput(`Some attachments couldn't be sent: ${detail}.`, {
      attachments: `Couldn't send ${detail}.`,
    });
  }

  return Promise.all(
    accepted.map(async (file) => ({
      name: file.name,
      type: file.type,
      size: file.size,
      outbound: {
        filename: safeAttachmentName(file.name),
        contentType: file.type || "application/octet-stream",
        content: Buffer.from(await file.arrayBuffer()).toString("base64"),
      },
    })),
  );
}

/**
 * A `File` from the action's payload.
 *
 * Duck-typed rather than `instanceof File`: the value crosses the server
 * action boundary, and a realm mismatch there would reject a perfectly good
 * upload.
 */
function isUploadedFile(value: unknown): value is File {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as File).name === "string" &&
    typeof (value as File).size === "number" &&
    typeof (value as File).type === "string" &&
    typeof (value as File).arrayBuffer === "function"
  );
}
