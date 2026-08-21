import { getDataSource } from "@/lib/data";
import { widgetDocumentCsp, widgetDocumentHeaders } from "@/lib/widgets/csp";
import { frameAncestorsDirective } from "@/lib/widgets/domains";
import { renderPressWidgetDocument } from "@/lib/widgets/press/document";
import { resolveRenderedPressWidget } from "@/lib/widgets/press/render";
import { isWidgetPublicIdShaped } from "@/lib/widgets/public-id";

/**
 * The public press widget document.
 *
 * One of the two routes anonymous traffic reaches in volume, and one of the
 * two whose output is rendered inside somebody else's website. Five decisions
 * are load-bearing; the first four are the review document's, restated because
 * they hold identically here, and the fifth is new.
 *
 * **1. A route handler, not a page.** A page under `src/app/` inherits the
 * root layout, `globals.css`, Tailwind's preflight, and the React runtime.
 * Inside an iframe on a restaurant's homepage every one of those is a
 * liability rather than a convenience. This returns a string.
 *
 * **2. It always answers 200 with a drawable document.** A 404 inside an
 * iframe renders as the browser's own error page, in the browser's own
 * styling, on a customer's website. `resolveRenderedPressWidget` is total for
 * exactly this reason. The one exception is a malformed id, which is answered
 * 400 with the same document — nothing has been looked up, so there is nothing
 * to be quiet about, and a 400 keeps a garbage path out of any cache.
 *
 * **3. `frame-ancestors` is the domain restriction.** The customer's approved
 * domains become a CSP directive on this response, and the *visitor's browser*
 * refuses to paint the frame elsewhere. `Referer` is deliberately not
 * consulted — see `src/lib/widgets/domains.ts`.
 *
 * **4. It is cached, briefly.** Sixty seconds at the edge with a five-minute
 * stale window. A press strip on a busy homepage would otherwise run a query
 * per page view for coverage that changes weekly, and a saved change still
 * appears within a minute.
 *
 * **5. `img-src 'self'`, and never wider.** This is the one widget that loads
 * files, and every one of them is a bundled publisher logo Lia serves from its
 * own origin. The registry decides which local file is drawn; the content
 * policy decides that only local files can be. Neither alone would be enough:
 * without the policy a future bug could reach a publisher's server, and
 * without the registry the policy would have nothing to protect. `data:` is
 * kept alongside `'self'` because the shared CSP helper's review branch needs
 * it and a widget-specific divergence there would be one more thing to hold in
 * mind; nothing in this document emits a data URI.
 *
 * **It never triggers a poll.** This route reads what monitoring has already
 * ingested. An embed that fetched news would put a provider request — and a
 * shared daily budget — behind an anonymous URL on somebody else's homepage.
 */

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ publicId: string }> },
): Promise<Response> {
  const { publicId } = await params;

  // Shape-checked before it reaches a query, and checked against the *press*
  // prefix specifically. A review widget's `rw_…` id pasted into a press
  // snippet is answered here rather than becoming a lookup that returns
  // nothing — "no such widget" would send somebody hunting for a deleted
  // widget when what they actually did was copy the wrong two lines.
  if (!isWidgetPublicIdShaped(publicId, "press")) {
    return documentResponse(
      renderPressWidgetDocument({
        publicId: "",
        rendered: resolveRenderedPressWidget(null),
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
  // returning eleven named columns; every table policy denies it.
  const dataSource = await getDataSource();
  const row = await dataSource.pressWidgets.render(publicId);
  const rendered = resolveRenderedPressWidget(row);

  return documentResponse(
    renderPressWidgetDocument({ publicId, rendered }),
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
    headers: widgetDocumentHeaders({
      csp: widgetDocumentCsp({ frameAncestors, imgSrc: "'self' data:" }),
      cacheControl:
        options.cacheSeconds === 0
          ? "no-store"
          : `public, max-age=0, s-maxage=${options.cacheSeconds}, stale-while-revalidate=300`,
    }),
  });
}
