import type { Metadata } from "next";
import { ClosingCta } from "@/components/site/closing-cta";
import { PricingBands } from "@/components/site/pricing-bands";
import { PricingEstimator } from "@/components/site/pricing-estimator";
import { PricingPlans } from "@/components/site/pricing-plans";
import { SpeechBubble } from "@/components/site/speech-bubble";
import {
  Eyebrow,
  Lede,
  PageHeading,
  Section,
  SectionHeading,
} from "@/components/site/section";
import {
  ANNUAL_DISCOUNT_LABEL,
  ANNUAL_MONTHS_BILLED,
  PRICING_FAQS,
} from "@/lib/site/content/pricing";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "One price per location, and it falls as the group grows — $59 for your first, $34 each at scale. Pay for the year up front and two months are free.",
};

export default function PricingPage() {
  return (
    <>
      <header className="relative mx-auto w-full max-w-[1200px] px-[clamp(24px,6vw,106px)] pt-[clamp(48px,8vw,108px)] pb-[clamp(28px,4vw,48px)]">
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

        <Eyebrow>Pricing</Eyebrow>
        <PageHeading className="mb-6 max-w-[560px]">
          The more locations you run, the less each one costs.
        </PageHeading>
        <Lede className="max-w-[560px]">
          Your first location is $59 a month. Every one after it costs less than
          the last, you keep the lower rate the moment you reach it, and paying
          for the year up front is {ANNUAL_DISCOUNT_LABEL}. No long contract
          either way.
        </Lede>
      </header>

      <div className="mx-auto w-full max-w-[1200px] px-[clamp(24px,6vw,106px)] pt-[clamp(20px,3vw,32px)] pb-[clamp(40px,5vw,56px)]">
        <PricingPlans />
        <p className="mt-6.5 text-center text-[13.5px] text-site-muted">
          Launch pricing, locked in for your first year. Every plan includes
          every platform — nothing here is an add-on. Cancel anytime.
        </p>
      </div>

      <Section tinted>
        <SectionHeading className="mb-3 text-center">
          Every rate, in one table.
        </SectionHeading>
        <p className="mx-auto mb-[clamp(28px,4vw,44px)] max-w-[620px] text-center text-[15px] leading-[1.6] text-site-body">
          Locations are priced in bands, the way tax brackets work. Each one is
          charged at the rate of the band it lands in — so your eleventh
          location costs less than your first, and it never reprices the ten
          below it. Annual billing charges {ANNUAL_MONTHS_BILLED} months of
          that, not 12.
        </p>
        <div className="mx-auto max-w-[760px]">
          <PricingBands />
          {/* The worked example is interactive rather than fixed: the discount
              is a dollar figure that depends on the size of the group, so the
              reader picks their own size instead of reading someone else's. */}
          <div className="mt-6">
            <PricingEstimator />
          </div>
        </div>
      </Section>

      <Section>
        <div className="mx-auto max-w-[1000px]">
          <SectionHeading className="mb-[clamp(32px,4vw,48px)] text-center">
            Questions, answered.
          </SectionHeading>
          <div className="grid grid-cols-1 gap-[clamp(28px,4vw,56px)] md:grid-cols-2">
            {PRICING_FAQS.map((faq) => (
              <div key={faq.question}>
                <h3 className="mb-2.5 text-[17px] font-semibold text-site-ink">
                  {faq.question}
                </h3>
                <p className="text-[15px] leading-[1.6] text-site-body">
                  {faq.answer}
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
