import "server-only";

import { createHash, randomBytes } from "node:crypto";

/**
 * Invitation tokens.
 *
 * The same construction as OAuth handshake state, for the same reason: the
 * token is a bearer capability, so what reaches the database is only its
 * SHA-256 hash. A leaked backup of `invitations` is then a list of digests
 * rather than a set of working keys.
 *
 * 32 bytes from the OS CSPRNG, base64url-encoded to 43 characters. Not a uuid:
 * a v4 uuid carries 122 bits of entropy but is *formatted* like an identifier,
 * and identifiers end up in logs, URLs that get shared, and error messages.
 * Something that looks like a secret is treated like one.
 *
 * There is no timing-safe comparison here, and none is needed. Lookup is by
 * hash through a database index, so no comparison against the stored value
 * ever happens in application code — and a digest reveals nothing about the
 * preimage even if it did.
 */

const TOKEN_BYTES = 32;

/** Base64url of 32 bytes. Rejects anything that was not issued here. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{40,64}$/;

export function generateInvitationToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Whether a value is shaped like a token this application issued.
 *
 * Checked before the value reaches the database. It is not a security control
 * — the hash lookup is — but it keeps arbitrary path segments out of a query
 * and turns an obviously malformed link into an immediate answer.
 */
export function isInvitationTokenShaped(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

/** Where an invitation link points. Absolute, because it is sent to a person. */
export function invitationUrl(origin: string, token: string): string {
  return `${origin.replace(/\/$/, "")}/invite/${token}`;
}
