import type { Metadata } from "next";
import { ClosingCta } from "@/components/site/closing-cta";
import { PricingBands } from "@/components/site/pricing-bands";
import { PricingPlans } from "@/components/site/pricing-plans";
import { SpeechBubble } from "@/components/site/speech-bubble";
import {
  Eyebrow,
  Lede,
  PageHeading,
  Section,
  SectionHeading,
} from "@/components/site/section";
import { formatDollars, monthlyTotal } from "@/lib/site/content/pricing";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Per location, billed monthly, and the rate falls with every band you cross. From $59 for one location down to $34 each at scale.",
};

/**
 * A worked example, computed rather than written down, so it cannot contradict
 * the table it sits under. `monthlyTotal` returns `null` above the listed
 * range — twelve is not, but the render below still guards rather than print
 * "$null" if the bands are ever rewritten around it.
 */
const EXAMPLE_LOCATIONS = 12;
const EXAMPLE_TOTAL = monthlyTotal(EXAMPLE_LOCATIONS);

/**
 * The FAQ answers are load-bearing marketing claims, so each one is checked
 * against what the product actually does:
 *
 * - "nothing goes public until a person approves it" — `requiresApproval` on
 *   `ConnectorCapabilities`, and the approval-first rule in CLAUDE.md.
 * - The platform list is `PLATFORMS` in `src/domain/enums.ts`. The design
 *   reference also named Booking.com, which is not a platform this product
 *   models; it is dropped rather than promised.
 */
const FAQS = [
  {
    question: "How does per-location pricing work?",
    answer:
      "Each location is priced at the band it falls into, the way tax brackets work. Adding an eleventh location does not reprice the first ten — it is charged at the lower band, and so is every location after it.",
  },
  {
    question: "Does Lia post replies automatically?",
    answer:
      "No. Lia drafts responses, but nothing goes public until a person approves it. Sensitive reviews are always held for review first.",
  },
  {
    question: "Which platforms do you support?",
    answer:
      "Google Business Profile is core, with Tripadvisor, Yelp, Trustpilot, Facebook, and Reddit available. News coverage and supported article comments are monitored too. We add platforms on request.",
  },
  {
    question: "How long does setup take?",
    answer:
      "Most teams are live in an afternoon. We connect your profiles, import your brand voice, and tune escalation rules with you.",
  },
  {
    question: "Is there a contract?",
    answer:
      "No long commitment. Billing is monthly per location, and you can cancel any time without penalty.",
  },
] as const;

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
          Pricing that fits how you run.
        </PageHeading>
        <Lede className="max-w-[560px]">
          Per location, billed monthly, no long contracts. The rate falls with
          every band you cross, and you only pay the lower rate on the locations
          that reach it.
        </Lede>
      </header>

      <div className="mx-auto w-full max-w-[1200px] px-[clamp(24px,6vw,106px)] pt-[clamp(20px,3vw,32px)] pb-[clamp(40px,5vw,56px)]">
        <PricingPlans />
        <p className="mt-6.5 text-center text-[13.5px] text-site-muted">
          Launch pricing, locked in for your first year. Cancel anytime.
        </p>
      </div>

      <Section tinted>
        <SectionHeading className="mb-3 text-center">
          What each location costs.
        </SectionHeading>
        <p className="mx-auto mb-[clamp(28px,4vw,44px)] max-w-[620px] text-center text-[15px] leading-[1.6] text-site-body">
          Locations are priced in bands. Every location is charged at the rate
          of the band it lands in, so the price per location drops as the group
          grows.
        </p>
        <div className="mx-auto max-w-[760px]">
          <PricingBands />
          {EXAMPLE_TOTAL === null ? null : (
            <p className="mt-5 text-center text-[13.5px] leading-[1.6] text-site-muted">
              A {EXAMPLE_LOCATIONS}-location group pays{" "}
              <strong className="font-semibold text-site-ink">
                {formatDollars(EXAMPLE_TOTAL)} a month
              </strong>{" "}
              — the first location at its own rate, and every location after it
              at the rate of the band it lands in.
            </p>
          )}
        </div>
      </Section>

      <Section>
        <div className="mx-auto max-w-[1000px]">
          <SectionHeading className="mb-[clamp(32px,4vw,48px)] text-center">
            Questions, answered.
          </SectionHeading>
          <div className="grid grid-cols-1 gap-[clamp(28px,4vw,56px)] md:grid-cols-2">
            {FAQS.map((faq) => (
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
