import Link from "next/link";
import { PrimaryButton, SecondaryButton } from "@/components/site/button";
import { SpeechBubble } from "@/components/site/speech-bubble";
import { Lede, SectionHeading } from "@/components/site/section";

/**
 * The closing call to action, with the bubbles that frame it on every page.
 *
 * Replaces the early-access email capture that used to sit here. Signup is
 * self-serve now: `signUpAction` provisions the organization and drops the
 * owner on `/onboarding/organization`, so there is nothing left for a person on
 * our side to do between "interested" and "using it", and a form that collects
 * an address so we can email back a link would only add a wait.
 *
 * A server component, unlike the form it replaces — two links need no state.
 *
 * `id="access"` is kept although nothing links to it any more. It was the
 * target of every in-page CTA for the life of the marketing site, so it is the
 * fragment in any link that escaped into an email or a search result, and an
 * anchor that still lands on the page's main action costs one attribute.
 */
export function ClosingCta() {
  return (
    <section id="access" className="relative bg-white">
      <div className="relative mx-auto w-full max-w-[1200px] px-[clamp(24px,6vw,106px)] py-[clamp(64px,8vw,110px)]">
        <div className="pointer-events-none absolute -top-7 left-[clamp(8px,4vw,54px)] z-10 hidden lg:block">
          <SpeechBubble
            quote="Live in an afternoon."
            attribution="New customer"
            tone="amber"
            className="w-[186px] -rotate-[5deg]"
          />
        </div>
        <div className="pointer-events-none absolute -bottom-7 right-[clamp(8px,4vw,50px)] z-10 hidden lg:block">
          <SpeechBubble
            quote="Worth every penny."
            attribution="Owner"
            tone="plain"
            className="w-[172px] rotate-[5deg]"
          />
        </div>

        <div className="mx-auto max-w-[620px] text-center">
          <SectionHeading>
            Know what to say when your reputation is public.
          </SectionHeading>
          <Lede className="mt-4.5 mb-7">
            Create your workspace, connect your Google reviews, and see what
            people are already saying about you.
          </Lede>
          <div className="flex flex-wrap justify-center gap-3">
            <PrimaryButton href="/sign-up">Get started</PrimaryButton>
            <SecondaryButton href="/contact">Talk to us first</SecondaryButton>
          </div>
          {/* Said here rather than discovered on the sign-up form. Somebody
              whose colleague already runs the workspace should be looking for
              an invitation, not creating a second organization. */}
          <p className="mt-4 text-[12.5px] text-site-muted">
            Free to start. Already have an account?{" "}
            <Link
              href="/sign-in"
              className="text-site-blue underline-offset-4 hover:underline"
            >
              Sign in
            </Link>
            .
          </p>
        </div>
      </div>
    </section>
  );
}
