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
 *    reason. The proxy runs before rendering and *can* write, so this is the
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
 *
 * Because it is a convenience and not the security boundary, the gate below
 * is a **product denylist** rather than a site allowlist: it redirects only
 * requests aimed at a known product route, and lets everything else — the
 * marketing site, and any path nobody has heard of — fall through to Next.
 * An allowlist got this backwards. `/` grew a public marketing site, and an
 * allowlist bounces every URL it does not recognise to `/sign-in`, including
 * a mistyped marketing link or a dead search-engine result that should
 * instead render a real 404. Since the actual security boundary is Postgres
 * row-level security, trading fail-closed convenience for correct public-site
 * behaviour does not move where enforcement happens — it only changes what an
 * anonymous visitor sees on their way to being told "no".
 */

/**
 * Product routes: the surfaces that require a session to be useful at all.
 * Everything else — marketing pages, auth screens, unknown paths — is left
 * alone by the gate below.
 *
 * Kept as a literal list rather than derived from `NAV_SECTIONS` in
 * `@/lib/navigation` because the nav only lists sidebar entries for a
 * signed-in user; this list is the contract with the proxy and should
 * change deliberately, in step with `manifest.json` and the routes under
 * `src/app/(app)/`.
 *
 * `/api` is here too, and deliberately not split out into its own concept.
 * Before this file inverted from an allowlist to a denylist, an anonymous
 * request to any `/api/...` route was redirected to `/sign-in` simply because
 * no API path was ever in the old allowlist — the OAuth callback and the
 * review-sync endpoint both rely on that: only a signed-in user reaches them,
 * because Google's redirect back to the callback carries the session cookie
 * the browser already has. Leaving `/api` off this list would have quietly
 * dropped that protection the day the gate flipped. If a genuinely public API
 * route is ever needed (a webhook, say), it should get an explicit carve-out
 * rather than a change to this default.
 */
export const PRODUCT_PATHS = [
  "/overview",
  "/mentions",
  "/reviews",
  "/reddit",
  "/media",
  "/responses",
  "/escalations",
  "/insights",
  "/locations",
  "/rules",
  "/integrations",
  "/brand-voice",
  "/settings",
  "/help",
  // First-run setup. Signed-in-only like every other product surface: the
  // wizard writes to an organization, so there is nothing an anonymous visitor
  // could do here but see a redirect from the layout instead of a sign-in form.
  "/onboarding",
  // Creating an organization. Here for the same reason `/onboarding` is, and it
  // is not optional: the route sits outside `(app)` precisely because it cannot
  // depend on an organization existing, so nothing above it would bounce an
  // anonymous request. Left off this list it would fall through the denylist to
  // a page that calls `requireSession()` and throws, which is the 500 this gate
  // exists to turn into a redirect. Segment-matched, so `/organizations/new`
  // and anything added under it are covered by the one entry.
  "/organizations",
  "/api",
];

/**
 * The carve-outs the comment above anticipated: paths that sit *inside* a
 * `PRODUCT_PATHS` entry but must stay reachable without a session.
 *
 * `/api/cron` is the only one, and it is here deliberately rather than by
 * omission. Vercel Cron invokes these routes with no browser session at all,
 * so leaving them under `/api` would redirect every scheduled invocation to
 * `/sign-in` and the route handler's own `CRON_SECRET` check would never run.
 * They are authenticated — by a shared secret checked inside the handler
 * (`isAuthorizedCronRequest`), not by a session cookie. Do not remove this to
 * "re-protect" them; that would silently break every scheduled sweep in
 * production, which is exactly what this comment exists to prevent.
 *
 * Checked before `PRODUCT_PATHS`, so the more specific rule wins.
 */
export const SESSIONLESS_PATHS = ["/api/cron"];

/**
 * Segment match, not `startsWith`: `/overview-of-pricing` (a hypothetical
 * marketing page) shares a prefix with `/overview` but is not the product
 * route, and must not be swept into the gate.
 */
function matchesSegment(pathname: string, path: string): boolean {
  return pathname === path || pathname.startsWith(`${path}/`);
}

export function isProductPath(pathname: string): boolean {
  if (SESSIONLESS_PATHS.some((path) => matchesSegment(pathname, path))) {
    return false;
  }
  return PRODUCT_PATHS.some((path) => matchesSegment(pathname, path));
}

export async function proxy(request: NextRequest) {
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

  // Denylist, not allowlist: redirect only when the request targets a known
  // product route. `/sign-in`, `/invite`, and the rest of the auth screens
  // are unaffected because they were never in `PRODUCT_PATHS`; the marketing
  // site and any path nobody has heard of fall through to Next, which is what
  // lets an unknown URL render a real 404 instead of a login form.
  if (!user && isProductPath(pathname)) {
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
