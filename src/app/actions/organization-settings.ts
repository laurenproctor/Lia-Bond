"use server";

import { revalidatePath } from "next/cache";
import type { Organization } from "@/domain";
import { authorize } from "@/lib/actions/guard";
import { runAction, type ActionResult } from "@/lib/actions/result";
import { organizationDetailsSchema } from "@/lib/organization/details";

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
