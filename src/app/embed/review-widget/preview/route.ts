import { z } from "zod";
import { can } from "@/lib/auth/permissions";
import { getDataSource } from "@/lib/data";
import { DataError } from "@/lib/data/errors";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";
import { renderReviewWidgetDocument } from "@/lib/widgets/document";
import { parsePreviewRequest, resolvePreviewRow } from "@/lib/widgets/preview";
import { resolveRenderedWidget } from "@/lib/widgets/render";

/**
 * The in-app preview frame.
 *
 * Sits under `/embed/` alongside the public document deliberately, because the
 * two must render through the same code: the whole value of a preview is the
 * guarantee that what somebody sees here is what a stranger will see there.
 * They share `resolvePreviewRow` → `resolveRenderedWidget` →
 * `renderReviewWidgetDocument`; only the *selection* of the review differs,
 * and `src/lib/widgets/preview.ts` records exactly why and what that costs.
 *
 * It is not public, and everything below follows from that:
 *
 * - **Authorised, not merely authenticated.** `getOrganizationContext()`
 *   re-reads the membership row and the configuration lives in the query
 *   string, so without a permission check any signed-in person could preview
 *   any location id they could guess. The check is `review_widget.manage`,
 *   the same permission the configuration screen requires — this route renders
 *   review text for a location, and read access to that has to be earned the
 *   same way.
 * - **Same-origin framing only.** The customer's approved-domain list is
 *   deliberately *not* applied (see `resolvePreviewRow`), so `'self'` is what
 *   keeps this frame from being embedded anywhere else at all.
 * - **Never cached.** It reflects unsaved form state and is scoped to one
 *   person's permissions. `no-store` is the only correct answer to both.
 *
 * Placed at `/embed/review-widget/preview` — a literal segment that
 * `isWidgetPublicIdShaped` would reject, so it can never collide with a real
 * public id even though it shares the parent path.
 */

export const dynamic = "force-dynamic";

export async function GET(request: Request): Promise<Response> {
  try {
    const context = await getOrganizationContext();

    if (!can(context.role, "review_widget.manage")) {
      return problem("You do not have permission to preview this widget.", 403);
    }

    const parsed = parsePreviewRequest(new URL(request.url).searchParams);
    const dataSource = await getDataSource();

    const row = await resolvePreviewRow(
      { dataSource, scope: context.scope },
      parsed,
    );

    return document(
      renderReviewWidgetDocument({
        // A stable, obviously-not-real id. The document's height script posts
        // it back to the parent, and the preview component matches on the
        // frame's window rather than on this value — but it must be *some*
        // string, and a real-looking one here would be a public id in a URL
        // that is not one.
        publicId: "preview",
        rendered: resolveRenderedWidget(row),
        now: Date.now(),
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
    console.error("[embed:preview]", error);
    return problem("The preview could not be loaded.", 500);
  }
}

function document(html: string, status: number): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-security-policy": [
        "default-src 'none'",
        "style-src 'unsafe-inline'",
        "script-src 'unsafe-inline'",
        "img-src data:",
        "form-action 'none'",
        "base-uri 'none'",
        // Lia's own screens only. The public document opens this up to the
        // customer's approved domains; a preview has no business being framed
        // anywhere but here.
        "frame-ancestors 'self'",
      ].join("; "),
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "x-content-type-options": "nosniff",
      "x-robots-tag": "noindex, nofollow",
    },
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
      `<body style="margin:0;font:14px/1.5 -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#6b7280">` +
      `<div class="widget" style="padding:20px">${escaped}</div></body></html>`,
    status,
  );
}
