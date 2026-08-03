import { NextResponse, type NextRequest } from "next/server";
import { getGoogleConnector } from "@/integrations/registry";
import { IntegrationError, toIntegrationMessage } from "@/integrations/errors";
import { mutationContext } from "@/lib/actions/guard";
import { can } from "@/lib/auth/permissions";
import { DataError, toUserMessage } from "@/lib/data/errors";
import { ConfigurationError } from "@/lib/env";
import {
  completeGoogleAuthorization,
  GOOGLE_PLATFORM,
} from "@/lib/integrations/google-service";
import { consumeState, OAuthStateError } from "@/lib/integrations/oauth-state";

/**
 * The Google OAuth callback.
 *
 * Everything a caller controls here is hostile until proven otherwise: the
 * code, the state, and the error parameter all arrive through a browser
 * redirect that anybody can construct. Nothing in the query string is trusted
 * to establish identity — the Lia user comes from the session and the
 * organization comes from the consumed state row, both server-side.
 *
 * The state is consumed *before* the code is exchanged. A code exchange is a
 * network round trip; leaving the state redeemable across it would give a
 * replay a window to slip through.
 */

export const dynamic = "force-dynamic";

function redirectTo(
  request: NextRequest,
  path: string,
  params: Record<string, string> = {},
): NextResponse {
  const url = new URL(path, request.nextUrl.origin);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  // Never a token, never a code, never the state — only a status and a
  // human-readable message. Redirect URLs end up in browser history and
  // referrer headers.
  return NextResponse.redirect(url, { status: 303 });
}

function failure(request: NextRequest, message: string): NextResponse {
  return redirectTo(request, "/integrations", { error: message });
}

/** Google's own `error` parameter, translated into something actionable. */
const PROVIDER_ERROR_MESSAGES: Record<string, string> = {
  access_denied:
    "Google access was not granted. Nothing was connected — start again if that was not what you intended.",
  admin_policy_enforced:
    "A Google Workspace policy blocked this connection. Ask your Google administrator to allow Lia, then try again.",
  disallowed_useragent:
    "Google refused the browser used for this connection. Try again in a standard browser window.",
  invalid_scope:
    "Google rejected the permissions Lia requested. Let your administrator know.",
  server_error: "Google reported an error during authorization. Try again shortly.",
  temporarily_unavailable:
    "Google was temporarily unavailable during authorization. Try again shortly.",
};

export async function GET(request: NextRequest): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const providerError = params.get("error");
  const code = params.get("code");
  const state = params.get("state");

  // Handled first and separately. A declined consent screen is the single most
  // common outcome here and it is not a failure of Lia's — it deserves calm
  // wording rather than the generic error path.
  if (providerError) {
    return failure(
      request,
      PROVIDER_ERROR_MESSAGES[providerError] ??
        "Google did not complete the authorization. Try again shortly.",
    );
  }

  if (!code) {
    return failure(
      request,
      "That authorization link was incomplete. Start the connection again.",
    );
  }

  try {
    // Session and active organization, resolved server-side. The membership row
    // is re-read here, so a state row naming an organization the caller has
    // since left cannot be redeemed.
    const context = await mutationContext();

    // Checked before the state is spent. Someone who lost the permission
    // between starting and finishing should get a clear refusal, not a
    // connection.
    if (
      !can(context.role, "integration.connect") &&
      !can(context.role, "integration.reauthorize")
    ) {
      return failure(
        request,
        "Your role cannot connect integrations for this organization.",
      );
    }

    const stateRecord = await consumeState({
      dataSource: context.dataSource,
      state,
      expectedProvider: GOOGLE_PLATFORM,
      currentUserId: context.userId,
      currentOrganizationId: context.organization.id,
    });

    const connector = getGoogleConnector();

    // Scope validation happens inside the connector: a grant that does not
    // carry `business.manage` throws `insufficient_scope` rather than being
    // stored as a connection that looks healthy and fails on every request.
    const credentials = await connector.exchangeAuthorizationCode({ code });

    // Establishing *which* Google account was connected needs an authenticated
    // call, and the account listing is the one Lia's single scope grants. An
    // identity scope would be extra access for information already available.
    //
    // The session is built inline rather than through `credentialSession()`
    // because there is no connection row to write back to yet: on a first
    // connect the row is created from the account this call returns. A refresh
    // cannot happen here anyway — the access token is seconds old — and
    // whatever the connector ends up holding is persisted immediately below.
    const accounts = await connector.listExternalAccounts({
      credentials,
      async onRefreshed() {
        /* No connection exists yet. Nothing to persist against. */
      },
    });

    const account = accounts[0];
    if (!account) {
      return failure(
        request,
        "That Google account does not manage any Business Profile accounts. Sign in with an account that administers your listings, then try again.",
      );
    }

    const { connection } = await completeGoogleAuthorization({
      dataSource: context.dataSource,
      scope: context.scope,
      credentials,
      account,
      userId: context.userId,
      reauthorization: stateRecord.reauthorization,
    });

    return redirectTo(request, stateRecord.redirectPath, {
      connected: "1",
      // Named, not counted: "connected 2 accounts" would be wrong, and the name
      // is what lets someone confirm they authorised the right Google account.
      account: connection.externalAccountName ?? "",
    });
  } catch (error) {
    if (error instanceof OAuthStateError) {
      return failure(request, error.message);
    }

    if (error instanceof ConfigurationError) {
      console.error(
        "[integrations:google:callback] not configured:",
        error.missing.join(", "),
      );
      return failure(
        request,
        "Google Business Profile is not configured on this server. Ask your administrator to finish setup.",
      );
    }

    if (error instanceof IntegrationError) {
      // Lia's wording, from a normalised code. Google's own text never reaches
      // a redirect URL — it quotes request parameters.
      console.error("[integrations:google:callback] provider:", error.code);
      return failure(request, toIntegrationMessage(error));
    }

    if (error instanceof DataError) {
      return failure(request, toUserMessage(error));
    }

    console.error("[integrations:google:callback]", error);
    return failure(
      request,
      "Lia could not finish connecting Google. Try again shortly.",
    );
  }
}
