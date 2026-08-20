/**
 * The countries News monitoring can actually be pointed at.
 *
 * Two facts per country, and they are independent:
 *
 * - **The market.** GNews filters by a `country` parameter, and it accepts a
 *   fixed list of 30 ISO 3166-1 alpha-2 codes. Offering a country outside that
 *   list would be a promise the provider cannot keep — the parameter would be
 *   rejected or silently ignored, and the customer would be told Lia is
 *   watching a market it is not. So this list *is* the picker.
 * - **Postal lookup.** Whether a postal code in that country resolves to a
 *   city and region through `postal-lookup.ts`. A country can be a valid
 *   market with no lookup behind it (Ireland, Hong Kong, Singapore) — that is
 *   a convenience gap, not a monitoring gap, and the form falls back to typing
 *   the city and region by hand.
 *
 * Not a client/server split: the picker needs the labels in the browser and
 * the action needs the support flag on the server, so this module imports
 * nothing and is safe in both.
 */

export interface MonitoringCountry {
  /** ISO 3166-1 alpha-2, lowercase — the casing `sourceCountry` stores. */
  code: string;
  label: string;
  /**
   * True when `postal-lookup.ts` can resolve a postal code here.
   *
   * Drives whether the form offers auto-fill or asks for the city and region
   * directly. Never drives whether the country may be selected.
   */
  postalLookup: boolean;
  /**
   * What that country calls the thing, for the field label.
   *
   * "ZIP code" is American, and asking a London operator for their ZIP code is
   * the kind of detail that makes a product feel like it was built for
   * somebody else.
   */
  postalLabel: string;
}

/**
 * GNews's supported `country` values, alphabetically by label.
 *
 * `postalLookup` follows Zippopotam's published country coverage. Two of them
 * — `gb` and `ca` — resolve only the outward code and the forward sortation
 * area respectively, so they return a district rather than a precise town.
 * That is still the right city for a local news query, which is what the
 * value is for, so they are treated as supported.
 */
export const MONITORING_COUNTRIES: readonly MonitoringCountry[] = [
  { code: "au", label: "Australia", postalLookup: true, postalLabel: "Postcode" },
  { code: "br", label: "Brazil", postalLookup: true, postalLabel: "CEP" },
  { code: "ca", label: "Canada", postalLookup: true, postalLabel: "Postal code" },
  { code: "cn", label: "China", postalLookup: false, postalLabel: "Postal code" },
  { code: "eg", label: "Egypt", postalLookup: false, postalLabel: "Postal code" },
  { code: "fr", label: "France", postalLookup: true, postalLabel: "Code postal" },
  { code: "de", label: "Germany", postalLookup: true, postalLabel: "Postleitzahl" },
  { code: "gr", label: "Greece", postalLookup: false, postalLabel: "Postal code" },
  { code: "hk", label: "Hong Kong", postalLookup: false, postalLabel: "Postal code" },
  { code: "in", label: "India", postalLookup: true, postalLabel: "PIN code" },
  { code: "ie", label: "Ireland", postalLookup: false, postalLabel: "Eircode" },
  { code: "il", label: "Israel", postalLookup: false, postalLabel: "Postal code" },
  { code: "it", label: "Italy", postalLookup: true, postalLabel: "CAP" },
  { code: "jp", label: "Japan", postalLookup: true, postalLabel: "Postal code" },
  { code: "nl", label: "Netherlands", postalLookup: true, postalLabel: "Postcode" },
  { code: "no", label: "Norway", postalLookup: true, postalLabel: "Postnummer" },
  { code: "pk", label: "Pakistan", postalLookup: true, postalLabel: "Postal code" },
  { code: "pe", label: "Peru", postalLookup: false, postalLabel: "Postal code" },
  { code: "ph", label: "Philippines", postalLookup: true, postalLabel: "ZIP code" },
  { code: "pt", label: "Portugal", postalLookup: true, postalLabel: "Código postal" },
  { code: "ro", label: "Romania", postalLookup: true, postalLabel: "Postal code" },
  { code: "ru", label: "Russia", postalLookup: true, postalLabel: "Postal code" },
  { code: "sg", label: "Singapore", postalLookup: false, postalLabel: "Postal code" },
  { code: "es", label: "Spain", postalLookup: true, postalLabel: "Código postal" },
  { code: "se", label: "Sweden", postalLookup: true, postalLabel: "Postnummer" },
  { code: "ch", label: "Switzerland", postalLookup: true, postalLabel: "Postleitzahl" },
  { code: "tw", label: "Taiwan", postalLookup: false, postalLabel: "Postal code" },
  { code: "ua", label: "Ukraine", postalLookup: false, postalLabel: "Postal code" },
  { code: "gb", label: "United Kingdom", postalLookup: true, postalLabel: "Postcode" },
  { code: "us", label: "United States", postalLookup: true, postalLabel: "ZIP code" },
] as const;

const BY_CODE = new Map(
  MONITORING_COUNTRIES.map((country) => [country.code, country] as const),
);

/** The country for a stored `sourceCountry`, or null when it is unset or unknown. */
export function findMonitoringCountry(
  code: string | null | undefined,
): MonitoringCountry | null {
  if (!code) return null;
  return BY_CODE.get(code.trim().toLowerCase()) ?? null;
}

/** True when a postal code in this country resolves to a city and region. */
export function supportsPostalLookup(code: string | null | undefined): boolean {
  return findMonitoringCountry(code)?.postalLookup ?? false;
}

/**
 * What to call the postal field for a country.
 *
 * Falls back to the neutral term rather than to "ZIP code", so an unset
 * country does not default to American vocabulary.
 */
export function postalLabelFor(code: string | null | undefined): string {
  return findMonitoringCountry(code)?.postalLabel ?? "Postal code";
}
