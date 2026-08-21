import { z } from "zod";
import { can } from "@/lib/auth/permissions";
import { getDataSource } from "@/lib/data";
import { DataError } from "@/lib/data/errors";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";
import { widgetDocumentCsp, widgetDocumentHeaders } from "@/lib/widgets/csp";
import { renderPressWidgetDocument } from "@/lib/widgets/press/document";
import {
  parsePressPreviewRequest,
  resolvePressPreviewRow,
} from "@/lib/widgets/press/preview";
import { resolveRenderedPressWidget } from "@/lib/widgets/press/render";
import { samplePressWidgetRow } from "@/lib/widgets/press/sample";

/**
 * The in-app press preview frame.
 *
 * Sits under `/embed/` alongside the public document deliberately, because the
 * two must render through the same code: the whole value of a preview is the
 * guarantee that what somebody sees here is what a stranger will see there.
 * They share `resolveRenderedPressWidget` → `renderPressWidgetDocument`; only
 * the *selection* of the stories differs, and `src/lib/widgets/press/preview.ts`
 * records exactly why and what that costs.
 *
 * It is not public, and everything below follows from that:
 *
 * - **Authorised, not merely authenticated.** `getOrganizationContext()`
 *   re-reads the membership row and the configuration lives in the query
 *   string, so without a permission check any signed-in person could preview
 *   any monitoring query id they could guess. The check is
 *   `website_widget.manage`, the same permission the configuration screen
 *   requires.
 * - **Same-origin framing only.** The customer's approved-domain list is
 *   deliberately not applied (see `resolvePressPreviewRow`), so `'self'` is
 *   what keeps this frame from being embedded anywhere else at all.
 * - **Never cached.** It reflects unsaved form state and is scoped to one
 *   person's permissions. `no-store` is the only correct answer to both.
 *
 * Placed at `/embed/press-widget/preview` — a literal segment that
 * `isWidgetPublicIdShaped` would reject, so it can never collide with a real
 * public id even though it shares the parent path.
 *
 * **`?sample=1` is the one branch that is none of the above.** It renders
 * invented coverage (`@/lib/widgets/press/sample`) for the sample card on the
 * Website widgets landing page, and it reads no tenant data at all — no
 * mention, no monitoring query, no organization. So it answers before the
 * organization context is resolved, deliberately: the landing page is shown to
 * every member of an organization, including the ones who will never hold
 * `website_widget.manage`, and gating a fixed string of fiction behind a
 * permission check on data it never touches would blank the frame for them for
 * no gain. Everything else about the response is unchanged — same headers,
 * same `frame-ancestors 'self'`, same `no-store`.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const params = new URL(request.url).searchParams;

    if (params.get("sample") === "1") {
      return document(
        renderPressWidgetDocument({
          // As obviously not a public id as "preview" is, and distinct from it
          // so a frame in a server log says which of the two it was.
          publicId: "sample",
          rendered: resolveRenderedPressWidget(
            // Compared rather than parsed: the sample takes exactly one input
            // and the honest answer to any other value is the light card, not
            // a validation error inside a sample.
            samplePressWidgetRow(
              params.get("theme") === "dark" ? "dark" : "light",
              // A fixed instant rather than `Date.now()`. The sample's dates
              // are fiction either way, and pinning them keeps the landing
              // page byte-identical between renders — which is what lets the
              // edge cache it and what stops a snapshot test from depending on
              // the clock.
              SAMPLE_INSTANT,
            ),
          ),
        }),
        200,
      );
    }

    const context = await getOrganizationContext();

    if (!can(context.role, "website_widget.manage")) {
      return problem("You do not have permission to preview this widget.", 403);
    }

    const parsed = parsePressPreviewRequest(params);
    const dataSource = await getDataSource();

    const row = await resolvePressPreviewRow({ dataSource, scope: context.scope }, parsed);

    return document(
      renderPressWidgetDocument({
        // A stable, obviously-not-real id. The document's height script posts
        // it back to the parent, and the preview component matches on the
        // frame's window rather than on this value — but it must be *some*
        // string, and a real-looking one here would be a public id in a URL
        // that is not one.
        publicId: "preview",
        rendered: resolveRenderedPressWidget(row),
      }),
      200,
    );
  } catch (error) {
    // Anything that escapes renders as a plain sentence inside the frame
    // rather than as a 500 page. A preview panel that shows Next's error
    // screen inside a 380-pixel iframe tells the person nothing and looks
    // like the product is broken.
    if (error instanceof z.ZodError) {
      return problem("This preview is not configured yet.", 400);
    }
    if (error instanceof DataError) {
      return problem("This preview is not available.", 400);
    }
    console.error("[embed:press-preview]", error);
    return problem("The preview could not be loaded.", 500);
  }
}

/**
 * The instant the sample's dates are measured back from.
 *
 * 1 September 2026, chosen so the three invented stories read as "recent"
 * against the dates everything else in this repository uses, and fixed so the
 * sample never changes between two renders of the same page.
 */
const SAMPLE_INSTANT = Date.parse("2026-09-01T12:00:00.000Z");

function document(html: string, status: number): Response {
  return new Response(html, {
    status,
    headers: widgetDocumentHeaders({
      csp: widgetDocumentCsp({
        // Lia's own screens only. The public document opens this up to the
        // customer's approved domains; a preview has no business being framed
        // anywhere but here.
        frameAncestors: "frame-ancestors 'self'",
        // The same allowance the public press document carries, because this
        // renders the same logos through the same registry. Widening it here
        // and not there — or the reverse — would make the preview a different
        // program from the thing it previews.
        imgSrc: "'self' data:",
      }),
      cacheControl: "no-store",
    }),
  });
}

/**
 * A message the size of the frame it appears in.
 *
 * Styled inline for the same reason the widget document is: this response must
 * not depend on the product stylesheet, or the failure case would be the one
 * rendering path with a different set of dependencies from the success case.
 */
function problem(message: string, status: number): Response {
  const escaped = message.replace(/&/g, "&amp;").replace(/</g, "&lt;");
  return document(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Preview</title></head>` +
      `<body style="margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#5f6875">` +
      `<div class="widget" style="padding:20px">${escaped}</div></body></html>`,
    status,
  );
}
