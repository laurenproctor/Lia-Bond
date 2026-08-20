import type { ReactNode } from "react";
import {
  ONBOARDING_STEP_DEFINITIONS,
  type OnboardingWizardStep,
  type OrganizationOnboarding,
} from "@/domain";
import { LogoMark } from "@/components/site/logo-mark";
import { OnboardingProgress } from "@/components/onboarding/onboarding-progress";
import { OnboardingOrgEscape } from "@/components/onboarding/onboarding-org-escape";
import type { OrganizationMembership } from "@/domain";

/**
 * The frame every onboarding screen renders inside.
 *
 * Deliberately **not** the app shell. There is no navy sidebar, no organization
 * switcher, and no badge counts, because none of those would be true yet: the
 * counts would all read zero and the switcher would offer one organization that
 * is not set up. Onboarding is closer to the marketing site than to the
 * product, and it uses the marketing site's tokens for exactly that reason —
 * this is the first screen after signing up, and it should look like the site
 * the person just came from rather than like a dashboard they have not earned.
 *
 * Layout: a narrow contextual panel on the left and the working card on the
 * right, with the progress strip beneath both. Below `lg` the two stack, the
 * panel first, so the reason for the step is read before the form.
 */
export function OnboardingShell({
  step,
  state,
  aside,
  children,
  organizations = [],
  activeOrganizationId,
}: {
  /** Null on the Workspace Ready screen, which shows no progress strip. */
  step: OnboardingWizardStep | null;
  state: OrganizationOnboarding;
  aside: ReactNode;
  children: ReactNode;
  /**
   * Every organization the caller belongs to. Optional and empty by default, so
   * a screen that does not pass it simply gets the wizard as it always was —
   * the escape control renders only when there is more than one.
   */
  organizations?: OrganizationMembership[];
  activeOrganizationId?: string;
}) {
  return (
    <div
      // `data-surface="site"` scopes the blue focus ring and selection colour
      // that globals.css defines for the marketing brand, leaving the product's
      // purple untouched everywhere else.
      data-surface="site"
      className="font-site min-h-dvh bg-site-tint text-site-body"
    >
      <div className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-10 lg:py-10">
        <header className="flex items-center justify-between">
          {/* `LogoMark` is aria-hidden — it is drawn vectors, not text — so the
              accessible name is supplied here rather than left to the artwork.
              It is not a link: there is nowhere useful to navigate mid-setup,
              and a logo that dropped somebody out of the wizard would look like
              a way to leave without losing their place. */}
          <p className="flex items-center gap-2 text-site-ink">
            <LogoMark />
            <span className="sr-only">Lia</span>
          </p>
          <div className="flex items-center gap-3">
            {step ? (
              <p className="text-[12px] font-semibold tracking-[0.08em] text-site-muted uppercase lg:hidden">
                Step {stepNumber(step)} of {ONBOARDING_STEP_DEFINITIONS.length}
              </p>
            ) : null}
            {/* Renders nothing unless the caller belongs to more than one
                organization. See the component for why the wizard otherwise
                stays navigation-free. */}
            {activeOrganizationId ? (
              <OnboardingOrgEscape
                organizations={organizations}
                activeOrganizationId={activeOrganizationId}
              />
            ) : null}
          </div>
        </header>

        <div className="grid gap-6 lg:grid-cols-12 lg:items-start lg:gap-10">
          <div className="lg:col-span-4 xl:col-span-4">{aside}</div>
          <main id="main" className="min-w-0 lg:col-span-8 xl:col-span-8">
            {children}
          </main>
        </div>

        {/* Absent on `/onboarding/ready`, which passes a null step. Setup is
            finished there; a five-step strip would say otherwise. */}
        {step ? <OnboardingProgress state={state} activeStep={step} /> : null}
      </div>
    </div>
  );
}

function stepNumber(step: OnboardingWizardStep): number {
  return (
    ONBOARDING_STEP_DEFINITIONS.find((definition) => definition.step === step)
      ?.number ?? 1
  );
}
