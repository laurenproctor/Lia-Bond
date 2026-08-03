/**
 * Shared shapes for the location-mapping screen.
 *
 * Their own file so the form and the row can both import them without one
 * depending on the other — the row does not need the form, and a circular
 * import between two client components is the kind of thing that only fails at
 * build time.
 */

/** The subset of a Lia location the mapping controls need. */
export interface LiaLocationOption {
  id: string;
  name: string;
  city: string;
  region: string;
  status: string;
}

/**
 * What the user has chosen for one Google location.
 *
 * `none` is the default and means "skip", not "undecided-but-probably-yes".
 * Modelling it as a distinct variant rather than a nullable location id is what
 * keeps "create a location for this" from being expressed as an absence.
 */
export type RowChoice =
  | { kind: "none" }
  | { kind: "existing"; locationId: string }
  | { kind: "create"; name: string };
