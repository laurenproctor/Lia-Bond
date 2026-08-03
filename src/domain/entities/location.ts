import { z } from "zod";
import { locationStatusSchema } from "@/domain/enums";
import {
  countryCodeSchema,
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
