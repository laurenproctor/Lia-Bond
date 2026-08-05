"use server";

import {
  composeEarlyAccessNotification,
  earlyAccessSchema,
  type EarlyAccessRequest,
} from "@/lib/site/early-access";
import { runAction, type ActionResult } from "@/lib/actions/result";
import { sendEmail } from "@/lib/email/send";
import {
  appOrigin,
  isSupabaseConfigured,
  resolveEmailMode,
  supportInboxAddress,
} from "@/lib/env";
import { createSupabaseServiceClient } from "@/lib/supabase/server";

/**
 * Early access requests.
 *
 * The application's only unauthenticated write, and the only action with no
 * `requireSession()` call — by definition, since the person submitting it has
 * no account. `runAction` is session-agnostic (the help action calls
 * `requireSession` inside its own body), so it is reusable here unchanged.
 *
 * Two things happen with one lead: it is recorded, and somebody is told. They
 * fail independently and are treated independently — see the note on the
 * return below.
 *
 * What this deliberately does not do is rate-limit. There is no rate-limit
 * store in this stack, and a per-process counter on serverless functions counts
 * one instance's traffic rather than an attacker's. The honeypot in the schema
 * stops naive bots; anything beyond that belongs at the platform edge, and is
 * recorded as a pre-launch item in the design document rather than
 * approximated here.
 */

export interface EarlyAccessReceipt {
  /** False in demo mode, or when the row already existed. */
  recorded: boolean;
  /** False when the server is in `LIA_EMAIL_MODE=log` or email is unconfigured. */
  notified: boolean;
}

export async function submitEarlyAccessAction(
  input: unknown,
): Promise<ActionResult<EarlyAccessReceipt>> {
  return runAction("site.early_access", async () => {
    const request = earlyAccessSchema.parse(input);

    const recorded = await record(request);
    const notified = await notify(request);

    // Capture beats notify. A lead that reached either the table or the inbox
    // is a lead we have, and telling the visitor otherwise would invite them to
    // submit again. Only losing both is a failure worth showing.
    if (!recorded && !notified) {
      throw new Error("early access request reached neither the table nor the inbox");
    }

    return { recorded, notified };
  });
}

async function record(request: EarlyAccessRequest): Promise<boolean> {
  // Demo mode: a fresh clone with an empty .env still gets a working form.
  if (!isSupabaseConfigured()) return false;

  try {
    const supabase = createSupabaseServiceClient();
    const { error } = await supabase.from("early_access_requests").insert({
      email: request.email,
      business_name: request.businessName,
      industry: request.industry,
      source_path: request.sourcePath,
    });

    // 23505 is unique_violation: this address is already on the list. That is a
    // success from the visitor's side and must stay indistinguishable from a
    // first submission — see the note in the form component about enumeration.
    if (error && error.code !== "23505") {
      console.error("early access insert failed", error.code);
      return false;
    }

    return true;
  } catch (error) {
    // A misconfigured service client must not cost us the notification below.
    console.error("early access insert threw", error);
    return false;
  }
}

async function notify(request: EarlyAccessRequest): Promise<boolean> {
  if (resolveEmailMode() === "unconfigured") return false;

  const { subject, text } = composeEarlyAccessNotification({
    request,
    sentAt: new Date(),
    origin: appOrigin(),
  });

  try {
    const delivery = await sendEmail({
      to: [supportInboxAddress()],
      // So that hitting reply reaches the person who asked.
      replyTo: [request.email],
      subject,
      text,
    });

    return delivery.mode === "live";
  } catch (error) {
    console.error("early access notification failed", error);
    return false;
  }
}
