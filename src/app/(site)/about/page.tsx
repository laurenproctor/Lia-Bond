import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ClosingCta } from "@/components/site/closing-cta";
import {
  Eyebrow,
  Lede,
  PageHeading,
  Section,
  SectionHeading,
} from "@/components/site/section";
import {
  ABOUT_CAPABILITIES,
  ABOUT_FEEDBACK_SIGNALS,
  ABOUT_PRINCIPLES,
  ABOUT_INTRO_PROSE,
  ABOUT_AI_PHILOSOPHY_PROSE,
  ABOUT_CAPABILITIES_INTRO,
  ABOUT_CAPABILITIES_CONCLUSION,
  ABOUT_FEEDBACK_INTRO,
  ABOUT_FEEDBACK_CONCLUSION,
  ABOUT_TARGET_ORGS_PROSE,
  ABOUT_STORYWORLDING_PROSE,
  ABOUT_FOUNDER_PROSE,
  ABOUT_FUTURE_VISION_PROSE,
} from "@/lib/site/content/about";

export const metadata: Metadata = {
  title: "About",
  description:
    "Better technology should make relationships more human, not less. Why Lia exists, the principles it is built on, and the company behind it.",
};

/**
 * The prose measure. Sections span the full shell; the running text does not.
 * 640px matches the long-form copy on /product.
 */
const MEASURE = "max-w-[640px]";

/** Running body copy. `last:mb-0` lets a section end flush. */
function Body({ children }: { children: ReactNode }) {
  return (
    <p
      className={`mb-3.5 ${MEASURE} text-[15.5px] leading-[1.65] text-site-body last:mb-0`}
    >
      {children}
    </p>
  );
}

/** A thesis line set apart from the running text. */
function PullLine({ children }: { children: ReactNode }) {
  return (
    <p
      className={`my-6 ${MEASURE} text-[19px] leading-[1.5] font-semibold text-site-ink`}
    >
      {children}
    </p>
  );
}

export default function AboutPage() {
  return (
    <>
      <header className="mx-auto w-full max-w-[1200px] px-[clamp(24px,6vw,106px)] pt-[clamp(48px,8vw,108px)] pb-[clamp(28px,4vw,48px)]">
        <Eyebrow>About</Eyebrow>
        <PageHeading className="mb-6 max-w-[720px]">
          Better technology should make relationships more human, not less.
        </PageHeading>
        <Lede className="mb-6 max-w-[620px]">
          Lia is an AI-powered customer intelligence and response platform
          built for businesses that care about how they are experienced.
        </Lede>
        {ABOUT_INTRO_PROSE.map((paragraph) => (
          <Body key={paragraph}>{paragraph}</Body>
        ))}
      </header>

      <Section tinted>
        <SectionHeading className={`mb-6 ${MEASURE}`}>
          Technology can scale communication. Judgment is what makes it
          meaningful.
        </SectionHeading>
        {ABOUT_AI_PHILOSOPHY_PROSE.map((paragraph) => (
          <Body key={paragraph}>{paragraph}</Body>
        ))}
      </Section>

      <Section>
        <SectionHeading className={`mb-6 ${MEASURE}`}>
          What Lia does
        </SectionHeading>
        <Body>{ABOUT_CAPABILITIES_INTRO}</Body>
        <ul className="my-8 grid max-w-[900px] grid-cols-1 gap-x-[clamp(24px,4vw,56px)] gap-y-4 md:grid-cols-2">
          {ABOUT_CAPABILITIES.map((capability) => (
            <li
              key={capability}
              className="flex gap-3 text-[15px] leading-[1.6] text-site-body"
            >
              <span
                aria-hidden
                className="mt-[9px] size-1.5 shrink-0 rounded-full bg-site-blue-mark"
              />
              {capability}
            </li>
          ))}
        </ul>
        <Body>{ABOUT_CAPABILITIES_CONCLUSION}</Body>
      </Section>

      <Section tinted>
        <SectionHeading className={`mb-6 ${MEASURE}`}>
          The human layer
        </SectionHeading>
        <Body>
          There is a growing assumption that as artificial intelligence
          becomes more capable, fewer people need to remain involved. We think
          that question is too simple. The more consequential question is:
        </Body>
        <PullLine>
          Where does human judgment become more valuable because technology
          has become more capable?
        </PullLine>
        <Body>
          Lia is built around that distinction. Some interactions are routine,
          and technology can handle them efficiently. Others contain
          ambiguity, emotion, reputational risk, operational significance, or
          an opportunity to strengthen a relationship. Those deserve judgment,
          and Lia is designed to know the difference.
        </Body>
        <Body>
          That means automation is not the philosophy of the product.{" "}
          <strong className="font-semibold text-site-ink">
            Discernment is.
          </strong>
        </Body>
      </Section>

      <Section>
        <SectionHeading className={`mb-6 ${MEASURE}`}>
          Customer feedback is more than reputation management
        </SectionHeading>
        <Body>{ABOUT_FEEDBACK_INTRO}</Body>
        <ul className={`my-6 flex ${MEASURE} flex-col gap-3`}>
          {ABOUT_FEEDBACK_SIGNALS.map((signal) => (
            <li
              key={signal}
              className="flex gap-3 text-[15px] leading-[1.6] text-site-body"
            >
              <span
                aria-hidden
                className="mt-[9px] size-1.5 shrink-0 rounded-full bg-site-blue-mark"
              />
              {signal}
            </li>
          ))}
        </ul>
        <Body>{ABOUT_FEEDBACK_CONCLUSION}</Body>

        <SectionHeading
          className={`mt-[clamp(40px,6vw,64px)] mb-6 ${MEASURE} text-[clamp(22px,2.6vw,32px)]!`}
        >
          Built for organizations with reputations worth protecting
        </SectionHeading>
        {ABOUT_TARGET_ORGS_PROSE.map((paragraph) => (
          <Body key={paragraph}>{paragraph}</Body>
        ))}
      </Section>

      <Section tinted>
        <SectionHeading className="mb-[clamp(28px,4vw,44px)]">
          Our principles
        </SectionHeading>
        <dl className="grid grid-cols-1 gap-x-[clamp(28px,4vw,56px)] gap-y-9 md:grid-cols-2 lg:grid-cols-3">
          {ABOUT_PRINCIPLES.map((principle) => (
            <div key={principle.name}>
              <dt className="mb-2 text-[16px] font-semibold text-site-ink">
                {principle.name}
              </dt>
              <dd className="text-[14.5px] leading-[1.6] text-site-body">
                {principle.body}
              </dd>
            </div>
          ))}
        </dl>
      </Section>

      <Section>
        <SectionHeading className={`mb-6 ${MEASURE}`}>
          A Storyworlding company
        </SectionHeading>
        {ABOUT_STORYWORLDING_PROSE.map((paragraph) => (
          <Body key={paragraph}>{paragraph}</Body>
        ))}
        <Body>
          Storyworlding builds companies around those questions.{" "}
          <strong className="font-semibold text-site-ink">
            We build for the human layer of emerging technology.
          </strong>{" "}
          Lia applies that philosophy to one of the most fundamental
          relationships in business: the relationship between an organization
          and the people it serves.
        </Body>

        <SectionHeading
          className={`mt-[clamp(40px,6vw,64px)] mb-6 ${MEASURE} text-[clamp(22px,2.6vw,32px)]!`}
        >
          Founded by Lauren Proctor
        </SectionHeading>
        {ABOUT_FOUNDER_PROSE.map((paragraph) => (
          <Body key={paragraph}>{paragraph}</Body>
        ))}
      </Section>

      <Section tinted>
        <SectionHeading className={`mb-6 ${MEASURE}`}>
          What we are building toward
        </SectionHeading>
        {ABOUT_FUTURE_VISION_PROSE.map((paragraph) => (
          <Body key={paragraph}>{paragraph}</Body>
        ))}
        <PullLine>That is the company we are building.</PullLine>
      </Section>

      <ClosingCta />
    </>
  );
}
