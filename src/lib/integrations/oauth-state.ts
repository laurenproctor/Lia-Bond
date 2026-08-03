import "server-only";

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  isAllowedRedirectPath,
  OAUTH_STATE_TTL_MINUTES,
  type OAuthState,
  type Platform,
} from "@/domain";
import type { LiaDataSource } from "@/lib/data/types";

/**
 * OAuth handshake state.
 *
 * The `state` parameter is the only thing standing between Lia and a CSRF on
 * the connect flow: without it, anyone could send an administrator a link to
 * Lia's callback carrying *their* authorization code and quietly attach their
 * Google account to the administrator's organization.
 *
 * So the value is:
 *
 * - **cryptographically random** — 32 bytes from the OS, not a timestamp or a
 *   uuid, because a guessable state is no state at all;
 * - **short-lived** — ten minutes, long enough to read a consent screen;
 * - **single-use** — consumed by a conditional UPDATE, so a replay loses the
 *   race rather than being detected after the fact;
 * - **bound** — to the user, the organization, and the destination, none of
 *   which travel through Google and none of which can therefore be tampered
 *   with in transit.
 *
 * Only the SHA-256 hash reaches the database. Read access to `oauth_states`
 * must not be enough to forge a callback, for the same reason a password hash
 * is stored rather than a password.
 */

const STATE_BYTES = 32;

export interface IssuedState {
  /** Send this to the provider. Never persisted, never logged. */
  value: string;
  record: OAuthState;
}

export function generateStateValue(): string {
  return randomBytes(STATE_BYTES).toString("base64url");
}

export function hashState(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export interface IssueStateInput {
  dataSource: LiaDataSource;
  provider: Platform;
  organizationId: string;
  userId: string;
  redirectPath: string;
  reauthorization: boolean;
}

export class OAuthStateError extends Error {
  readonly reason:
    | "missing"
    | "invalid"
    | "expired_or_used"
    | "provider_mismatch"
    | "user_mismatch"
    | "organization_mismatch"
    | "redirect_not_allowed";

  constructor(reason: OAuthStateError["reason"], message: string) {
    super(message);
    this.name = "OAuthStateError";
    this.reason = reason;
  }
}

/** Copy for each rejection. Actionable, and never hinting at what nearly worked. */
export const OAUTH_STATE_MESSAGES: Record<OAuthStateError["reason"], string> = {
  missing: "That authorization link was incomplete. Start the connection again.",
  invalid: "That authorization link was not valid. Start the connection again.",
  expired_or_used:
    "That authorization link has expired or was already used. Start the connection again.",
  provider_mismatch:
    "That authorization link was for a different service. Start the connection again.",
  user_mismatch:
    "That authorization was started by a different person. Start the connection again from your own account.",
  organization_mismatch:
    "That authorization was started for a different organization. Switch organizations and start again.",
  redirect_not_allowed: "That return destination is not permitted.",
};

/**
 * Begin a handshake.
 *
 * The redirect path is validated against a closed list before it is written,
 * not when it is used. Storing an unvalidated destination would mean the
 * database itself held an open redirect waiting for a callback to honour it.
 */
export async function issueState(input: IssueStateInput): Promise<IssuedState> {
  if (!isAllowedRedirectPath(input.redirectPath)) {
    throw new OAuthStateError(
      "redirect_not_allowed",
      OAUTH_STATE_MESSAGES.redirect_not_allowed,
    );
  }

  // Opportunistic cleanup. Expired rows are a growing list of who started
  // connecting what and when, which is worth not keeping. Doing it here avoids
  // needing a scheduler for a table that only grows when someone clicks
  // Connect. A failure must not block the connection the user actually asked
  // for, so it is swallowed.
  await input.dataSource.oauthStates.purgeExpired().catch(() => 0);

  const value = generateStateValue();
  const expiresAt = new Date(
    Date.now() + OAUTH_STATE_TTL_MINUTES * 60 * 1000,
  ).toISOString();

  const record = await input.dataSource.oauthStates.create({
    provider: input.provider,
    stateHash: hashState(value),
    organizationId: input.organizationId,
    userId: input.userId,
    redirectPath: input.redirectPath,
    reauthorization: input.reauthorization,
    expiresAt,
  });

  return { value, record };
}

export interface ConsumeStateInput {
  dataSource: LiaDataSource;
  /** Exactly what the provider sent back, unmodified. */
  state: string | null | undefined;
  expectedProvider: Platform;
  /** The user this request is authenticated as, resolved from the session. */
  currentUserId: string;
  /** The organization active for this request. */
  currentOrganizationId: string;
}

/**
 * Validate and spend a handshake.
 *
 * Every check that could fail is listed explicitly rather than folded into one
 * boolean, because each one has a different remediation and the user needs to be
 * told which. The order matters: consumption happens *before* the identity
 * comparisons, so a state presented with the wrong user is still burned. A
 * failed attempt that left the state usable would be a free retry for whoever
 * is guessing.
 */
export async function consumeState(input: ConsumeStateInput): Promise<OAuthState> {
  if (!input.state) {
    throw new OAuthStateError("missing", OAUTH_STATE_MESSAGES.missing);
  }

  // Base64url of 32 bytes is 43 characters. Anything else was not issued here,
  // and rejecting it early keeps malformed input away from the database.
  if (!/^[A-Za-z0-9_-]{20,120}$/.test(input.state)) {
    throw new OAuthStateError("invalid", OAUTH_STATE_MESSAGES.invalid);
  }

  const record = await input.dataSource.oauthStates.consume(hashState(input.state));

  // Unknown, already consumed, and expired collapse into one answer. The
  // repository cannot distinguish them either — the conditional UPDATE matches
  // or it does not — and distinguishing them would grade an attacker's guesses.
  if (!record) {
    throw new OAuthStateError("expired_or_used", OAUTH_STATE_MESSAGES.expired_or_used);
  }

  if (record.provider !== input.expectedProvider) {
    throw new OAuthStateError(
      "provider_mismatch",
      OAUTH_STATE_MESSAGES.provider_mismatch,
    );
  }

  if (!idsMatch(record.userId, input.currentUserId)) {
    throw new OAuthStateError("user_mismatch", OAUTH_STATE_MESSAGES.user_mismatch);
  }

  if (!idsMatch(record.organizationId, input.currentOrganizationId)) {
    throw new OAuthStateError(
      "organization_mismatch",
      OAUTH_STATE_MESSAGES.organization_mismatch,
    );
  }

  // Re-checked on the way out as well as on the way in. The row could have been
  // written before the allow-list was tightened, and honouring a destination
  // that is no longer permitted is exactly the failure the list prevents.
  if (!isAllowedRedirectPath(record.redirectPath)) {
    throw new OAuthStateError(
      "redirect_not_allowed",
      OAUTH_STATE_MESSAGES.redirect_not_allowed,
    );
  }

  return record;
}

function idsMatch(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}
