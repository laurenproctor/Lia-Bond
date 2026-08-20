import { z } from "zod";
import { locationStatusSchema } from "@/domain/enums";
import {
  countryCodeSchema,
  jsonObjectSchema,
  organizationOwnedSchema,
  slugSchema,
  timestampsSchema,
  timezoneSchema,
  uuidSchema,
} from "@/domain/primitives";

/**
 * A physical restaurant.
 *
 * `slug` is unique per organization rather than globally — two groups may both
 * run a "soho" location.
 */
export const locationSchema = z
  .object({
    name: z.string().min(1).max(160),
    slug: slugSchema,
    addressLine1: z.string().min(1).max(200),
    addressLine2: z.string().max(200).nullable(),
    city: z.string().min(1).max(120),
    region: z.string().min(1).max(120),
    postalCode: z.string().min(1).max(32),
    countryCode: countryCodeSchema,
    timezone: timezoneSchema,
    status: locationStatusSchema,
    /** Must reference a user with an active membership in the same organization. */
    managerUserId: uuidSchema.nullable(),
  })
  .extend(organizationOwnedSchema.shape)
  .extend(timestampsSchema.shape);

export type Location = z.infer<typeof locationSchema>;

/**
 * Input accepted by `locations.create`.
 *
 * `slug` is optional because a location created from a platform integration has
 * no human to type one; the repository derives it from the name and
 * de-duplicates within the organization. Status defaults to `setup` — a
 * restaurant that arrived through a Google listing has not been onboarded in
 * Lia yet, and claiming otherwise would flatter the numbers on every roll-up.
 */
export const createLocationInputSchema = z.object({
  name: z.string().min(1).max(160),
  slug: slugSchema.optional(),
  addressLine1: z.string().min(1).max(200),
  addressLine2: z.string().max(200).nullable().default(null),
  city: z.string().min(1).max(120),
  region: z.string().min(1).max(120),
  postalCode: z.string().min(1).max(32),
  countryCode: countryCodeSchema,
  timezone: timezoneSchema,
  status: locationStatusSchema.default("setup"),
  managerUserId: uuidSchema.nullable().default(null),
});

export type CreateLocationInput = z.input<typeof createLocationInputSchema>;
export type ParsedCreateLocationInput = z.output<typeof createLocationInputSchema>;

/** Input accepted by `updateLocationManager`. */
export const updateLocationManagerInputSchema = z.object({
  locationId: uuidSchema,
  managerUserId: uuidSchema.nullable(),
});

export type UpdateLocationManagerInput = z.infer<
  typeof updateLocationManagerInputSchema
>;

/**
 * The address block, declared once.
 *
 * Extracted because three schemas below need exactly these seven fields and a
 * fourth (`createLocationInputSchema`, above) already spells them out. A second
 * hand-written copy is a second place for `postalCode`'s length to drift.
 */
const addressShape = {
  addressLine1: z.string().min(1).max(200),
  addressLine2: z.string().max(200).nullable().default(null),
  city: z.string().min(1).max(120),
  region: z.string().min(1).max(120),
  postalCode: z.string().min(1).max(32),
  countryCode: countryCodeSchema,
  timezone: timezoneSchema,
} as const;

/**
 * Input accepted by the manual creation action (`/locations/new`).
 *
 * Deliberately **not** `createLocationInputSchema`. That one carries a `status`
 * field because the repository is also the integration path's entry point; this
 * one has none, because a location somebody types in always starts `setup` and
 * a status the form could name is a status the form could get wrong. The action
 * writes `status: "setup"` itself.
 *
 * `slug` stays optional here for the same reason it is optional there: a person
 * filling in "Gramercy Tavern" should not have to invent a URL fragment, and
 * the repository derives and de-duplicates one within the organization.
 */
export const createManualLocationInputSchema = z.object({
  name: z.string().min(1).max(160),
  slug: slugSchema.optional(),
  ...addressShape,
  managerUserId: uuidSchema.nullable().default(null),
});

export type CreateManualLocationInput = z.input<
  typeof createManualLocationInputSchema
>;
export type ParsedCreateManualLocationInput = z.output<
  typeof createManualLocationInputSchema
>;

/**
 * Input accepted by `locations.update`.
 *
 * Every editable field is named explicitly, and this is **not** built with
 * `.partial()` on the create schema. Zod's `.partial()` makes a key optional
 * *without* stripping its `.default()`, so an absent key still parses to the
 * default and both adapters would write it — a rename would silently blank the
 * second address line. That exact defect shipped once already in
 * `updateMonitoringQueryInputSchema` and is recorded in `current-state.md`;
 * declaring the fields is what keeps `undefined` meaning "not mentioned".
 *
 * `status` is present here and absent from creation: retiring a restaurant is
 * an edit, never an act of creation. `managerUserId` is present because the
 * management screen edits it, but note that it also has its own narrower action
 * (`updateLocationManagerAction`) and its own audit event — the three-way split
 * in D204 is what keeps "who changed the address" answerable.
 */
export const updateLocationInputSchema = z.object({
  locationId: uuidSchema,
  name: z.string().min(1).max(160),
  slug: slugSchema,
  addressLine1: z.string().min(1).max(200),
  addressLine2: z.string().max(200).nullable(),
  city: z.string().min(1).max(120),
  region: z.string().min(1).max(120),
  postalCode: z.string().min(1).max(32),
  countryCode: countryCodeSchema,
  timezone: timezoneSchema,
  status: locationStatusSchema,
  managerUserId: uuidSchema.nullable(),
});

export type UpdateLocationInput = z.infer<typeof updateLocationInputSchema>;

/**
 * One external profile being mapped, as `create_and_map_location` expects it.
 *
 * These are not persisted before mapping: they are fetched live from the
 * provider on every render of the setup screen and written at save time, keyed
 * on `(platform_connection_id, external_profile_id)`. So the RPC creates the
 * row rather than referencing one, and this is the shape it creates it from.
 */
export const mappedProfileInputSchema = z.object({
  externalProfileId: z.string().min(1).max(200),
  externalProfileName: z.string().min(1).max(200),
  // Nullable to match `platformProfileSchema`, which allows a profile with no
  // owning provider account. Google nests locations under accounts and always
  // supplies one; a future connector need not.
  externalAccountId: z.string().max(200).nullable().default(null),
  profileUrl: z.url().nullable().default(null),
  verificationState: z.string().max(80).nullable().default(null),
  // `jsonObjectSchema`, not a fresh `z.record`: the profile row's own column is
  // typed that way, and a second definition would be a second thing to keep in
  // step with what Postgres will actually accept in a jsonb column.
  providerMetadata: jsonObjectSchema.default({}),
});

export type MappedProfileInput = z.input<typeof mappedProfileInputSchema>;

/**
 * Input accepted by `locations.createAndMapFromIntegration`.
 *
 * No `status`, no `managerUserId`, and no `organizationId` — none of the three
 * is a parameter of the underlying function either. The organization is derived
 * from the connection, and status and manager are written literally, so this
 * path is structurally incapable of producing an active or managed location.
 *
 * `profiles` is non-empty by construction, mirroring the `22023` the SQL raises
 * for an empty array. Creation is a side effect of binding here: a call that
 * binds nothing must not be expressible, let alone succeed.
 */
export const createAndMapLocationInputSchema = z.object({
  platformConnectionId: uuidSchema,
  profiles: z.array(mappedProfileInputSchema).min(1),
  name: z.string().min(1).max(160),
  ...addressShape,
});

export type CreateAndMapLocationInput = z.input<
  typeof createAndMapLocationInputSchema
>;
export type ParsedCreateAndMapLocationInput = z.output<
  typeof createAndMapLocationInputSchema
>;
