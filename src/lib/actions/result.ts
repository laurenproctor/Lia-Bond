import { z } from "zod";
import { DataError, toUserMessage } from "@/lib/data/errors";
import { ConfigurationError } from "@/lib/env";
import { IntegrationError, toIntegrationMessage } from "@/integrations/errors";

/**
 * The one return shape every server action uses.
 *
 * Actions never throw at the UI. A component gets back a discriminated union it
 * can render: success with data, or failure with a sentence a person can act on
 * plus optional per-field messages. Stack traces stay on the server.
 */

export type ActionResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; fieldErrors?: Record<string, string> };

export function ok<T>(data: T): ActionResult<T> {
  return { ok: true, data };
}

export function failure<T>(
  error: string,
  fieldErrors?: Record<string, string>,
): ActionResult<T> {
  return fieldErrors ? { ok: false, error, fieldErrors } : { ok: false, error };
}

/** Zod issues, flattened into the field map the UI expects. */
export function fieldErrorsFrom(error: z.ZodError): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const issue of error.issues) {
    const path = issue.path.join(".") || "form";
    fields[path] ??= issue.message;
  }
  return fields;
}

/**
 * Run an action body and convert anything that escapes into a typed failure.
 *
 * Unexpected errors are logged server-side and reported to the user with a
 * generic sentence — an unhandled message could carry a table name or a query.
 */
export async function runAction<T>(
  label: string,
  body: () => Promise<T>,
): Promise<ActionResult<T>> {
  try {
    return ok(await body());
  } catch (error) {
    if (error instanceof z.ZodError) {
      return failure("Check the highlighted fields.", fieldErrorsFrom(error));
    }
    if (error instanceof DataError) {
      return failure(
        toUserMessage(error),
        Object.keys(error.fieldErrors).length > 0 ? error.fieldErrors : undefined,
      );
    }

    if (error instanceof ConfigurationError) {
      // An operator problem, not a user one. "Try again shortly" would be a lie
      // — nothing changes until an environment variable is set — so it gets its
      // own wording, and the missing names (never values) go to the log.
      console.error(`[action:${label}] not configured:`, error.missing.join(", "));
      return failure(
        "That integration is not configured on this server. Ask your administrator to finish setup.",
      );
    }

    if (error instanceof IntegrationError) {
      // Lia's own wording, from a normalised code. The provider's message is
      // deliberately not surfaced: it quotes request URLs and parameters.
      console.error(`[action:${label}] provider:`, error.code);
      return failure(toIntegrationMessage(error));
    }

    console.error(`[action:${label}]`, error);
    return failure(toUserMessage(error));
  }
}
