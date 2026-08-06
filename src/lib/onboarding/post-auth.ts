import "server-only";

import { DEFAULT_SIGN_IN_DESTINATION } from "@/lib/auth/redirect";
import { getSession } from "@/lib/auth/session";
import { getDataSource } from "@/lib/data";
import { signInDestination } from "@/lib/onboarding/context";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Where somebody goes immediately after authenticating.
 *
 * Shared by the sign-in action and the emailed-link callback because both run
 * before any layout, and therefore before either onboarding guard. Without this
 * the first thing a new owner would see after confirming their email is the
 * overview of an unconfigured workspace, and the layout guard would bounce them
 * — one extra redirect, on the most important screen of their first session.
 */

/**
 * The user-metadata key holding the organization name from a signup that could
 * not provision immediately.
 *
 * Needed only when the Supabase project requires email confirmation: `signUp`
 * returns no session in that case, so there is no authenticated caller for
 * `provision_organization` — which takes its actor from `auth.uid()` and
 * refuses without one. The name has to survive until the link is clicked, and
 * signup metadata is the one place it can, because Lia holds no row for this
 * person yet.
 *
 * **It is a hint, never an authorization.** Supabase user metadata is writable
 * by the account it belongs to, so anybody could set this key on themselves.
 * That buys nothing: provisioning below runs only when the account belongs to
 * *no* organization at all, so the worst outcome is the empty workspace they
 * were already entitled to create through the sign-up form.
 */
export const PENDING_ORGANIZATION_METADATA_KEY = "lia_pending_organization";

function readPendingOrganizationName(metadata: unknown): string | null {
  if (metadata === null || typeof metadata !== "object") return null;
  const value = (metadata as Record<string, unknown>)[
    PENDING_ORGANIZATION_METADATA_KEY
  ];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 160 ? trimmed : null;
}

/**
 * Provision the organization a confirmed signup could not create earlier.
 *
 * Returns true when it created one. No-ops — and returns false — for anybody
 * who already belongs to an organization, which is what keeps an invited user
 * from ever getting an organization of their own: they joined one, so the
 * membership check below is already satisfied by the time they arrive here.
 * That is the same guarantee `acceptInvitationWithSignUpAction` relies on, and
 * it is deliberately a check on real membership rather than on which form was
 * submitted.
 *
 * The onboarding row is created by `provision_organization` itself, in the same
 * transaction — see the migration.
 */
export async function provisionPendingOrganization(): Promise<boolean> {
  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.getUser();
  if (error || !data.user) return false;

  const pendingName = readPendingOrganizationName(data.user.user_metadata);
  if (!pendingName) return false;

  const dataSource = await getDataSource();
  const memberships = await dataSource.organizations.listForUser(data.user.id);

  // Already a member of something — an invitee, or somebody whose provisioning
  // landed on a previous visit. Either way there is nothing to create, and
  // creating one anyway is precisely the duplicate-organization bug this
  // function exists to avoid.
  if (memberships.length > 0) {
    await clearPendingOrganization(supabase);
    return false;
  }

  try {
    await dataSource.organizations.provision({
      userId: data.user.id,
      name: pendingName,
    });
  } catch (cause) {
    // Logged without the name: it is customer-identifying and the failure is
    // diagnosable from the user id the platform already logs.
    console.error("[auth:pending-provision] failed", cause);
    return false;
  }

  await clearPendingOrganization(supabase);
  return true;
}

/**
 * Best-effort removal of the pending name.
 *
 * A failure here is harmless — the membership check above is what actually
 * prevents a second organization — so it is swallowed rather than allowed to
 * fail a sign-in that has otherwise succeeded.
 */
async function clearPendingOrganization(
  supabase: Awaited<ReturnType<typeof createSupabaseServerClient>>,
): Promise<void> {
  try {
    await supabase.auth.updateUser({
      data: { [PENDING_ORGANIZATION_METADATA_KEY]: null },
    });
  } catch {
    /* See the doc comment. */
  }
}

/**
 * Resolve where an authenticated request should land.
 *
 * `requested` has already been through `safeDestination`, so it is a relative
 * path. It is honoured whenever setup is finished — somebody following a link
 * to a specific review should arrive at that review, not at the overview.
 *
 * An account belonging to no organization at all falls through to the requested
 * destination rather than to onboarding. There is nothing to onboard: the app
 * shell reports "your account is not a member of any organization yet", which is
 * the accurate thing to say, and a wizard would have no organization to write to.
 */
export async function postAuthDestination(requested: string): Promise<string> {
  const session = await getSession();
  if (!session) return DEFAULT_SIGN_IN_DESTINATION;

  const dataSource = await getDataSource();
  const memberships = await dataSource.organizations.listForUser(session.id);
  if (memberships.length === 0) return requested;

  return signInDestination(requested);
}
