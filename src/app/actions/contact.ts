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
  contactMessageWasLost,
  type ContactMessage,
  type DeliveryStep,
} from "@/lib/site/contact-message";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * Contact messages from the public site.
 *
 * Unauthenticated, like `submitEarlyAccessAction` and for the same reason: the
 * person writing has no account, which is usually why they are writing.
 *
 * **Save, then send, then record that it was sent.** The order is the point.
 * The message is prose, and prose that exists only inside an outbound email is
 * lost the moment the mail provider refuses — which is not hypothetical, since
 * the sending domain has to be verified before Lia can mail anywhere. So the
 * row is written first and the send is a second, separately-tracked step:
 * `notified_at` is stamped only when a message actually left, which makes
 * "saved but nobody was told" a state you can query for rather than a line in
 * a log nobody reads.
 *
 * The visitor sees a failure only when the question reached neither the table
 * nor the inbox. One of the two is enough for their question to be answerable,
 * and inviting them to type it again when it is already saved would be worse
 * than useless.
 */

export interface ContactReceipt {
  /** Whether the message itself is now in the table. */
  saved: boolean;
  /** False when the server is in `LIA_EMAIL_MODE=log` or email is unconfigured. */
  delivered: boolean;
}

/** The subsystem is not configured. Demo mode, not an error. */
const SKIPPED: DeliveryStep = {
  attempted: false,
  failed: false,
  succeeded: false,
};

/** Configured, tried, and the attempt came back broken. */
const FAILED: DeliveryStep = {
  attempted: true,
  failed: true,
  succeeded: false,
};

/** It landed. */
const SUCCEEDED: DeliveryStep = {
  attempted: true,
  failed: false,
  succeeded: true,
};

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

    const saved = await saveMessage(message);
    const notified = await notifyInbox(message);

    if (contactMessageWasLost(saved.outcome, notified.outcome)) {
      throw new Error(
        "contact message reached neither the table nor the inbox",
      );
    }

    if (saved.id && notified.outcome.succeeded) await markNotified(saved.id);

    return {
      saved: saved.outcome.succeeded,
      delivered: notified.outcome.succeeded,
    };
  });
}

/**
 * Write the message down.
 *
 * Returns the row id so a successful send can be stamped against it. Not
 * configured is a skip rather than a failure — a fresh clone with an empty
 * `.env` still gets a working form.
 */
async function saveMessage(
  message: ContactMessage,
): Promise<{ id: string | null; outcome: DeliveryStep }> {
  if (!isSupabaseConfigured()) {
    return { id: null, outcome: SKIPPED };
  }

  try {
    const supabase = createSupabaseServiceClient();
    const { data, error } = await supabase
      .from("contact_messages")
      .insert({
        name: message.name,
        email: message.email,
        business_name: message.businessName,
        message: message.message,
        source_path: message.sourcePath,
      })
      .select("id")
      .single();

    if (error) {
      console.error("contact message insert failed", error.code);
      return { id: null, outcome: FAILED };
    }

    return { id: data.id, outcome: SUCCEEDED };
  } catch (error) {
    // A misconfigured service client must not cost us the notification below,
    // but it was a genuine attempt against a subsystem believed configured, so
    // it counts as a failure for that subsystem.
    console.error("contact message insert threw", error);
    return { id: null, outcome: FAILED };
  }
}

/**
 * Tell somebody.
 *
 * Caught rather than thrown, now that the message is saved before this runs: a
 * refused send is no longer the difference between having the question and
 * losing it, and a visitor whose message is safely in the table should not be
 * asked to send it again. The row's `notified_at` stays null, which is where
 * that failure is recorded.
 */
async function notifyInbox(
  message: ContactMessage,
): Promise<{ outcome: DeliveryStep }> {
  if (resolveEmailMode() === "unconfigured") {
    return { outcome: SKIPPED };
  }

  const { subject, text } = composeContactNotification({
    message,
    sentAt: new Date(),
    origin: appOrigin(),
  });

  try {
    const delivery = await sendEmail({
      to: [supportInboxAddress()],
      // So that hitting reply reaches the person who wrote.
      replyTo: [message.email],
      subject,
      text,
    });

    // `sendEmail` returning at all — live or log — means it did not fail.
    return {
      outcome: {
        attempted: true,
        failed: false,
        // Log mode deliberately does not deliver, so nothing reached an inbox
        // and `succeeded` is false — but it is not a failure either, which is
        // why these are two fields rather than one.
        succeeded: delivery.mode === "live",
      },
    };
  } catch (error) {
    console.error("contact message notification failed", error);
    return { outcome: FAILED };
  }
}

/**
 * Stamp the row that was emailed.
 *
 * Never throws. The message is saved and the mail has already left by the time
 * this runs; failing the visitor's submission over a bookkeeping update would
 * report a problem that did not happen to the one person who cannot act on it.
 * The cost of losing this update is a message that looks unnotified and gets
 * looked at twice.
 */
async function markNotified(id: string): Promise<void> {
  try {
    const supabase = createSupabaseServiceClient();
    const { error } = await supabase
      .from("contact_messages")
      .update({ notified_at: new Date().toISOString() })
      .eq("id", id);

    if (error) console.error("contact message notify stamp failed", error.code);
  } catch (error) {
    console.error("contact message notify stamp threw", error);
  }
}
