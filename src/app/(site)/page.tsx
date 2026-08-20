import type { Metadata } from "next";
import { PrimaryButton, SecondaryButton } from "@/components/site/button";
import { ClosingCta } from "@/components/site/closing-cta";
import { SpeechBubble } from "@/components/site/speech-bubble";
import {
  Eyebrow,
  Lede,
  PageHeading,
  Section,
  SectionHeading,
} from "@/components/site/section";
import { HOME_JUDGMENT, HOME_STAGES } from "@/lib/site/content/home";

export const metadata: Metadata = {
  // The layout's default title already reads as a home page title, so this
  // page opts out of the "%s · Lia" template rather than repeating the brand.
  title: {
    absolute: "Lia — know what to say when your reputation is public",
  },
};

export default function HomePage() {
  return (
    <>
      <header className="relative mx-auto w-full max-w-[1200px] px-[clamp(24px,6vw,106px)] pt-[clamp(48px,8vw,108px)] pb-[clamp(36px,5vw,64px)]">
        <div className="pointer-events-none absolute top-1/2 right-[clamp(10px,3vw,40px)] z-10 hidden -translate-y-1/2 flex-col items-end gap-4 lg:flex">
          <SpeechBubble
            quote="Every location sounds like us now."
            attribution="Multi-location owner"
            tone="blue"
            float="a"
            className="w-[188px]"
          />
          <SpeechBubble
            quote="Five stars, genuinely earned."
            attribution="Restaurant guest · Yelp"
            tone="amber"
            float="b"
            className="mr-6.5 w-[176px]"
          />
        </div>

        <Eyebrow>Reputation intelligence</Eyebrow>
        <PageHeading className="mb-6 max-w-[620px]">
          Know what people are saying. Respond when it matters.
        </PageHeading>
        <Lede className="mb-8 max-w-[560px]">
          Lia monitors reviews and press across every location, recommends what
          to do next, and drafts thoughtful responses in your voice. Sensitive
          mentions are held for the right person to review, and overarching
          trend data shows how your business is being received.
        </Lede>
        <div className="flex flex-wrap gap-3">
          <PrimaryButton href="/sign-up">Start free</PrimaryButton>
          <SecondaryButton href="/product">See Lia in action</SecondaryButton>
        </div>
      </header>

      <Section tinted>
        <Eyebrow>How it works</Eyebrow>
        <SectionHeading className="mb-[clamp(32px,4vw,52px)] max-w-[620px]">
          Six stages, from a stranger&rsquo;s post to a decision you can defend.
        </SectionHeading>
        <ol className="grid grid-cols-1 gap-x-[clamp(24px,4vw,56px)] gap-y-9 sm:grid-cols-2 lg:grid-cols-3">
          {HOME_STAGES.map((stage, index) => (
            <li key={stage.name}>
              <span className="mb-3 inline-flex size-7 items-center justify-center rounded-full bg-white text-[12.5px] font-semibold text-site-blue ring-1 ring-site-blue-edge">
                {index + 1}
              </span>
              <h3 className="mb-2 text-[17px] font-semibold text-site-ink">
                {stage.name}
              </h3>
              <p className="text-[15px] leading-[1.6] text-site-body">
                {stage.description}
              </p>
            </li>
          ))}
        </ol>
      </Section>

      <Section id="judgment">
        <div className="grid grid-cols-1 gap-[clamp(32px,5vw,72px)] lg:grid-cols-[1fr_1fr]">
          <div>
            <Eyebrow>{HOME_JUDGMENT.eyebrow}</Eyebrow>
            <SectionHeading className="mb-6">
              {HOME_JUDGMENT.heading}
            </SectionHeading>
            {HOME_JUDGMENT.body.map((paragraph) => (
              <p
                key={paragraph.slice(0, 32)}
                className="mb-4 text-[16px] leading-[1.65] text-site-body"
              >
                {paragraph}
              </p>
            ))}
          </div>
          <div className="flex flex-col gap-5">
            {HOME_JUDGMENT.points.map((point) => (
              <div
                key={point.title}
                className="rounded-[18px] border border-site-border bg-white p-6"
              >
                <h3 className="mb-2 text-[16px] font-semibold text-site-ink">
                  {point.title}
                </h3>
                <p className="text-[14.5px] leading-[1.6] text-site-body">
                  {point.body}
                </p>
              </div>
            ))}
          </div>
        </div>
      </Section>

      <ClosingCta />
    </>
  );
}
