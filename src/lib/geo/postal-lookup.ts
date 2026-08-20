import "server-only";

import { z } from "zod";
import { supportsPostalLookup } from "@/lib/geo/countries";

/**
 * Postal code → city and region.
 *
 * The only file in the application that talks to a postal-code provider, on
 * the same rule as `src/news/gnews/client.ts`: one HTTP boundary, `fetch`
 * injected rather than reached for, and no provider text ever reaching a
 * thrown error. Stubbing one function is what makes every caller testable.
 *
 * The provider is Zippopotam (`api.zippopotam.us`) — free, unauthenticated,
 * and therefore adding no key to the environment and no cost to a poll. What
 * it is *not* is a service with an SLA, which is why nothing here is load
 * bearing: a lookup that fails returns a typed error, the form says the city
 * and region could not be filled in, and the person types them. A monitoring
 * query is never blocked on this provider being up.
 *
 * Precision varies by country and the caller must not assume a town. The UK
 * resolves an outward code ("EC1A") to its district and Canada a forward
 * sortation area, so both return an area rather than an address. That is the
 * right granularity for "what local coverage concerns this restaurant",
 * which is the only thing the value is used for.
 */

/** Codes a caller can branch on. Never the provider's own words. */
export type PostalLookupErrorCode =
  | "unsupported_country"
  | "invalid_postal_code"
  | "not_found"
  | "rate_limited"
  | "provider_error";

export class PostalLookupError extends Error {
  constructor(
    readonly code: PostalLookupErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "PostalLookupError";
  }
}

/** What Lia says for each code. Written for the person filling in the form. */
export const POSTAL_LOOKUP_MESSAGES: Record<PostalLookupErrorCode, string> = {
  unsupported_country:
    "Lia cannot look up postal codes in this country yet. Enter the city and region yourself.",
  invalid_postal_code:
    "That does not look like a postal code. Check it, or enter the city and region yourself.",
  not_found:
    "No place matched that postal code. Check it, or enter the city and region yourself.",
  rate_limited:
    "The postal code service is busy. Try again shortly, or enter the city and region yourself.",
  provider_error:
    "Lia could not reach the postal code service. Enter the city and region yourself.",
};

export interface PostalPlace {
  /** Echoed back from the provider, normalised — not the caller's input. */
  postalCode: string;
  city: string;
  /**
   * State, province, or region, written the way that country writes it.
   *
   * See `ABBREVIATION_COUNTRIES`.
   */
  region: string;
}

const BASE_URL = "https://api.zippopotam.us";

/**
 * Where the two-letter region abbreviation is how people actually write it.
 *
 * The provider returns an abbreviation for nearly every country, and most of
 * them are not used by anybody: Berlin comes back as "BE", England as "ENG",
 * Bayern as "BY". Preferring the abbreviation everywhere would fill a "state or
 * region" field with codes a German or British operator would not recognise as
 * their own address. In the US, Canada, and Australia the opposite is true —
 * "CA", "ON", and "NSW" are the normal written form, and spelling out
 * "California" would look like a form that does not know the country.
 */
const ABBREVIATION_COUNTRIES = new Set(["us", "ca", "au"]);

/**
 * A short budget on purpose. This runs while somebody waits with a cursor in
 * the next field, and a slow answer is worse than an honest "type it
 * yourself" — the fields are editable either way.
 */
const TIMEOUT_MS = 5_000;

/**
 * The shape the provider returns, narrowed to what is read.
 *
 * `places` is optional because a 200 with no places has been observed for
 * some partial-coverage countries; it is treated as a miss rather than a
 * crash. Unknown keys are ignored — this is a third-party payload and
 * tightening it would turn an added field into an outage.
 */
const responseSchema = z.object({
  "post code": z.string().optional(),
  places: z
    .array(
      z.object({
        "place name": z.string().optional(),
        state: z.string().optional(),
        "state abbreviation": z.string().optional(),
      }),
    )
    .optional(),
});

/**
 * What may appear in the provider's URL path.
 *
 * The postal code is interpolated into a path segment, so it is validated
 * against an allowlist rather than merely encoded: letters, digits, spaces,
 * and hyphens cover every format in the supported countries, and anything
 * else is rejected before a request is built. Encoding alone would stop path
 * traversal but would still forward junk and spend a request finding out.
 */
const POSTAL_CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9 -]{1,11}$/;

/**
 * Normalise what somebody typed into what the provider expects.
 *
 * Uppercased and internally single-spaced. The UK is the case that forces
 * this: "ec1a 1bb" and "EC1A1BB" are the same postcode, and only one of the
 * two spellings resolves.
 */
export function normalisePostalCode(input: string): string {
  return input.trim().replace(/\s+/g, " ").toUpperCase();
}

/**
 * The segment sent to the provider.
 *
 * The UK and Canada resolve an outward code / forward sortation area only, so
 * the local part is dropped before the request. Sending the full postcode
 * returns nothing at all, which would surface as "no place matched" for a
 * perfectly valid address.
 */
function providerSegment(countryCode: string, postalCode: string): string {
  if (countryCode === "gb" || countryCode === "ca") {
    const outward = postalCode.includes(" ")
      ? postalCode.slice(0, postalCode.indexOf(" "))
      : postalCode.slice(0, countryCode === "ca" ? 3 : postalCode.length);
    return outward;
  }
  return postalCode;
}

export interface PostalLookupInput {
  /** ISO 3166-1 alpha-2. Case-insensitive. */
  countryCode: string;
  postalCode: string;
}

/**
 * Resolve one postal code.
 *
 * Throws `PostalLookupError` for every failure, including "not found" —
 * callers show `POSTAL_LOOKUP_MESSAGES[code]` and leave the fields for the
 * person to fill in. `fetchImpl` is a required parameter rather than a
 * defaulted one so this file never has to guess whether it is under a test
 * stub, matching `searchGNews`.
 */
export async function lookupPostalCode(
  input: PostalLookupInput,
  fetchImpl: typeof fetch,
): Promise<PostalPlace> {
  const countryCode = input.countryCode.trim().toLowerCase();
  const postalCode = normalisePostalCode(input.postalCode);

  if (!supportsPostalLookup(countryCode)) {
    throw new PostalLookupError(
      "unsupported_country",
      POSTAL_LOOKUP_MESSAGES.unsupported_country,
    );
  }
  if (!POSTAL_CODE_PATTERN.test(postalCode)) {
    throw new PostalLookupError(
      "invalid_postal_code",
      POSTAL_LOOKUP_MESSAGES.invalid_postal_code,
    );
  }

  const segment = encodeURIComponent(providerSegment(countryCode, postalCode));
  const url = `${BASE_URL}/${countryCode}/${segment}`;

  let response: Response;
  try {
    response = await fetchImpl(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      // A postal code's city does not change. Letting the platform cache it
      // means a form that retries, or two people onboarding from the same
      // office, cost the provider one request rather than several.
      cache: "force-cache",
    });
  } catch {
    // Covers the timeout and every transport failure alike. The distinction
    // does not change what the person does next, and the underlying message
    // is a Node internal string, not something to show anybody.
    throw new PostalLookupError("provider_error", POSTAL_LOOKUP_MESSAGES.provider_error);
  }

  // 404 is this provider's "no such postal code" — an answer, not a fault.
  if (response.status === 404) {
    throw new PostalLookupError("not_found", POSTAL_LOOKUP_MESSAGES.not_found);
  }
  if (response.status === 429) {
    throw new PostalLookupError("rate_limited", POSTAL_LOOKUP_MESSAGES.rate_limited);
  }
  if (!response.ok) {
    throw new PostalLookupError("provider_error", POSTAL_LOOKUP_MESSAGES.provider_error);
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new PostalLookupError("provider_error", POSTAL_LOOKUP_MESSAGES.provider_error);
  }

  const parsed = responseSchema.safeParse(payload);
  if (!parsed.success) {
    throw new PostalLookupError("provider_error", POSTAL_LOOKUP_MESSAGES.provider_error);
  }

  const place = parsed.data.places?.[0];
  const city = place?.["place name"]?.trim();
  if (!place || !city) {
    throw new PostalLookupError("not_found", POSTAL_LOOKUP_MESSAGES.not_found);
  }

  // Whichever form this country writes, then the other as a fallback, and an
  // empty string when the provider gave neither — never the country name or
  // any other stand-in the caller might mistake for a real answer.
  const abbreviation = place["state abbreviation"]?.trim() ?? "";
  const full = place.state?.trim() ?? "";
  const region = ABBREVIATION_COUNTRIES.has(countryCode)
    ? abbreviation || full
    : full || abbreviation;

  return {
    postalCode: parsed.data["post code"]?.trim() || postalCode,
    city,
    region,
  };
}
