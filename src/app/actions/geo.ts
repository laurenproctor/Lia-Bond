"use server";

import { z } from "zod";
import { authorize } from "@/lib/actions/guard";
import { runAction, type ActionResult } from "@/lib/actions/result";
import { DataError } from "@/lib/data/errors";
import {
  lookupPostalCode,
  PostalLookupError,
  type PostalPlace,
} from "@/lib/geo/postal-lookup";

/**
 * Postal code → city and region, for the monitoring forms.
 *
 * Thin, like every other action file: authorise, call one service, translate
 * its typed error into a sentence. It writes nothing and revalidates nothing —
 * the answer is put into form state, and only saved if the person goes on to
 * save the query.
 *
 * `monitoring.manage_queries` rather than a looser check, because that is the
 * permission held by everybody who can reach either form that calls this — the
 * onboarding News configurator (`saveOnboardingNewsMonitoringAction` authorises
 * the same way) and the News & Media query editor. Requiring it also stops the
 * action being used as an open proxy to a third-party service by anybody who
 * finds the endpoint.
 */

const lookupSchema = z.object({
  countryCode: z
    .string()
    .trim()
    .length(2)
    .regex(/^[A-Za-z]{2}$/, "Use a two-letter country code."),
  postalCode: z.string().trim().min(2).max(12),
});

export async function lookupPostalCodeAction(
  input: unknown,
): Promise<ActionResult<PostalPlace>> {
  return runAction("geo.postal_lookup", async () => {
    const parsed = lookupSchema.parse(input);
    await authorize("monitoring.manage_queries");

    try {
      // The composition root for this boundary: the one place a real `fetch`
      // is chosen, mirroring how `GNewsMonitor` supplies one to `searchGNews`.
      return await lookupPostalCode(parsed, fetch);
    } catch (error) {
      if (error instanceof PostalLookupError) {
        // Already Lia's own wording — `PostalLookupError` never carries
        // provider text. Re-thrown as a `DataError` so `runAction` reports it
        // verbatim instead of collapsing it to the generic sentence.
        //
        // `not_found` and `invalid_postal_code` are the person's input to fix,
        // so they arrive as a field error against the postal code; the rest
        // are the service's problem and get no field highlight, because there
        // is nothing wrong with what was typed.
        const isInput =
          error.code === "not_found" || error.code === "invalid_postal_code";
        throw new DataError(
          isInput ? "invalid_input" : "unavailable",
          error.message,
          isInput ? { postalCode: error.message } : {},
        );
      }
      throw error;
    }
  });
}
