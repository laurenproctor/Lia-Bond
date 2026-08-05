import "server-only";

import { createHash, timingSafeEqual } from "node:crypto";
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

/** Fixed-length regardless of input, so `timingSafeEqual` never sees a length mismatch. */
function digest(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function isAuthorizedCronRequest(request: Request): boolean {
  const secret = env.CRON_SECRET;
  if (!secret) return false;

  const header = request.headers.get("authorization") ?? "";
  const expected = `Bearer ${secret}`;

  // Hashed before comparing, not compared directly: `timingSafeEqual` throws
  // on a length mismatch, and an attacker-controlled header can be any
  // length, so a naive `if (a.length !== b.length) return false` branch would
  // leak the secret's length through timing — the exact thing this function
  // exists to avoid. Hashing first means both buffers are always 32 bytes,
  // so there is no length branch to take at all.
  return timingSafeEqual(digest(header), digest(expected));
}
