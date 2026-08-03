"use server";

import { cookies } from "next/headers";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction, type ActionResult } from "@/lib/actions/result";
import {
  ACTIVE_ORGANIZATION_COOKIE,
  verifyOrganizationAccess,
} from "@/lib/tenancy/organization-context";

const switchInputSchema = z.object({ organizationId: z.uuid() });

/**
 * Switch the active organization.
 *
 * The id is verified against the caller's memberships before it is written, so
 * the cookie can only ever name an organization they already belong to. Even if
 * it were forged, `getOrganizationContext` re-verifies on every read.
 */
export async function switchOrganizationAction(
  input: unknown,
): Promise<ActionResult<{ organizationId: string }>> {
  return runAction("organization.switch", async () => {
    const { organizationId } = switchInputSchema.parse(input);

    const verified = await verifyOrganizationAccess(organizationId);

    const store = await cookies();
    store.set(ACTIVE_ORGANIZATION_COOKIE, verified, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      path: "/",
      maxAge: 60 * 60 * 24 * 365,
    });

    revalidatePath("/", "layout");
    return { organizationId: verified };
  });
}
