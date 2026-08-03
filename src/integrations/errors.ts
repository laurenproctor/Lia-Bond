import type { ConnectionHealthStatus } from "@/domain";

/**
 * Provider failures, normalised.
 *
 * Every connector translates whatever its API returned into one of these codes
 * before the error leaves the integration layer. Nothing above this boundary
 * ever branches on an HTTP status or a Google error string, which is what keeps
 * "the token was revoked" from being handled in five places with five different
 * remediations.
 *
 * The codes are chosen around **what the user has to do next**, not around what
 * the provider said. `quota_exceeded` and `authorization_revoked` are both
 * "this request failed", but only one of them is fixed by clicking Reauthorize.
 */
export type IntegrationErrorCode =
  /** The refresh token is gone: revoked in the Google account, or expired out. */
  | "authorization_revoked"
  /** Access token is stale and could not be refreshed automatically. */
  | "credentials_expired"
  /** Authenticated, but the granted scopes do not cover the request. */
  | "insufficient_scope"
  /** The provider rate-limited or quota-limited us. Transient, retryable. */
  | "quota_exceeded"
  /** 5xx, timeout, network failure. Transient, retryable. */
  | "provider_unavailable"
  /** The account or location exists but is not available to this credential. */
  | "resource_unavailable"
  /** We sent something the provider rejected — a Lia bug, not a user problem. */
  | "invalid_request"
  /** The provider's response did not match the schema we validate against. */
  | "unexpected_response"
  /** Anything we could not classify. */
  | "unknown";

/**
 * A provider failure with a message that is safe to show a person.
 *
 * `message` is Lia's own wording. The provider's text is deliberately not
 * carried here: Google's errors quote request URLs and occasionally echo
 * parameters, and a rendered page is the wrong place for either.
 */
export class IntegrationError extends Error {
  readonly code: IntegrationErrorCode;
  /** True when retrying the same request later could plausibly succeed. */
  readonly retryable: boolean;
  /** Provider-side status, kept for server logs and health records only. */
  readonly providerStatus: number | null;
  /** Short provider reason token, e.g. "invalid_grant". Never free text. */
  readonly providerReason: string | null;

  constructor(
    code: IntegrationErrorCode,
    message: string,
    options: {
      retryable?: boolean;
      providerStatus?: number | null;
      providerReason?: string | null;
      cause?: unknown;
    } = {},
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "IntegrationError";
    this.code = code;
    this.retryable = options.retryable ?? RETRYABLE_CODES.includes(code);
    this.providerStatus = options.providerStatus ?? null;
    this.providerReason = options.providerReason ?? null;
  }
}

const RETRYABLE_CODES: IntegrationErrorCode[] = [
  "quota_exceeded",
  "provider_unavailable",
];

/** Remediation copy, written once so every surface says the same thing. */
export const INTEGRATION_ERROR_MESSAGES: Record<IntegrationErrorCode, string> = {
  authorization_revoked:
    "Google access was revoked. Reauthorize to reconnect this account.",
  credentials_expired:
    "Google credentials have expired. Reauthorize to reconnect this account.",
  insufficient_scope:
    "This connection is missing a Google permission Lia needs. Reauthorize and accept every requested permission.",
  quota_exceeded:
    "Google is rate-limiting requests from Lia right now. Try again in a few minutes.",
  provider_unavailable:
    "Google did not respond. This is usually temporary — try again shortly.",
  resource_unavailable:
    "That Google account or location is no longer available to this connection.",
  invalid_request:
    "Lia sent a request Google rejected. Let your administrator know if this keeps happening.",
  unexpected_response:
    "Google returned something Lia did not understand. Let your administrator know if this keeps happening.",
  unknown: "Something went wrong talking to Google. Try again shortly.",
};

export function integrationError(
  code: IntegrationErrorCode,
  options: {
    message?: string;
    providerStatus?: number | null;
    providerReason?: string | null;
    cause?: unknown;
  } = {},
): IntegrationError {
  return new IntegrationError(
    code,
    options.message ?? INTEGRATION_ERROR_MESSAGES[code],
    options,
  );
}

/**
 * How a failure should be recorded as connection health.
 *
 * Kept next to the codes so the mapping cannot drift: adding an error code
 * without deciding what it means for health becomes a type error.
 */
const HEALTH_BY_CODE: Record<IntegrationErrorCode, ConnectionHealthStatus> = {
  authorization_revoked: "authorization_required",
  credentials_expired: "authorization_required",
  insufficient_scope: "insufficient_permissions",
  quota_exceeded: "quota_limited",
  provider_unavailable: "provider_unavailable",
  resource_unavailable: "unknown_error",
  invalid_request: "unknown_error",
  unexpected_response: "unknown_error",
  unknown: "unknown_error",
};

export function healthStatusFor(error: unknown): ConnectionHealthStatus {
  if (error instanceof IntegrationError) return HEALTH_BY_CODE[error.code];
  return "unknown_error";
}

/**
 * A message safe to render, for anything thrown by the integration layer.
 *
 * Unknown errors collapse to a generic sentence rather than surfacing a stack
 * or a driver message.
 */
export function toIntegrationMessage(error: unknown): string {
  if (error instanceof IntegrationError) return error.message;
  return INTEGRATION_ERROR_MESSAGES.unknown;
}

/** True when the connection needs a person to re-consent before it works again. */
export function requiresReauthorization(error: unknown): boolean {
  return (
    error instanceof IntegrationError &&
    (error.code === "authorization_revoked" ||
      error.code === "credentials_expired" ||
      error.code === "insufficient_scope")
  );
}
