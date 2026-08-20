import { z } from "zod";
import {
  languageTagSchema,
  slugSchema,
  timezoneSchema,
} from "@/domain/primitives";

/**
 * What the organization details form accepts.
 *
 * Lives outside `@/app/actions/organization-settings` because that file is
 * `"use server"`, and Next allows such a file to export *async functions only*
 * — a schema object among its exports is refused at module evaluation, which
 * takes down every action in the module rather than just the offending export.
 * The same split `@/lib/site/contact-message` uses, for the same reason.
 *
 * Validation reuses the schemas the entity already declares; the form invents
 * no rules of its own. The slug is the one field with teeth: globally unique,
 * so the repository maps a collision to a `slug` field error the action passes
 * straight through.
 */
export const organizationDetailsSchema = z.object({
  name: z.string().trim().min(1, "Enter the organization's name.").max(160),
  slug: slugSchema,
  industry: z.string().trim().min(1, "Enter an industry.").max(120),
  websiteUrl: z
    .union([z.url("Enter a full URL, like https://example.com."), z.literal("")])
    .transform((value) => (value === "" ? null : value)),
  defaultTimezone: timezoneSchema,
  defaultLanguage: languageTagSchema,
});
