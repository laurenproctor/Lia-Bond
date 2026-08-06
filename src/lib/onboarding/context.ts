import "server-only";

import { redirect } from "next/navigation";
import { cache } from "react";
import {
  isOnboardingComplete,
  isStepReachable,
  onboardingPathFor,
  ONBOARDING_READY_PATH,
  resumePath,
  type OnboardingWizardStep,
  type OrganizationOnboarding,
} from "@/domain";
import { can } from "@/lib/auth/permissions";
import { getDataSource } from "@/lib/data";
import type { LiaDataSource } from "@/lib/data/types";
import {
  getOrganizationContext,
  type OrganizationContext,
} from "@/lib/tenancy/organization-context";

/**
 * Onboarding resolution and the route guard.
 *
 * Everything here runs on the server. There is no client-side wizard router:
 * the browser cannot be the thing that decides whether step 4 is reachable,
 * because typing the URL would then be enough to skip three steps and land on a
 * form whose prerequisites — a connected Google account, a mapped location —
 * had never been satisfied.
 *
 * Two guards exist and they point in opposite directions, which is what keeps
 * them from looping:
 *
 * - `requireOnboardingStep` runs inside `/onboarding/*` and sends a **finished**
 *   organization out to the product.
 * - `redirectIfOnboarding` runs inside the product shell and sends an
 *   **unfinished** one into the wizard.
 *
 * A finished organization satisfies the first and is untouched by the second; an
 * unfinished one is the reverse. Neither can hand back to the other.
 */

export interface OnboardingContext extends OrganizationContext {
  dataSource: LiaDataSource;
  state: OrganizationOnboarding;
  /** True when the caller's role may advance setup. Owners and admins. */
  mayManage: boolean;
}

/**
 * The onboarding row for the active organization, or null when there is none.
 *
 * Absence is meaningful and it means **finished**, not "start the wizard".
 * Every organization that existed before this table was created was backfilled
 * as completed, and `provision_organization` writes the row in the same
 * transaction as the organization itself — so a missing row is an anomaly, and
 * the safe direction for an anomaly is into the product rather than into a
 * setup wizard for a workspace somebody has been using for months.
 *
 * Wrapped in React's `cache` so the layout, the guard, and the page beneath
 * share one read.
 */
export const getOnboardingState = cache(
  async (): Promise<OrganizationOnboarding | null> => {
    const context = await getOrganizationContext();
    const dataSource = await getDataSource();
    return dataSource.onboarding.get(context.scope);
  },
);

/**
 * Whether this request should be diverted into the wizard, and where.
 *
 * Returns null when it should not be. Only owners and admins are diverted:
 * every step is an owner-or-admin decision, so sending an analyst to a wizard
 * they cannot operate would strand them at a form with every control disabled.
 * Everybody else sees the product, partially configured, which is honest — the
 * screens render real data and real empty states.
 */
export async function onboardingRedirectFor(
  context: OrganizationContext,
  state: OrganizationOnboarding | null,
): Promise<string | null> {
  if (!state) return null;
  if (isOnboardingComplete(state)) return null;
  if (!can(context.role, "onboarding.manage")) return null;
  return resumePath(state);
}

/**
 * The product shell's half of the guard.
 *
 * Called from `(app)/layout.tsx` before the sidebar renders, so somebody with a
 * half-configured workspace never sees a dashboard that implies setup is done.
 */
export async function redirectIfOnboarding(): Promise<void> {
  const context = await getOrganizationContext();
  const state = await getOnboardingState();
  const destination = await onboardingRedirectFor(context, state);
  if (destination) redirect(destination);
}

/**
 * The wizard's half of the guard.
 *
 * Establishes the context for one step, and refuses three things:
 *
 * 1. A finished organization is sent to the product. The wizard is not a
 *    settings screen — every step already exists as a real product screen, and
 *    re-running setup would let somebody mark an established workspace
 *    incomplete.
 * 2. A step whose prerequisites are unsettled redirects to the first one that
 *    is. This is what makes a typed URL harmless.
 * 3. A role that cannot manage onboarding is sent to the overview rather than
 *    shown a form it could not submit.
 *
 * A step that has already been settled is *not* refused: revisiting a completed
 * step is the back button, and it has to work.
 */
export async function requireOnboardingStep(
  step: OnboardingWizardStep,
): Promise<OnboardingContext> {
  const context = await getOrganizationContext();
  const dataSource = await getDataSource();
  const state = await getOnboardingState();

  // No row, or already finished: this organization has no wizard to be in.
  if (!state || isOnboardingComplete(state)) {
    redirect("/overview");
  }

  if (!can(context.role, "onboarding.manage")) {
    redirect("/overview");
  }

  if (!isStepReachable(state, step)) {
    redirect(resumePath(state));
  }

  return { ...context, dataSource, state, mayManage: true };
}

/**
 * The Workspace Ready screen's guard.
 *
 * Deliberately not `requireOnboardingStep`: `ready` is not one of the five
 * steps, and the rules are the mirror image. An organization that has *not*
 * finished the wizard is sent back to finish it; one that has is allowed
 * through however many times it likes, because the screen is a useful landing
 * page rather than a one-shot confirmation.
 */
export async function requireOnboardingReady(): Promise<OnboardingContext> {
  const context = await getOrganizationContext();
  const dataSource = await getDataSource();
  const state = await getOnboardingState();

  if (!state) {
    // An organization from before onboarding existed. It has no ready screen to
    // show, and inventing a setup summary for it would be fiction.
    redirect("/overview");
  }

  if (!isOnboardingComplete(state)) {
    redirect(resumePath(state));
  }

  if (!can(context.role, "onboarding.manage")) {
    redirect("/overview");
  }

  return { ...context, dataSource, state, mayManage: true };
}

/**
 * Where a signed-in person should land.
 *
 * Used by sign-in and by the auth callback, both of which run before any layout
 * and therefore before either guard above. `requested` is the caller's intended
 * destination and it is honoured whenever onboarding is finished — somebody
 * following a link to a specific review should not be dumped on the overview.
 *
 * The caller has already passed `requested` through `safeDestination`.
 */
export async function signInDestination(requested: string): Promise<string> {
  const context = await getOrganizationContext();
  const dataSource = await getDataSource();
  const state = await dataSource.onboarding.get(context.scope);

  const onboarding = await onboardingRedirectFor(context, state);
  if (onboarding) return onboarding;

  // Finished, but the result screen has never been opened — which happens when
  // the browser died between Finish setup and the redirect. Landing there once
  // is better than never showing somebody the outcome of their own setup.
  if (state && isOnboardingComplete(state) && state.readyViewedAt === null) {
    return ONBOARDING_READY_PATH;
  }

  return requested;
}

/** The path for a step. Re-exported so callers need one import, not two. */
export { onboardingPathFor };
