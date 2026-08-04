import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

/**
 * Session refresh and the authentication gate.
 *
 * Two jobs, and they have to happen here rather than in a page:
 *
 * 1. **Refresh.** Supabase access tokens are short-lived. A server component
 *    cannot set a cookie, so nothing inside the app can persist a rotated
 *    token — `createSupabaseServerClient` swallows the write for exactly that
 *    reason. Middleware runs before rendering and *can* write, so this is the
 *    only place a refreshed session survives the request.
 *
 * 2. **The gate.** Redirect an unauthenticated request to `/sign-in` rather
 *    than letting it reach a page that throws. Without this every route
 *    returns a 500 with "Sign in to continue", which is technically correct
 *    and useless to the person reading it.
 *
 * This is a convenience, not a security boundary. It runs on a cookie the
 * browser supplied. The real enforcement is row-level security in Postgres —
 * `auth.uid()` comes from the verified JWT, so a forged cookie gets a session
 * that can read nothing. Deleting this file would make the app unpleasant,
 * not insecure.
 */

/**
 * Routes reachable without a session.
 *
 * `/reset-password` is here even though it needs a *recovery* session, which
 * is a real session. If middleware bounced an unauthenticated visitor, someone
 * with a dead link would land back on sign-in with no explanation; the page
 * checks for itself and says the link expired.
 *
 * `/invite` is public for the same class of reason and one more: an invitee
 * usually has no account at all, so there is no session to gate on. The token
 * in the path is what authorises the page, and it is checked there.
 */
const PUBLIC_PATHS = [
  "/sign-in",
  "/sign-up",
  "/forgot-password",
  "/reset-password",
  "/auth",
  // Invitations are opened by people who do not have an account yet. Gating
  // this would bounce every invitee to sign-in and lose the token on the way.
  "/invite",
];

function isPublic(pathname: string): boolean {
  return PUBLIC_PATHS.some(
    (path) => pathname === path || pathname.startsWith(`${path}/`),
  );
}

export async function middleware(request: NextRequest) {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

  // Demo mode. With no Supabase project configured the app runs on the seed
  // dataset and `getSession()` returns a seeded user, so gating here would
  // lock everyone out of an app that has no way to let them back in.
  if (!url || !anonKey) return NextResponse.next();

  let response = NextResponse.next({ request });

  const supabase = createServerClient(url, anonKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet) {
        // Written to both: the request so a downstream server component reads
        // the refreshed token in this same pass, and the response so the
        // browser keeps it for the next one. Setting only the response means
        // the current render still uses the stale token.
        for (const { name, value } of cookiesToSet) {
          request.cookies.set(name, value);
        }
        response = NextResponse.next({ request });
        for (const { name, value, options } of cookiesToSet) {
          response.cookies.set(name, value, options);
        }
      },
    },
  });

  // `getUser()` rather than `getSession()`: it verifies the token with the
  // auth server instead of trusting what the cookie claims. This call is also
  // what triggers the refresh whose cookies are captured above, so it must not
  // be skipped even when the answer is unused.
  const {
    data: { user },
  } = await supabase.auth.getUser();

  const { pathname, search } = request.nextUrl;

  if (!user && !isPublic(pathname)) {
    const signIn = request.nextUrl.clone();
    signIn.pathname = "/sign-in";
    signIn.search = "";
    // Where they were headed, so signing in resumes it rather than dumping
    // everyone on the overview. Path only — a full URL here is an open
    // redirect, and `next` is exactly the parameter an attacker wants.
    if (pathname !== "/") {
      signIn.searchParams.set("next", `${pathname}${search}`);
    }
    return NextResponse.redirect(signIn);
  }

  // Already signed in and looking at a page that exists to create a session:
  // send them onward rather than showing a form that would do nothing.
  //
  // `/invite` is deliberately not in this list. A signed-in person opening an
  // invitation is the *expected* case, and bouncing them to the overview would
  // silently discard the invitation they were trying to accept.
  if (user && (pathname === "/sign-in" || pathname === "/sign-up")) {
    const target = request.nextUrl.clone();
    target.pathname = "/overview";
    target.search = "";
    return NextResponse.redirect(target);
  }

  return response;
}

export const config = {
  /**
   * Everything except static assets and image optimisation.
   *
   * Deliberately includes API routes: the OAuth callback and the review-sync
   * endpoint both need a refreshed session, and excluding them would leave
   * those the only paths running on a possibly-expired token.
   */
  matcher: [
    "/((?!_next/static|_next/image|favicon.ico|icon.svg|manifest.json|.*\\.(?:png|jpg|jpeg|gif|webp|svg)$).*)",
  ],
};
