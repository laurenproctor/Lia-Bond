import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { authorize } from "@/lib/actions/guard";
import { DataError, toUserMessage } from "@/lib/data/errors";
import { ConfigurationError } from "@/lib/env";
import { IntegrationError, toIntegrationMessage } from "@/integrations/errors";
import { syncGoogleReviews } from "@/lib/integrations/google-reviews";

/**
 * Manual review synchronisation.
 *
 * The application's own screens call `syncGoogleReviewsAction` — server actions
 * are how every other mutation in Lia is triggered, and this route does not
 * change that. It exists for the callers a server action cannot serve: an
 * operator running a one-off import from a terminal, and the scheduled job this
 * workflow is deliberately shaped for but does not build.
 *
 * Both paths go through the same `syncGoogleReviews` service, so there is one
 * implementation of the ordering that matters — take the lock, refresh, fetch,
 * upsert, record, audit — rather than two that can drift.
 *
 * POST only, and never a GET: a GET that spends a customer's Google quota can
 * be triggered by an `<img>` tag on any page on the internet.
 */

export const dynamic = "force-dynamic";

const requestSchema = z.object({
  /**
   * The connected Google location.
   *
   * Named `channelId` in the published contract because that is the word the
   * API speaks; internally it is a `platform_profiles` row. Both spellings are
   * accepted so a caller written against either does not get a validation error
   * for a naming decision they had no part in.
   */
  channelId: z.uuid().optional(),
  platformProfileId: z.uuid().optional(),
});

/** HTTP status for a typed data failure. Never leaks a driver message. */
function statusFor(error: DataError): number {
  switch (error.code) {
    case "not_authenticated":
      return 401;
    case "forbidden":
    case "not_a_member":
      return 403;
    case "not_found":
      return 404;
    case "conflict":
      return 409;
    case "invalid_input":
      return 400;
    default:
      return 503;
  }
}

function errorResponse(message: string, status: number): NextResponse {
  return NextResponse.json({ ok: false, error: message }, { status });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  try {
    const body = await request.json().catch(() => null);
    const parsed = requestSchema.safeParse(body ?? {});

    if (!parsed.success) {
      return errorResponse("Provide a valid channelId.", 400);
    }

    const platformProfileId = parsed.data.channelId ?? parsed.data.platformProfileId;
    if (!platformProfileId) {
      return errorResponse("Provide a channelId.", 400);
    }

    // Authorisation before anything else. A viewer must not be able to spend a
    // customer's Google quota, and the permission check is also what
    // establishes the organization the id below is resolved within — so a
    // channel belonging to another workspace is simply not found.
    const context = await authorize("integration.sync_reviews");

    const result = await syncGoogleReviews(context, {
      platformProfileId,
      trigger: "manual",
    });

    return NextResponse.json({
      ok: true,
      syncRunId: result.syncRunId,
      channelId: result.platformProfileId,
      status: result.status,
      counts: result.counts,
      totalReviewCount: result.totalReviewCount,
      lastSuccessfulSyncAt: result.lastSuccessfulSyncAt,
      // Present only when there is something to say. No provider payload, no
      // Google status string, no token — the same sanitised sentence the
      // screen shows.
      ...(result.errorMessage ? { error: result.errorMessage } : {}),
    });
  } catch (error) {
    if (error instanceof DataError) {
      return errorResponse(toUserMessage(error), statusFor(error));
    }

    if (error instanceof ConfigurationError) {
      // An operator problem. Names only, never values.
      console.error(
        "[integrations:google:reviews:sync] not configured:",
        error.missing.join(", "),
      );
      return errorResponse(
        "Google Business Profile is not configured on this server.",
        503,
      );
    }

    if (error instanceof IntegrationError) {
      // Reached only when a provider failure escapes the service's own
      // handling. Lia's wording, from a normalised code.
      console.error("[integrations:google:reviews:sync] provider:", error.code);
      return errorResponse(toIntegrationMessage(error), 502);
    }

    console.error("[integrations:google:reviews:sync]", error);
    return errorResponse(
      "Lia could not import reviews for this location. Try again shortly.",
      500,
    );
  }
}
