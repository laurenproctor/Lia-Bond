import type { Metadata } from "next";
import { SecondaryButton } from "@/components/site/button";
import { ClosingCta } from "@/components/site/closing-cta";
import {
  Eyebrow,
  Lede,
  PageHeading,
  Section,
  SectionHeading,
} from "@/components/site/section";
import { HOME_STAGES } from "@/lib/site/content/home";

export const metadata: Metadata = {
  title: "How it works",
  description:
    "From a stranger's post to an approved reply: detection, analysis, a recommendation, a draft in your voice, and an audit trail.",
};

/**
 * The six stages again, at length. The short forms on the home page and these
 * long forms share `HOME_STAGES` for their names and ordering, so the two pages
 * cannot describe a different product.
 */
const DETAIL: Record<string, readonly string[]> = {
  Detect: [
    "Connect your Google Business Profile and Lia starts pulling reviews for every location on the account.",
    "Add Reddit, news monitoring, and the review platforms you care about. Each mention is matched to the right brand and the right location before anyone sees it.",
  ],
  Understand: [
    "Every mention is read for sentiment, topic, relevance, risk, and urgency.",
    "That is what separates a complaint about a slow Tuesday service from an allegation about food safety — and what stops the second one sitting in a queue behind forty of the first.",
  ],
  Decide: [
    "Lia recommends whether to respond at all, and why.",
    "Replying to everything is its own kind of noise. A recommendation you can disagree with is more useful than a draft you did not ask for.",
  ],
  Respond: [
    "Drafts come back in your brand voice, tuned by the settings you control, and shaped for the platform they are going to.",
    "A Google review reply and a Reddit comment are not the same register, and Lia does not pretend otherwise.",
  ],
  Escalate: [
    "Sensitive mentions route to the people who should see them first, carrying the full thread and a plain statement of why they were flagged.",
    "Nothing is published while it is escalated. Approval is the default state, not a setting somebody has to remember.",
  ],
  Learn: [
    "The same complaint arriving at four locations is a pattern, not four reviews.",
    "Lia surfaces recurring topics across your group so the operational fix reaches the person who can make it.",
  ],
};

export default function ProductPage() {
  return (
    <>
      <header className="mx-auto w-full max-w-[1200px] px-[clamp(24px,6vw,106px)] pt-[clamp(48px,8vw,108px)] pb-[clamp(28px,4vw,48px)]">
        <Eyebrow>How it works</Eyebrow>
        <PageHeading className="mb-6 max-w-[620px]">
          From a stranger&rsquo;s post to a reply you can stand behind.
        </PageHeading>
        <Lede className="mb-8 max-w-[600px]">
          Six stages. You can stop at any of them — Lia is built to be
          overruled, and the audit trail records who did.
        </Lede>
        <SecondaryButton href="/platforms">
          See which platforms are supported
        </SecondaryButton>
      </header>

      {HOME_STAGES.map((stage, index) => (
        <Section key={stage.name} tinted={index % 2 === 1}>
          <div className="grid grid-cols-1 gap-[clamp(24px,4vw,64px)] lg:grid-cols-[220px_1fr]">
            <div>
              <span className="mb-3 inline-flex size-8 items-center justify-center rounded-full bg-white text-[13px] font-semibold text-site-blue ring-1 ring-site-blue-edge">
                {index + 1}
              </span>
              <SectionHeading className="text-[clamp(22px,2.4vw,30px)]!">
                {stage.name}
              </SectionHeading>
            </div>
            <div className="max-w-[640px]">
              <p className="mb-4 text-[17px] leading-[1.6] font-medium text-site-ink">
                {stage.description}
              </p>
              {DETAIL[stage.name]?.map((paragraph) => (
                <p
                  key={paragraph.slice(0, 32)}
                  className="mb-3.5 text-[15.5px] leading-[1.65] text-site-body"
                >
                  {paragraph}
                </p>
              ))}
            </div>
          </div>
        </Section>
      ))}

      <ClosingCta />
    </>
  );
}
