import { z } from "zod";
import {
  honeypot,
  optionalText,
  requiredText,
  sitePath,
} from "@/lib/site/form-text";

/**
 * Contact message validation and composition.
 *
 * Pure: no I/O, no session, no provider. The action supplies the transport;
 * everything about *what the message says* is decided here so it can be tested
 * without sending anything — the same split `@/lib/support/help-request` and
 * `@/lib/site/early-access` use.
 *
 * The rule that shapes this module: with the help form behind a session, this
 * is the only way a stranger can put text of their own choosing into Lia's
 * inbox. So every field is bounded, every single-line field is stripped of
 * control characters before it can reach a subject line, and the message body
 * — the one field that is legitimately multi-line — is fenced in the body
 * where it cannot be mistaken for a header or for Lia's own words.
 */

export const MAX_CONTACT_NAME_LENGTH = 120;
export const MAX_CONTACT_BUSINESS_LENGTH = 200;
export const MIN_CONTACT_MESSAGE_LENGTH = 10;
export const MAX_CONTACT_MESSAGE_LENGTH = 4000;

export const contactMessageSchema = z.object({
  name: requiredText(MAX_CONTACT_NAME_LENGTH, "Tell us who you are."),

  email: z
    .string()
    .trim()
    .toLowerCase()
    // `z.email()` rejects the embedded CR/LF that begins a header injection,
    // so the address needs no separate sanitising before it reaches the mailer.
    .pipe(z.email({ message: "Enter a valid email address." }))
    .pipe(z.string().max(320)),

  businessName: optionalText(MAX_CONTACT_BUSINESS_LENGTH),

  /**
   * The only field kept multi-line, because a contact message that cannot
   * contain a paragraph break is not a contact message. It is never
   * interpolated into a subject or a header — only into a fenced block in the
   * body — so newlines here are content rather than structure.
   */
  message: z
    .string()
    .trim()
    .min(
      MIN_CONTACT_MESSAGE_LENGTH,
      "Tell us a little more about what you need.",
    )
    .max(MAX_CONTACT_MESSAGE_LENGTH, "That message is too long to send."),

  /** Which page they wrote from. */
  sourcePath: sitePath(),

  /** Honeypot. Hidden from people, tempting to form-fillers. */
  website: honeypot(),
});

export type ContactMessage = z.infer<typeof contactMessageSchema>;

/**
 * The fence around the visitor's own words.
 *
 * A stranger's message is the one part of this notification Lia did not write,
 * and it needs to look that way in a plain-text mail client — otherwise a
 * message that opens with "From page: /admin" reads as part of the header
 * block above it.
 */
const MESSAGE_FENCE = "---";

export function composeContactNotification({
  message,
  sentAt,
  origin,
}: {
  message: ContactMessage;
  sentAt: Date;
  origin: string;
}): { subject: string; text: string } {
  const lines = [
    "Someone wrote to Lia from the contact form.",
    "",
    `Name:      ${message.name}`,
    `Email:     ${message.email}`,
    `Business:  ${message.businessName ?? "Not given"}`,
    `From page: ${message.sourcePath ? `${origin}${message.sourcePath}` : "Not given"}`,
    `Received:  ${sentAt.toISOString()}`,
    "",
    "Message:",
    MESSAGE_FENCE,
    message.message,
    MESSAGE_FENCE,
    "",
    "Reply to the address above to answer them.",
  ];

  return {
    // Single line by construction: `name` has been through
    // `stripControlCharacters` and bounded to 120 characters, so nothing typed
    // into it can introduce a second header line or run away with the subject.
    subject: `Contact form — ${message.name}`,
    text: lines.join("\n"),
  };
}

/* -------------------------------------------------------------------------- */
/* Delivery outcome                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What became of one of the two places a message can land.
 *
 * Three states, and only one of them is a failure: **skipped** (the subsystem
 * is not configured — demo mode, not an error), **attempted and failed**, or
 * **attempted and succeeded**.
 */
export interface DeliveryStep {
  /** Was the subsystem configured enough to try at all? */
  attempted: boolean;
  /** Did the attempt come back an error? */
  failed: boolean;
  /** Did the message actually land there? */
  succeeded: boolean;
}

/**
 * True when the question reached neither the table nor the inbox.
 *
 * This is the only condition that should show a visitor an error, and it is
 * deliberately narrower than "something went wrong". A message that was saved
 * but not emailed is not lost — it is sitting in `contact_messages` with a
 * null `notified_at`, waiting to be seen — and telling that visitor to send it
 * again would produce a duplicate of a question we already have.
 *
 * The second clause is what keeps demo mode out of it: a fresh clone with an
 * empty `.env` attempts neither step, so nothing succeeded and nothing failed,
 * and the form still works.
 */
export function contactMessageWasLost(
  save: DeliveryStep,
  notify: DeliveryStep,
): boolean {
  const succeeded = save.succeeded || notify.succeeded;
  const anyAttemptFailed = save.failed || notify.failed;
  return !succeeded && anyAttemptFailed;
}
