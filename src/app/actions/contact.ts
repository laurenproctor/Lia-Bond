"use server";

import { runAction, type ActionResult } from "@/lib/actions/result";
import { sendEmail } from "@/lib/email/send";
import {
  appOrigin,
  isSupabaseConfigured,
  resolveEmailMode,
  supportInboxAddress,
} from "@/lib/env";
import {
  composeContactNotification,
  contactMessageSchema,
  type ContactMessage,
} from "@/lib/site/contact-message";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * Contact messages from the public site.
 *
 * Unauthenticated, like `submitEarlyAccessAction` and for the same reason: the
 * person writing has no account, which is usually why they are writing.
 *
 * Where it differs from early access is which step is allowed to fail. An
 * early-access lead is an address, and an address that reached either the
 * table or the inbox is a lead we have. A contact message is *prose*, and the
 * table has no column to put prose in — so the email is not one of two
 * redundant channels here, it is the only one. If it was attempted and failed,
 * the visitor is told, even though their address may have been recorded: a
 * success screen would mean their question is sitting nowhere.
 *
 * The row is still written, best-effort, so contacts keep landing in
 * `early_access_requests` the way they did when this form only asked for an
 * address. A failure there is logged and otherwise ignored.
 */

export interface ContactReceipt {
  /** False when the server is in `LIA_EMAIL_MODE=log` or email is unconfigured. */
  delivered: boolean;
  /** Whether the sender's address also reached the leads table. */
  recorded: boolean;
}

/**
 * Validates the message, without letting a honeypot rejection say so on the
 * wire.
 *
 * `runAction` turns every `ZodError` into `fieldErrors`, which a bot's own
 * form-fill logic reads as easily as a screen reader does. So a honeypot
 * failure is re-thrown as a plain `Error` — the generic catch-all renders a
 * sentence with no field name attached. A genuine validation problem still
 * throws the `ZodError` untouched, so a real visitor keeps per-field guidance.
 */
function parseContactMessage(input: unknown): ContactMessage {
  const result = contactMessageSchema.safeParse(input);
  if (result.success) return result.data;

  const failedPaths = new Set(
    result.error.issues.map((issue) => issue.path.join(".")),
  );
  if (failedPaths.has("website")) {
    throw new Error("contact message rejected by the honeypot");
  }

  throw result.error;
}

export async function submitContactMessageAction(
  input: unknown,
): Promise<ActionResult<ContactReceipt>> {
  return runAction("site.contact_message", async () => {
    const message = parseContactMessage(input);

    // Send first. The record below is a nicety; this is the delivery.
    const delivered = await deliver(message);
    const recorded = await recordSender(message);

    return { delivered, recorded };
  });
}

/**
 * Put the message in the support inbox.
 *
 * Returns false rather than throwing when email is simply not configured —
 * a fresh clone with an empty `.env` still gets a working form, the same
 * demo-mode courtesy the early-access path extends. Production cannot reach
 * that branch: `RESEND_API_KEY` is set there, and the env schema refuses
 * `LIA_EMAIL_MODE=log` in production outright.
 */
async function deliver(message: ContactMessage): Promise<boolean> {
  if (resolveEmailMode() === "unconfigured") return false;

  const { subject, text } = composeContactNotification({
    message,
    sentAt: new Date(),
    origin: appOrigin(),
  });

  // Not caught: a failed send is the one failure this action must surface.
  // `sendEmail` throws `DataError`/`ConfigurationError`, which `runAction`
  // already renders as a sentence a visitor can act on.
  const delivery = await sendEmail({
    to: [supportInboxAddress()],
    // So that hitting reply reaches the person who wrote.
    replyTo: [message.email],
    subject,
    text,
  });

  return delivery.mode === "live";
}

/**
 * Best-effort lead capture. Never throws: the message is already delivered by
 * the time this runs, and a visitor who has been answered does not need to
 * hear that a table they have never seen refused a row.
 */
async function recordSender(message: ContactMessage): Promise<boolean> {
  if (!isSupabaseConfigured()) return false;

  try {
    const supabase = createSupabaseServiceClient();
    const { error } = await supabase.from("early_access_requests").insert({
      email: message.email,
      business_name: message.businessName,
      industry: null,
      source_path: message.sourcePath,
    });

    // 23505 is unique_violation: this address has written before. A row exists
    // either way, which is all this function claims.
    if (error && error.code !== "23505") {
      console.error("contact message insert failed", error.code);
      return false;
    }

    return true;
  } catch (error) {
    console.error("contact message insert threw", error);
    return false;
  }
}
