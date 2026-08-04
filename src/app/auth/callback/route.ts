import { NextResponse, type NextRequest } from "next/server";
import { safeDestination } from "@/lib/auth/redirect";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Where an emailed auth link lands.
 *
 * Supabase sends a one-time `code`; exchanging it establishes the session and
 * sets the cookies. That exchange has to happen in a route handler rather than
 * a page, for the same reason session refresh lives in middleware — a server
 * component cannot set a cookie, so the session would be established and then
 * immediately lost.
 *
 * Used by password recovery today. Any future email link — an invite, an email
 * change — arrives here too, which is why the destination is a parameter
 * rather than hard-coded to the reset page.
 *
 * Two shapes arrive here, and both are handled because which one Supabase
 * sends is decided by how the link was requested, not by anything this route
 * controls:
 *
 * - `?code=` — PKCE. What `resetPasswordForEmail` produces, because the
 *   `@supabase/ssr` client sends a code challenge. Bound to the browser that
 *   asked, so it fails if the email is opened on a different device.
 * - `?token_hash=&type=` — a one-time token, carrying no browser binding.
 *   What an admin-generated link produces, and what the email template can be
 *   switched to (`{{ .TokenHash }}`) if requesting on a laptop and opening on
 *   a phone needs to work.
 *
 * There is a third shape this route cannot serve: an implicit-flow link puts
 * the tokens in the URL *fragment*, which browsers never send to a server. If
 * a link ever lands here with neither parameter, that is why — the fix is the
 * email template, not this handler.
 */

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest): Promise<NextResponse> {
  const { searchParams, origin } = request.nextUrl;
  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  // Same guard as the sign-in redirect: `next` arrives in a link an attacker
  // could construct, so it is validated as a relative path rather than trusted.
  const next = safeDestination(searchParams.get("next"));

  const supabase = await createSupabaseServerClient();

  let error: { message: string } | null = null;

  if (code) {
    ({ error } = await supabase.auth.exchangeCodeForSession(code));
  } else if (tokenHash) {
    ({ error } = await supabase.auth.verifyOtp({
      token_hash: tokenHash,
      // Matched against a known set rather than passed through: `type` decides
      // what the token is allowed to do, and it arrives in a link. Anything
      // unrecognised is treated as recovery, the narrowest of the two, rather
      // than forwarded to the provider to interpret.
      type: searchParams.get("type") === "invite" ? "invite" : "recovery",
    }));
  } else {
    // Supabase reports a rejected link with `error_description` rather than a
    // code. Its text is not forwarded — Lia says what to do instead.
    const reason = searchParams.get("error_description");
    if (reason) console.error("[auth:callback]", reason);

    return NextResponse.redirect(
      `${origin}/sign-in?error=${encodeURIComponent(
        "That link is not valid. Request a new one and try again.",
      )}`,
    );
  }

  if (error) {
    // Expired, already used, or issued to a different browser — PKCE ties the
    // exchange to the client that started it. All three mean the same thing to
    // the person holding the link.
    console.error("[auth:callback] exchange failed:", error.message);

    return NextResponse.redirect(
      `${origin}/sign-in?error=${encodeURIComponent(
        "That link has expired or was already used. Request a new one and try again.",
      )}`,
    );
  }

  return NextResponse.redirect(`${origin}${next}`);
}
