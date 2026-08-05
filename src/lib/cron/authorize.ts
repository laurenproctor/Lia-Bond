import "server-only";

import { env } from "@/lib/env";

/**
 * The guard shared by every scheduled route.
 *
 * Cron has no session, so it cannot go through `authorize()` (`src/lib/
 * actions/guard.ts`) the way every other write path does — there is no
 * membership to check. A shared secret is the only credential available, and
 * a missing `CRON_SECRET` means the check fails rather than passes: an
 * unconfigured deployment must refuse every scheduled request, not open the
 * route to whoever asks.
 *
 * One function rather than one copy per route, because a secret check is
 * exactly the kind of two-line thing that is easy to get subtly wrong twice —
 * comparing the wrong header, or the raw secret instead of the "Bearer "
 * form — and a single failure to reject reads as authorized everywhere it is
 * copied.
 */
export function isAuthorizedCronRequest(request: Request): boolean {
  const secret = env.CRON_SECRET;
  if (!secret) return false;

  const header = request.headers.get("authorization");
  return header === `Bearer ${secret}`;
}
