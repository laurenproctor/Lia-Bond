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
 * A step can be in one of three states, and only one of them counts as a
 * failure: **skipped** (the subsystem is not configured — demo mode, not an
 * error), **attempted and failed** (configured, but the call itself came back
 * an error), or **attempted and succeeded**. A fresh clone with an empty
 * `.env` skips both steps and must still show the visitor success — that is
 * demo mode working as designed, not two failures. The visitor sees a failure
 * only when neither step succeeded and at least one attempted step genuinely
 * failed — one channel landing the lead is enough, so a failed attempt on the
 * other side never surfaces once the lead is captured somewhere.
 *
 * What this deliberately does not do is rate-limit. There is no rate-limit
 * store in this stack, and a per-process counter on serverless functions counts
 * one instance's traffic rather than an attacker's. The honeypot in the schema
 * stops naive bots; anything beyond that belongs at the platform edge, and is
 * recorded as a pre-launch item in the design document rather than
 * approximated here.
 */

export interface EarlyAccessReceipt {
  /**
   * False in demo mode (Supabase unconfigured) or when the insert genuinely
   * failed. True both for a fresh row and for the 23505 case — the address
   * was already on the list — since a row exists in the table either way; see
   * the enumeration note on `recordRequest` for why those two cases must stay
   * indistinguishable to the caller.
   */
  recorded: boolean;
  /** False when the server is in `LIA_EMAIL_MODE=log` or email is unconfigured. */
  notified: boolean;
}

/** A step's two independent facts: was it attempted, and did the attempt fail. */
interface StepOutcome {
  attempted: boolean;
  failed: boolean;
}

/**
 * Validates the request, without letting a honeypot rejection say so on the
 * wire.
 *
 * `earlyAccessSchema.parse` throwing a `ZodError` for a filled `website` field
 * is exactly as informative to a bot as a field-level message naming
 * `website` in the response payload — `runAction` turns every `ZodError` into
 * `fieldErrors`, which a bot's own form-fill logic can read as well as a
 * screen reader can. So a honeypot failure is deliberately re-thrown as a
 * plain `Error`: `runAction`'s generic catch-all renders a sentence with no
 * field name attached, which is the only way "the bot learns nothing about
 * which field betrayed it" is true of the response body and not just of what
 * gets painted on screen. A genuine validation problem (a malformed email,
 * say) still throws the `ZodError` untouched, so a real visitor keeps
 * per-field guidance.
 */
function parseEarlyAccessRequest(input: unknown): EarlyAccessRequest {
  const result = earlyAccessSchema.safeParse(input);
  if (result.success) return result.data;

  const failedPaths = new Set(result.error.issues.map((issue) => issue.path.join(".")));
  if (failedPaths.has("website")) {
    throw new Error("early access request rejected by the honeypot");
  }

  throw result.error;
}

export async function submitEarlyAccessAction(
  input: unknown,
): Promise<ActionResult<EarlyAccessReceipt>> {
  return runAction("site.early_access", async () => {
    const request = parseEarlyAccessRequest(input);

    const record = await recordRequest(request);
    const notify = await notifyInbox(request);

    // Capture beats notify. A lead that reached either the table or the inbox
    // is a lead we have, and telling the visitor otherwise would invite them to
    // submit again. A step that was never attempted — the subsystem is simply
    // not configured — is demo mode, not a failure, so it never contributes to
    // this check.
    //
    // The failure condition is "no step succeeded, and at least one step that
    // was attempted actually failed" — not "both steps failed". Demo mode
    // (neither configured, neither attempted, neither failed) must still read
    // as success: `record.recorded` and `notify.notified` are both false
    // there, but so is `record.outcome.failed` and `notify.outcome.failed`, so
    // the second half of this check keeps demo mode out of it. What it does
    // catch: Supabase unconfigured (skipped, not failed) while email is
    // configured and the send genuinely fails — under the old two-failures
    // rule that combination passed silently and the lead was captured
    // nowhere; under this rule, one attempted step failing with nothing
    // recorded and nobody notified is enough to tell the visitor.
    const succeeded = record.recorded || notify.notified;
    const anyAttemptFailed = record.outcome.failed || notify.outcome.failed;
    if (!succeeded && anyAttemptFailed) {
      throw new Error("early access request reached neither the table nor the inbox");
    }

    return { recorded: record.recorded, notified: notify.notified };
  });
}

async function recordRequest(
  request: EarlyAccessRequest,
): Promise<{ recorded: boolean; outcome: StepOutcome }> {
  // Demo mode: a fresh clone with an empty .env still gets a working form.
  // Not configured is a skip, not a failure — `outcome.failed` stays false.
  if (!isSupabaseConfigured()) {
    return { recorded: false, outcome: { attempted: false, failed: false } };
  }

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
      return { recorded: false, outcome: { attempted: true, failed: true } };
    }

    return { recorded: true, outcome: { attempted: true, failed: false } };
  } catch (error) {
    // A misconfigured service client must not cost us the notification below,
    // but it was a genuine attempt against a subsystem believed configured, so
    // it does count as a failure for that subsystem.
    console.error("early access insert threw", error);
    return { recorded: false, outcome: { attempted: true, failed: true } };
  }
}

async function notifyInbox(
  request: EarlyAccessRequest,
): Promise<{ notified: boolean; outcome: StepOutcome }> {
  // Not configured is a skip, not a failure — `outcome.failed` stays false.
  if (resolveEmailMode() === "unconfigured") {
    return { notified: false, outcome: { attempted: false, failed: false } };
  }

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

    // `sendEmail` returning at all — live or log — means it did not fail. Log
    // mode intentionally does not deliver, so `notified` stays false there, but
    // that is a deliberate non-delivery, not an error: `outcome.failed` is only
    // set in the catch block below, where the attempt itself came back broken.
    return {
      notified: delivery.mode === "live",
      outcome: { attempted: true, failed: false },
    };
  } catch (error) {
    console.error("early access notification failed", error);
    return { notified: false, outcome: { attempted: true, failed: true } };
  }
}
