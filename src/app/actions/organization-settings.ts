"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Organization } from "@/domain";
import {
  languageTagSchema,
  slugSchema,
  timezoneSchema,
} from "@/domain/primitives";
import { authorize } from "@/lib/actions/guard";
import { runAction, type ActionResult } from "@/lib/actions/result";

/**
 * Owners and admins editing the organization's own details.
 *
 * A separate file from `organization.ts` on purpose: that action switches
 * between organizations, this one changes what an organization *is* — the
 * concerns share a noun and nothing else.
 *
 * Validation reuses the schemas the entity already declares; the form invents
 * no rules of its own. The slug is the one field with teeth: globally unique,
 * so the repository maps a collision to a `slug` field error this action just
 * passes through.
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

export async function updateOrganizationAction(
  input: unknown,
): Promise<ActionResult<Organization>> {
  return runAction("organization.update", async () => {
    const parsed = organizationDetailsSchema.parse(input);
    const context = await authorize("organization.update");

    const updated = await context.dataSource.organizations.update(
      context.scope,
      parsed,
    );

    revalidatePath("/settings");
    return updated;
  });
}
