"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { runAction, type ActionResult } from "@/lib/actions/result";
import { requireSession } from "@/lib/auth/session";
import { getDataSource } from "@/lib/data";
import {
  setActiveOrganizationCookie,
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
    await setActiveOrganizationCookie(verified);

    revalidatePath("/", "layout");
    return { organizationId: verified };
  });
}

const createInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Enter your company name.")
    .max(160),
  // Generated once per mounted form, so a double-click sends the same value
  // twice and the second call returns the first one's organization instead of
  // creating a second tenant. See `provision_organization`'s conflict arm.
  requestKey: z.uuid(),
});

/**
 * Create an organization from inside the product.
 *
 * Not wrapped in `authorize()`, and the distinction matters: `authorize`
 * resolves an organization scope and checks a permission *within* it, neither of
 * which applies here. Creating an organization is a property of holding an
 * account, not of any role in an organization somebody already belongs to — an
 * analyst who can do nothing at all in their current workspace may still create
 * one of their own and own it. `acceptInvitationAction` is unwrapped for the
 * same reason.
 *
 * Returns a path rather than redirecting. `redirect()` throws `NEXT_REDIRECT`,
 * which `runAction`'s catch would convert into a generic failure — the
 * navigation would silently never happen. The onboarding actions return
 * `nextPath` for exactly this reason.
 *
 * There is deliberately **no `recordAuditEvent` call** here. `organization.created`
 * is written inside `provision_organization` itself (and its demo twin), in the
 * same transaction as the organization: `insert` on `audit_events` is revoked
 * from `authenticated`, and `recordAuditEvent` needs an `OrganizationScope`
 * that does not exist until the organization does. Its absence is the design,
 * not an oversight.
 */
export async function createOrganizationAction(
  input: unknown,
): Promise<ActionResult<{ organizationId: string; nextPath: string }>> {
  return runAction("organization.create", async () => {
    const { name, requestKey } = createInputSchema.parse(input);
    const session = await requireSession();
    const dataSource = await getDataSource();

    const created = await dataSource.organizations.provision({
      userId: session.id,
      name,
      requestKey,
      source: "in_app",
    });

    // Selected immediately: the next screen is this organization's onboarding,
    // and it resolves the active organization from this cookie.
    await setActiveOrganizationCookie(created.organization.id);

    // Every organization-dependent layout, not just one route: the sidebar,
    // the switcher, and the badge counts all read the active organization.
    revalidatePath("/", "layout");

    return {
      organizationId: created.organization.id,
      // Step one, not the overview. A brand-new organization is a name and
      // nothing else, and a dashboard of zeroes teaches somebody the product is
      // empty rather than that it is unconfigured.
      nextPath: "/onboarding/organization",
    };
  });
}
