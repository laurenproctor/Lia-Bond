import { getDataSource } from "@/lib/data";
import { frameAncestorsDirective } from "@/lib/widgets/domains";
import { renderReviewWidgetDocument } from "@/lib/widgets/document";
import { isWidgetPublicIdShaped } from "@/lib/widgets/public-id";
import { resolveRenderedWidget } from "@/lib/widgets/render";

/**
 * The public widget document.
 *
 * The only route in this application that anonymous traffic reaches in volume,
 * and the only one whose output is rendered inside somebody else's website.
 * Four decisions are load-bearing.
 *
 * **1. A route handler, not a page.** A page under `src/app/` inherits the
 * root layout, `globals.css`, Tailwind's preflight, and the React runtime.
 * Inside an iframe on a restaurant's homepage every one of those is a
 * liability rather than a convenience — see the header of
 * `src/lib/widgets/document.ts`. This returns a string.
 *
 * **2. It always answers 200 with a drawable document.** A 404 inside an
 * iframe renders as the browser's own error page, in the browser's own
 * styling, on a customer's website. A widget whose id was rotated should say
 * so quietly in the customer's own typeface, and `resolveRenderedWidget` is
 * total for exactly this reason. The one exception is a malformed id, which is
 * answered 400 with the same document — nothing has been looked up, so there
 * is nothing to be quiet about, and a 400 keeps a garbage path out of any
 * cache.
 *
 * **3. `frame-ancestors` is the domain restriction.** The customer's approved
 * domains become a CSP directive on this response, and the *visitor's browser*
 * refuses to paint the frame elsewhere. That is what makes it a real control
 * on a URL anybody can fetch with curl. `Referer` is deliberately not
 * consulted — see `src/lib/widgets/domains.ts`.
 *
 * **4. It is cached, briefly.** A widget on a busy restaurant's homepage would
 * otherwise run a database query per page view for a review that changes
 * weekly. Sixty seconds at the edge with a five-minute stale window is the
 * trade: a customer who saves a change sees it on their site within a minute,
 * and a launch-day traffic spike does not become a query storm. `private` is
 * deliberately absent and `s-maxage` deliberately present — this document is
 * public by construction and identical for every visitor.
 */

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ publicId: string }> },
): Promise<Response> {
  const { publicId } = await params;

  // Shape-checked before it reaches a query. Not a security control — the
  // lookup is — but it turns a mistyped snippet into an immediate answer and
  // keeps an arbitrary URL segment out of the database on the one route that
  // strangers reach.
  if (!isWidgetPublicIdShaped(publicId)) {
    return documentResponse(
      renderReviewWidgetDocument({
        publicId: "",
        rendered: resolveRenderedWidget(null),
        now: Date.now(),
      }),
      // Unrestricted: there is no widget, so there are no approved domains to
      // read, and a restrictive policy here would blank the frame instead of
      // showing the customer why their snippet is wrong.
      frameAncestorsDirective([]),
      { status: 400, cacheSeconds: 0 },
    );
  }

  // `getDataSource()` builds its Supabase client from the request's cookies,
  // and an embed request carries none — so this runs as `anon`, which is
  // exactly right. What it can reach is one `SECURITY DEFINER` function
  // returning eleven named columns; every table policy denies it. Same shape
  // as the public invitation page, which resolves a token through
  // `invitation_preview` on an equally sessionless request.
  const dataSource = await getDataSource();
  const row = await dataSource.reviewWidgets.render(publicId);
  const rendered = resolveRenderedWidget(row);

  return documentResponse(
    renderReviewWidgetDocument({ publicId, rendered, now: Date.now() }),
    frameAncestorsDirective(rendered.allowedDomains),
    {
      status: 200,
      // An unknown id is not cached at the edge. It is the state a customer
      // sees immediately after rotating an embed id, and caching it would mean
      // the *new* snippet on the same page kept showing the old answer for a
      // minute while somebody tried to work out what they had done wrong.
      cacheSeconds: rendered.state === "unavailable" && row === null ? 0 : 60,
    },
  );
}

function documentResponse(
  html: string,
  frameAncestors: string,
  options: { status: number; cacheSeconds: number },
): Response {
  return new Response(html, {
    status: options.status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // The document's own policy, not the customer's. Three directives, each
      // closing something this page has no use for:
      //
      // - `frame-ancestors` is the domain restriction, and the reason this
      //   header exists at all.
      // - `default-src 'none'` with `style-src`/`script-src` set to
      //   `'unsafe-inline'` describes what the document actually is: inline
      //   CSS, one inline script, and no external resource of any kind. There
      //   is no origin it may fetch from, so a reviewer's text that somehow
      //   escaped escaping still could not reach the network.
      // - `sandbox` is deliberately NOT set here. The loader sets it on the
      //   iframe element, where the *embedder* controls it; setting it in a
      //   response header too would make the frame's origin opaque and break
      //   the height channel's origin check.
      "content-security-policy": [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        "script-src 'unsafe-inline'",
        "img-src data:",
        "form-action 'none'",
        "base-uri 'none'",
        frameAncestors,
      ].join("; "),
      // X-Frame-Options is deliberately absent: it cannot express a list of
      // origins, and its ALLOW-FROM form was removed from every current
      // browser. Sending DENY or SAMEORIGIN alongside the policy above would
      // break the entire feature in the browsers that honour it.
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "cache-control":
        options.cacheSeconds === 0
          ? "no-store"
          : `public, max-age=0, s-maxage=${options.cacheSeconds}, stale-while-revalidate=300`,
      // Never indexed. The review is already public on Google; a second
      // indexable copy on Lia's domain would compete with the customer's own
      // page for the words in it.
      "x-robots-tag": "noindex, nofollow",
    },
  });
}
