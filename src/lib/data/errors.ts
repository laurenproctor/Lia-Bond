/**
 * Data-layer failures.
 *
 * Typed so callers can branch on the reason, and so the UI can show a sentence
 * a person can act on. Stack traces and driver messages never reach a rendered
 * page — `toUserMessage` is the only thing a component displays.
 */

export type DataErrorCode =
  | "not_authenticated"
  | "not_a_member"
  | "not_found"
  | "forbidden"
  | "invalid_input"
  | "conflict"
  | "unavailable";

export class DataError extends Error {
  readonly code: DataErrorCode;
  /** Field-level messages, keyed by path, when the failure was validation. */
  readonly fieldErrors: Record<string, string>;

  constructor(
    code: DataErrorCode,
    message: string,
    fieldErrors: Record<string, string> = {},
  ) {
    super(message);
    this.name = "DataError";
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

export function notFound(entity: string): DataError {
  return new DataError("not_found", `${entity} was not found.`);
}

export function forbidden(message: string): DataError {
  return new DataError("forbidden", message);
}

export function invalidInput(
  message: string,
  fieldErrors: Record<string, string> = {},
): DataError {
  return new DataError("invalid_input", message, fieldErrors);
}

export function conflict(message: string): DataError {
  return new DataError("conflict", message);
}

/**
 * A poll is already open for this monitoring query.
 *
 * Raised by the partial unique index, not by a read-then-write check. Its own
 * type rather than a generic conflict, for the same reason
 * `SyncRunInProgressError` is: the caller has to be able to tell "somebody
 * else is already doing this" — which is fine and needs no remediation — from
 * every other reason a run could fail to open.
 */
export class PollRunInProgressError extends Error {
  readonly monitoringQueryId: string;

  constructor(monitoringQueryId: string) {
    super(`A poll is already running for monitoring query ${monitoringQueryId}.`);
    this.name = "PollRunInProgressError";
    this.monitoringQueryId = monitoringQueryId;
  }
}

const FALLBACK_MESSAGES: Record<DataErrorCode, string> = {
  not_authenticated: "Sign in to continue.",
  not_a_member: "You don't have access to this organization.",
  not_found: "We couldn't find that record.",
  forbidden: "You don't have permission to do that.",
  invalid_input: "Something in that request wasn't valid.",
  conflict: "That change conflicts with the current state of the record.",
  unavailable: "That service is temporarily unavailable. Try again shortly.",
};

/**
 * A message safe to render.
 *
 * Known failures keep their specific wording. Anything else — a driver error, a
 * bug — collapses to a generic sentence, because an unexpected error message
 * can carry a table name, a query, or worse.
 */
export function toUserMessage(error: unknown): string {
  if (error instanceof DataError) {
    return error.message || FALLBACK_MESSAGES[error.code];
  }
  return "Something went wrong. Try again, and let your administrator know if it keeps happening.";
}
