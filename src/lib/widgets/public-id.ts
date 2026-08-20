import "server-only";

import { randomBytes } from "node:crypto";

/**
 * The identifier in the customer's page.
 *
 * Explicitly **not** a secret, and the contrast with
 * `src/lib/auth/invitation-token.ts` is the point. An invitation token is a
 * bearer capability, so only its SHA-256 hash reaches the database. This value
 * is pasted into public HTML by design — hashing it would buy nothing, and
 * pretending it were confidential would encourage somebody to hang a real
 * permission off it later.
 *
 * It is random rather than sequential for one narrow, real reason: a
 * sequential id would let anybody enumerate the range and produce a list of
 * every restaurant using Lia, together with a live review from each. 15 random
 * bytes is 120 bits, which makes the range unwalkable while keeping the
 * snippet short enough to read in a diff.
 *
 * Rotation is offered because a customer who wants an already-published
 * snippet to stop resolving has no other lever — they do not control every
 * page their marketing agency pasted it into.
 */

/** 15 bytes → 20 base64url characters, with no padding to explain to anyone. */
const PUBLIC_ID_BYTES = 15;

/**
 * The `rw_` prefix earns its three characters.
 *
 * It makes the value self-describing in a customer's page source, in a support
 * ticket, and in a server log — somebody looking at `rw_8Qk2…` knows what it
 * is and, just as usefully, knows it is not a token to redact.
 */
const PUBLIC_ID_PREFIX = "rw_";

const PUBLIC_ID_PATTERN = /^rw_[A-Za-z0-9_-]{20}$/;

export function generateWidgetPublicId(): string {
  return `${PUBLIC_ID_PREFIX}${randomBytes(PUBLIC_ID_BYTES).toString("base64url")}`;
}

/**
 * Whether a value is shaped like an id this application issued.
 *
 * Checked before the value reaches a query. Not a security control — the
 * lookup is — but it turns a mistyped snippet into an immediate answer rather
 * than a round trip, and it keeps an arbitrary URL path segment out of the
 * database on the one route in this codebase that anonymous traffic reaches in
 * volume.
 */
export function isWidgetPublicIdShaped(value: string): boolean {
  return PUBLIC_ID_PATTERN.test(value);
}
