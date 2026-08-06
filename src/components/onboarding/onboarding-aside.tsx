import type { LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { ONBOARDING_STEP_DEFINITIONS } from "@/domain";
import { OnboardingDoodle } from "@/components/onboarding/onboarding-doodle";

/**
 * The contextual panel to the left of the working card.
 *
 * Explains *why* the step exists. Nothing here is required to complete it —
 * every field, control, and error lives in the card — so on a narrow screen
 * this stacks above the form and can be scrolled past without losing anything.
 *
 * The eyebrow is a real heading-adjacent label rather than a decorative badge,
 * and the headline is the page's `h1`. There is exactly one `h1` per screen and
 * it is here, because "Create your Lia workspace" is what the page is about;
 * the card's title is an `h2` beneath it.
 */

export interface AsideBenefit {
  icon: LucideIcon;
  title: string;
  description: string;
}

export function OnboardingAside({
  eyebrow,
  headline,
  description,
  benefits,
  footer,
  doodle = true,
}: {
  eyebrow: string;
  headline: string;
  description: string;
  benefits: readonly AsideBenefit[];
  /** Optional extra block beneath the benefits. */
  footer?: ReactNode;
  doodle?: boolean;
}) {
  return (
    <div className="relative flex flex-col gap-6">
      {doodle ? (
        <OnboardingDoodle
          variant="blue"
          float="a"
          // Positioned so it never overlaps the headline: it sits in the gutter
          // beside the eyebrow on wide screens and is hidden outright below
          // `lg`, where there is no gutter to sit in.
          className="absolute -top-2 right-0 hidden h-12 w-auto lg:block xl:-right-6"
        />
      ) : null}

      <div className="flex flex-col gap-4">
        <p className="inline-flex w-fit rounded-full bg-site-blue-tint px-3 py-1 text-[11px] font-bold tracking-[0.1em] text-site-blue uppercase">
          {eyebrow}
        </p>
        <h1 className="max-w-[13ch] text-[34px] leading-[1.05] font-extrabold tracking-[-0.02em] text-balance text-site-ink sm:text-[40px] lg:text-[44px]">
          {headline}
        </h1>
        <p className="max-w-[46ch] text-[15px] leading-relaxed text-site-body">
          {description}
        </p>
      </div>

      <ul className="flex flex-col gap-4">
        {benefits.map((benefit) => (
          <li key={benefit.title} className="flex gap-3">
            <span className="flex size-9 shrink-0 items-center justify-center rounded-full bg-site-blue-tint">
              <benefit.icon
                className="size-[18px] text-site-blue"
                strokeWidth={1.8}
                aria-hidden
              />
            </span>
            <span className="min-w-0">
              <span className="block text-[14px] font-semibold text-site-ink">
                {benefit.title}
              </span>
              <span className="block text-[13px] leading-relaxed text-site-body">
                {benefit.description}
              </span>
            </span>
          </li>
        ))}
      </ul>

      {footer}
    </div>
  );
}

/** "STEP 3 OF 5", built from the step table rather than typed per screen. */
export function stepEyebrow(number: number): string {
  return `Step ${number} of ${ONBOARDING_STEP_DEFINITIONS.length}`;
}
