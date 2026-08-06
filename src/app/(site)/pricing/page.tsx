import type { Metadata } from "next";
import { AccessSection } from "@/components/site/access-form";
import { PricingTier } from "@/components/site/pricing-tier";
import { SpeechBubble } from "@/components/site/speech-bubble";
import {
  Eyebrow,
  Lede,
  PageHeading,
  Section,
  SectionHeading,
} from "@/components/site/section";

export const metadata: Metadata = {
  title: "Pricing",
  description:
    "Per location, billed monthly, no long contracts. Start with Google reviews and add platforms as you grow.",
};

const TIERS = [
  {
    name: "Single location",
    blurb: "For independent hotels, restaurants, and clinics.",
    price: "$149",
    priceNote: "per location, per month",
    ctaLabel: "Request early access",
    features: [
      "Google review monitoring",
      "AI-assisted response drafts",
      "Human review on sensitive replies",
      "Weekly reputation report",
    ],
  },
  {
    name: "Growth",
    blurb: "For multi-location brands and groups.",
    price: "$129",
    priceNote: "per location, per month · volume pricing",
    ctaLabel: "Request early access",
    featured: true,
    features: [
      "Everything in single location",
      "All review platforms connected",
      "Brand voice and escalation rules",
      "Monthly insights summary",
      "Priority support",
    ],
  },
  {
    name: "Brand",
    blurb: "For agencies and large multi-brand groups.",
    price: "Custom",
    priceNote: "tailored to your portfolio",
    ctaLabel: "Talk to us",
    features: [
      "Everything in growth",
      "Dedicated reputation strategist",
      "Custom workflows and approvals",
      "SSO and role-based access",
    ],
  },
] as const;

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
          Per location, billed monthly, no long contracts. Start with Google
          reviews and add platforms as you grow.
        </Lede>
      </header>

      <div className="mx-auto w-full max-w-[1200px] px-[clamp(24px,6vw,106px)] pt-[clamp(20px,3vw,32px)] pb-[clamp(40px,5vw,56px)]">
        <div className="grid grid-cols-1 items-stretch gap-6 lg:grid-cols-3">
          {TIERS.map((tier) => (
            <PricingTier key={tier.name} {...tier} />
          ))}
        </div>
        <p className="mt-6.5 text-center text-[13.5px] text-site-muted">
          Early-access pricing, locked in for your first year. Cancel anytime.
        </p>
      </div>

      <Section tinted>
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

      <AccessSection sourcePath="/pricing" />
    </>
  );
}
