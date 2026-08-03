import { NextResponse, type NextRequest } from "next/server";
import { isAllowedRedirectPath } from "@/domain";
import { getGoogleConnector } from "@/integrations/registry";
import { authorize } from "@/lib/actions/guard";
import { recordAuditEvent } from "@/lib/audit/record";
import { DataError, toUserMessage } from "@/lib/data/errors";
import { ConfigurationError } from "@/lib/env";
import {
  GOOGLE_PLATFORM,
  getGoogleConnection,
} from "@/lib/integrations/google-service";
import { issueState, OAuthStateError } from "@/lib/integrations/oauth-state";

/**
 * Start the Google authorization flow.
 *
 * POST, not GET, and that is a security decision rather than a REST preference:
 * a GET that mints OAuth state and redirects to a consent screen can be
 * triggered by an `<img>` tag on any page on the internet. POST means the
 * request has to come from a form on Lia.
 *
 * The order below is the order it has to be in. Authorise first — a viewer must
 * not be able to burn a state row, let alone reach Google. Only then is state
 * issued, and only then is the authorization URL built.
 */

export const dynamic = "force-dynamic";

/** Where a failure lands, with a message the integrations screen renders. */
function failureRedirect(request: NextRequest, message: string): NextResponse {
  const url = new URL("/integrations", request.nextUrl.origin);
  url.searchParams.set("error", message);
  return NextResponse.redirect(url, { status: 303 });
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  let redirectPath = "/integrations/google-business-profile/setup";
  let reauthorization = false;

  try {
    const form = await request.formData().catch(() => null);
    const requested = form?.get("redirectPath");
    reauthorization = form?.get("reauthorize") === "1";

    // The caller may choose only from a closed list. Anything else is ignored
    // rather than rejected — this is the parameter an open-redirect wants, and
    // silently falling back to the default is the safest handling.
    if (isAllowedRedirectPath(requested)) redirectPath = requested;

    // Reauthorizing and connecting are different permissions, so the gate
    // depends on which one this is. `authorize` throws a typed DataError.
    const context = await authorize(
      reauthorization ? "integration.reauthorize" : "integration.connect",
    );

    const existing = await getGoogleConnection(context);

    // Force the consent screen only when a new refresh token is genuinely
    // needed: reconnecting a connection Google already granted returns no
    // refresh token on a silent approval, and without one the connection cannot
    // renew itself. A first connection gets consent from Google anyway, so
    // forcing it there would only train people to click through it.
    const forceConsent = reauthorization || existing?.status === "action_required";

    const { value: state } = await issueState({
      dataSource: context.dataSource,
      provider: GOOGLE_PLATFORM,
      organizationId: context.organization.id,
      userId: context.userId,
      redirectPath,
      reauthorization,
    });

    const authorizationUrl = await getGoogleConnector().getAuthorizationUrl({
      state,
      forceConsent,
    });

    await recordAuditEvent(context, {
      eventType: reauthorization
        ? "integration.reauthorization_started"
        : "integration.oauth_started",
      entityType: "platform_connection",
      // A first connection has no row yet, so the event is attributed to the
      // organization. Every later event carries the real connection id.
      entityId: existing?.id ?? context.organization.id,
      previousState: existing ? { status: existing.status } : null,
      newState: null,
      // No state value, no redirect URI, no client id. Only the shape of the
      // request, which is what an auditor actually needs.
      metadata: { platform: GOOGLE_PLATFORM, forceConsent, redirectPath },
    });

    // 303 so the browser follows with GET. A 307 would replay the POST body at
    // Google's consent endpoint.
    return NextResponse.redirect(authorizationUrl, { status: 303 });
  } catch (error) {
    if (error instanceof ConfigurationError) {
      // Names only, never values. This is the one error an operator has to see
      // in a log to fix, and the one a user can do nothing about.
      console.error(
        "[integrations:google:connect] not configured:",
        error.missing.join(", "),
      );
      return failureRedirect(
        request,
        "Google Business Profile is not configured on this server. Ask your administrator to finish setup.",
      );
    }

    if (error instanceof OAuthStateError || error instanceof DataError) {
      return failureRedirect(request, toUserMessage(error));
    }

    console.error("[integrations:google:connect]", error);
    return failureRedirect(
      request,
      "Lia could not start the Google connection. Try again shortly.",
    );
  }
}
