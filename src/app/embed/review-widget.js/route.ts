import { appOrigin } from "@/lib/env";
import { buildLoaderScript } from "@/lib/widgets/loader";

/**
 * The loader script every embed snippet points at.
 *
 * A route handler at a literal `.js` path rather than a file in `public/`, and
 * the reason is the origin. The script has to know where Lia lives so it can
 * build the iframe's `src` and check the origin of the height messages it
 * receives — and that answer differs between production, a preview
 * deployment, and a developer's laptop. A static file would have to hard-code
 * one of them, and the one it hard-coded would be wrong everywhere else.
 *
 * The URL is deliberately unfingerprinted. It is pasted into customer websites
 * and will outlive several rewrites of everything else in this repository, so
 * it can never carry a build hash. That constrains caching: a long
 * `max-age` would leave a fixed bug live in browsers for its duration, so the
 * browser cache is short and the shared cache does the heavy lifting with a
 * long stale window.
 */

export const dynamic = "force-dynamic";

export async function GET(): Promise<Response> {
  return new Response(buildLoaderScript(appOrigin()), {
    headers: {
      "content-type": "application/javascript; charset=utf-8",
      // Read by browsers on origins Lia does not control. `*` is correct and
      // costs nothing: the response is a static script with no session, no
      // cookie, and nothing tenant-specific in it.
      "access-control-allow-origin": "*",
      "cache-control":
        "public, max-age=300, s-maxage=3600, stale-while-revalidate=86400",
      "x-content-type-options": "nosniff",
    },
  });
}
