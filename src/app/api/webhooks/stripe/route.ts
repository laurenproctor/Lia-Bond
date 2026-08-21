import { NextResponse } from "next/server";
import { getServiceDataSource } from "@/lib/data";
import { billingAlert } from "@/lib/billing/alerts";
import { WebhookSignatureError } from "@/lib/billing/gateway";
import { getStripeGateway, isBillingAvailable } from "@/lib/billing/registry";
import { processStripeEvent } from "@/lib/billing/webhook";

/**
 * Stripe's webhook endpoint.
 *
 * Sessionless by nature: Stripe carries a signature, not a cookie. That makes
 * this the second write path in the codebase where row-level security is not
 * the backstop — the first being cron (D88) — so it carries its own tenancy
 * discipline, resolving the organization from the Stripe customer recorded in
 * `organization_billing` rather than from anything ambient or anything in the
 * payload.
 *
 * The route is deliberately thin. Everything that decides anything lives in
 * `@/lib/billing/webhook`, which is reachable from a test with the mock
 * gateway; this file turns an outcome into a status code and nothing else.
 *
 * ## The status codes, and why each one
 *
 * - **400** — the signature did not verify, or there was none. Nothing is
 *   stored and nothing is logged beyond the fact of it. This endpoint is
 *   reachable by anybody on the internet, and the SDK's own error message
 *   quotes the header and the payload length.
 * - **409** — another delivery of this same event is in flight. Stripe retries
 *   later; by then the first has finished and the retry sees a duplicate.
 * - **500** — durable processing failed. Stripe retries for up to three days,
 *   which is exactly the behaviour wanted: the common cause is a race that
 *   resolves itself.
 * - **200** — processed, a duplicate of something already processed, or a
 *   verified event of a type Lia does not handle. All three are successes, and
 *   an endpoint that 500s on an unfamiliar event type would retry it for three
 *   days.
 *
 * POST only. Stripe never GETs a webhook endpoint, and exporting a GET would
 * only give a scanner something to find.
 */

export const dynamic = "force-dynamic";
// Node, not Edge: the Supabase service client and the Stripe SDK both expect it.
export const runtime = "nodejs";

export async function POST(request: Request): Promise<Response> {
  if (!isBillingAvailable()) {
    // 503 rather than 200: a deployment with no Stripe configuration should
    // not be receiving Stripe events at all, and acknowledging them would
    // discard something somebody will later go looking for.
    return NextResponse.json({ error: "billing_not_configured" }, { status: 503 });
  }

  // The raw bytes, before anything else touches them. A parsed and
  // re-stringified body is a different sequence of bytes and will not verify.
  const rawBody = await request.text();
  const signature = request.headers.get("stripe-signature");

  const gateway = getStripeGateway();

  let event;
  try {
    event = await gateway.constructEvent(rawBody, signature);
  } catch (error) {
    if (error instanceof WebhookSignatureError) {
      billingAlert("signature");
      return NextResponse.json({ error: "invalid_signature" }, { status: 400 });
    }
    // Anything else here is a configuration failure — a missing signing
    // secret — not a bad request. It gets the same treatment as a processing
    // failure so it is retried once somebody fixes it.
    billingAlert("unhandled");
    return NextResponse.json({ error: "verification_failed" }, { status: 500 });
  }

  // Service-role: there is no session, so a session-bound client would be
  // rejected by every policy resolving through auth.uid().
  const dataSource = await getServiceDataSource();

  const outcome = await processStripeEvent({
    dataSource,
    gateway,
    event,
    now: new Date().toISOString(),
  });

  if (outcome.kind === "in_progress") {
    return NextResponse.json({ status: "in_progress" }, { status: 409 });
  }

  if (outcome.kind === "failed") {
    // The category, never a message. Stripe logs the response body and it is
    // visible in the Dashboard.
    return NextResponse.json({ status: "failed", reason: outcome.category }, { status: 500 });
  }

  return NextResponse.json({ status: outcome.detail }, { status: 200 });
}
