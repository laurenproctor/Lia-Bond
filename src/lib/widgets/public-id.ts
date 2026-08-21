import "server-only";

import { randomBytes } from "node:crypto";

import { WIDGET_KINDS, type WidgetKind } from "@/lib/widgets/kinds";

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
 * every restaurant using Lia, together with a live review or a live press list
 * from each. 15 random bytes is 120 bits, which makes the range unwalkable
 * while keeping the snippet short enough to read in a diff.
 *
 * Rotation is offered because a customer who wants an already-published
 * snippet to stop resolving has no other lever — they do not control every
 * page their marketing agency pasted it into.
 */

/** 15 bytes → 20 base64url characters, with no padding to explain to anyone. */
const PUBLIC_ID_BYTES = 15;

/**
 * The `rw_`/`pw_` prefix earns its three characters.
 *
 * It makes the value self-describing in a customer's page source, in a support
 * ticket, and in a server log — somebody looking at `pw_8Qk2…` knows what it
 * is, knows which of the two widgets it belongs to, and, just as usefully,
 * knows it is not a token to redact.
 *
 * It is also what stops one widget's snippet resolving against the other's
 * route: `/embed/press-widget/rw_…` is refused on shape before it reaches a
 * query, so a customer who pasted the wrong two lines gets an answer rather
 * than a lookup that silently returns nothing.
 */
const PATTERNS: Record<WidgetKind, RegExp> = {
  review: /^rw_[A-Za-z0-9_-]{20}$/,
  press: /^pw_[A-Za-z0-9_-]{20}$/,
};

export function generateWidgetPublicId(kind: WidgetKind): string {
  const prefix = WIDGET_KINDS[kind].publicIdPrefix;
  return `${prefix}${randomBytes(PUBLIC_ID_BYTES).toString("base64url")}`;
}

/**
 * Whether a value is shaped like an id this application issued for this widget.
 *
 * Checked before the value reaches a query. Not a security control — the
 * lookup is — but it turns a mistyped snippet into an immediate answer rather
 * than a round trip, and it keeps an arbitrary URL path segment out of the
 * database on the two routes in this codebase that anonymous traffic reaches
 * in volume.
 *
 * The kind is required rather than inferred from the prefix, deliberately. An
 * inferring check would accept a review id on the press route and then answer
 * "no such widget", which reads to a customer as a broken product rather than
 * as the wrong snippet.
 */
export function isWidgetPublicIdShaped(value: string, kind: WidgetKind): boolean {
  return PATTERNS[kind].test(value);
}
