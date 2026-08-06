import Link from "next/link";
import { Check } from "lucide-react";
import {
  ONBOARDING_STEP_DEFINITIONS,
  stepState,
  type OnboardingStepState,
  type OnboardingWizardStep,
  type OrganizationOnboarding,
} from "@/domain";
import { cn } from "@/lib/cn";

/**
 * The five-step progress strip.
 *
 * Rendered beneath the main content on steps 1 through 5, and **never** on the
 * Workspace Ready screen — that screen is not step six, and a strip there would
 * frame a finished setup as an unfinished wizard.
 *
 * Three accessibility rules shape this markup:
 *
 * 1. State is never colour alone. Every marker carries a glyph (a tick or its
 *    number), and every step carries a visually hidden word — "completed",
 *    "skipped", "current step", "not started yet" — so the strip reads
 *    correctly with no colour perception at all.
 * 2. The active step carries `aria-current="step"`.
 * 3. A settled step is a real link and a future one is not a link at all,
 *    rather than a disabled anchor. A disabled link is still focusable in most
 *    browsers, and tabbing to something that does nothing is worse than it not
 *    being there.
 *
 * The list is an ordered list because the order is the meaning.
 */

const STATE_LABELS: Record<OnboardingStepState, string> = {
  done: "Completed",
  skipped: "Skipped",
  current: "Current step",
  upcoming: "Not started yet",
};

/**
 * The numbered circle.
 *
 * `aria-hidden` because it carries no information a screen reader needs twice:
 * the step's number is implicit in the ordered list, and its state is announced
 * as a word by `StepBody`. What this contributes is the *visual* distinction,
 * which is a tick rather than a colour — a completed step is legible in
 * greyscale.
 */
function Marker({ state, number }: { state: OnboardingStepState; number: number }) {
  return (
    <span
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-full border text-[12px] font-semibold",
        (state === "done" || state === "current") &&
          "border-site-blue bg-site-blue text-white",
        state === "skipped" && "border-site-field bg-white text-site-body",
        state === "upcoming" && "border-site-border bg-white text-site-muted",
      )}
      aria-hidden="true"
    >
      {state === "done" ? <Check className="size-4" strokeWidth={3} /> : number}
    </span>
  );
}

function StepBody({
  title,
  description,
  state,
}: {
  title: string;
  description: string;
  state: OnboardingStepState;
}) {
  return (
    <span className="min-w-0">
      <span
        className={cn(
          "block text-[13px] font-semibold",
          state === "current" ? "text-site-blue" : "text-site-ink",
        )}
      >
        {title}
      </span>
      {/* Hidden below `sm`: at 375px five descriptions cannot fit without
          wrapping into an unreadable column. The number and the title stay,
          which is what the strip is for. */}
      <span className="hidden text-[12px] leading-tight text-site-muted sm:block">
        {description}
      </span>
      <span className="sr-only">{STATE_LABELS[state]}</span>
    </span>
  );
}

export function OnboardingProgress({
  state,
  activeStep,
}: {
  state: OrganizationOnboarding;
  activeStep: OnboardingWizardStep;
}) {
  return (
    <nav aria-label="Setup progress" className="w-full">
      <ol
        className={cn(
          "flex flex-col gap-3 rounded-2xl border border-site-border bg-white p-4",
          "shadow-[0_1px_2px_0_rgb(11_15_24/0.04)]",
          // Horizontal from `md` up. Below that the five steps stack, which
          // keeps every title readable instead of forcing a sideways scroll.
          "md:flex-row md:items-start md:justify-between md:gap-2 md:px-6 md:py-5",
        )}
      >
        {ONBOARDING_STEP_DEFINITIONS.map((definition, index) => {
          const status = stepState(state, definition.step, activeStep);
          // Settled steps stay clickable so somebody can go back and change an
          // answer. A future step is not a link, so there is nothing to click
          // and nothing to focus.
          const linkable = status === "done" || status === "skipped";

          const content = (
            <>
              <Marker state={status} number={definition.number} />
              <StepBody
                title={definition.title}
                description={definition.description}
                state={status}
              />
            </>
          );

          return (
            <li
              key={definition.step}
              className="flex min-w-0 flex-1 items-start gap-3 md:gap-2"
              aria-current={status === "current" ? "step" : undefined}
            >
              {linkable ? (
                <Link
                  href={definition.path}
                  className="flex min-w-0 flex-1 items-start gap-3 rounded-lg transition-opacity hover:opacity-80 md:gap-2"
                >
                  {content}
                </Link>
              ) : (
                <span className="flex min-w-0 flex-1 items-start gap-3 md:gap-2">
                  {content}
                </span>
              )}

              {/* The connecting rule. Decorative, and absent after the last
                  step and below `md` where the list is a column. */}
              {index < ONBOARDING_STEP_DEFINITIONS.length - 1 ? (
                <span
                  aria-hidden="true"
                  className="mt-3.5 hidden h-px w-6 shrink-0 border-t border-dashed border-site-border md:block lg:w-10"
                />
              ) : null}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
