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
        <Body>
          Customers are constantly telling businesses what they think. They
          leave reviews, ask questions, post comments, share frustrations,
          recommend products, describe experiences, and signal what they want
          next.
        </Body>
        <Body>
          The problem is no longer a lack of feedback. The problem is making
          sense of it all, responding thoughtfully, and turning thousands of
          individual interactions into something useful. Lia exists to help
          businesses do that.
        </Body>
      </header>

      <Section tinted>
        <SectionHeading className={`mb-6 ${MEASURE}`}>
          Technology can scale communication. Judgment is what makes it
          meaningful.
        </SectionHeading>
        <Body>
          Artificial intelligence makes it possible to process more customer
          conversations than any individual team could reasonably manage. But
          scale alone is not the goal.
        </Body>
        <Body>
          A technically correct response can still feel indifferent. A
          perfectly efficient system can still misunderstand context. And
          automation without judgment can create distance at precisely the
          moment a customer is trying to be heard.
        </Body>
        <Body>
          We believe the strongest applications of AI do something different:
          they give people greater capacity to listen.
        </Body>
        <Body>
          Lia uses technology to help organizations understand what customers
          are saying, identify what matters, respond consistently, and
          recognize patterns that would otherwise disappear inside thousands
          of individual interactions. The technology does the work computers
          are good at. People remain responsible for judgment.
        </Body>
      </Section>

      <Section>
        <SectionHeading className={`mb-6 ${MEASURE}`}>
          What Lia does
        </SectionHeading>
        <Body>
          Lia brings customer conversations into a single intelligence layer.
          The platform is designed to help businesses:
        </Body>
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
        <Body>
          The objective is not to automate every conversation. It is to make
          every conversation more manageable, more informed, and more useful.
        </Body>
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
        <Body>
          A review is not merely something to answer. It is evidence.
          Thousands of reviews become a record of what customers experience
          repeatedly.
        </Body>
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
        <Body>
          Feedback contains information about the business itself. Lia is
          being built to help organizations move beyond responding to
          individual reviews and toward understanding the larger story those
          interactions tell.
        </Body>

        <SectionHeading
          className={`mt-[clamp(40px,6vw,64px)] mb-6 ${MEASURE} text-[clamp(22px,2.6vw,32px)]!`}
        >
          Built for organizations with reputations worth protecting
        </SectionHeading>
        <Body>
          Lia is designed for businesses where customer experience happens
          repeatedly, across teams, locations, and channels: hospitality
          groups, restaurants, retailers, service businesses, multi-location
          organizations, and other companies whose reputation is shaped one
          interaction at a time.
        </Body>
        <Body>
          As those organizations grow, maintaining attentiveness becomes
          harder. The founder may once have read every review. A general
          manager may once have known every customer complaint. A small team
          may once have understood instinctively how the business should
          respond. Scale changes that.
        </Body>
        <Body>
          Lia is intended to preserve that institutional awareness as
          organizations become more complex.
        </Body>
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
        <Body>
          Lia is a Storyworlding company. Founded by Lauren Proctor,
          Storyworlding builds and stewards a portfolio of companies that
          place human judgment, relationships, and agency at the center of
          emerging technology.
        </Body>
        <Body>
          We believe emerging technologies will change not only what people
          can do, but how people relate to businesses, institutions,
          information, one another, and eventually themselves. That creates an
          enormous field of technological possibility. It also creates
          questions technology cannot answer on its own.
        </Body>
        <Body>
          What should remain human? Where should judgment live? Which
          relationships are worth protecting? What becomes more important when
          intelligence becomes abundant?
        </Body>
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
        <Body>
          Lauren Proctor is an entrepreneur and marketing strategist who has
          spent her career working at the intersection of technology, media,
          brands, and human behavior. She previously co-founded a technology
          platform in the creator and influencer economy that was acquired by
          Twitter, and has since worked with organizations on positioning,
          growth, digital strategy, customer acquisition, and emerging
          technologies.
        </Body>
        <Body>
          Lia grew from a simple observation: businesses have never had access
          to more information about what their customers think, yet many still
          struggle to hear them at scale.
        </Body>
        <Body>
          Artificial intelligence changes what is possible. The opportunity is
          not simply to generate more responses. It is to build better systems
          for listening.
        </Body>
      </Section>

      <Section tinted>
        <SectionHeading className={`mb-6 ${MEASURE}`}>
          What we are building toward
        </SectionHeading>
        <Body>
          Today, Lia helps businesses manage and understand customer
          conversations. The larger ambition is to create an intelligence
          system around the relationship between businesses and their
          customers.
        </Body>
        <Body>
          A system that can recognize patterns across thousands of
          interactions. A system that understands the difference between an
          isolated complaint and an emerging problem. A system that knows when
          automation is sufficient and when someone should pay attention. A
          system that helps organizations become more responsive without
          becoming less human.
        </Body>
        <Body>
          The most valuable outcome of artificial intelligence may not be
          removing people from every process. It may be giving people enough
          leverage to pay attention to the things that deserve them.
        </Body>
        <PullLine>That is the company we are building.</PullLine>
      </Section>

      <ClosingCta />
    </>
  );
}
