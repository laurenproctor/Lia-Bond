import type { Metadata } from "next";
import { AccessSection } from "@/components/site/access-form";
import {
  Eyebrow,
  Lede,
  PageHeading,
  Section,
} from "@/components/site/section";

export const metadata: Metadata = {
  title: "Contact",
  description: "How to reach Lia about early access, support, or press.",
};

const CHANNELS = [
  {
    heading: "Early access",
    body: "Use the form below. We reply to every request, usually within a working day, and we will tell you plainly if you are not a fit yet.",
  },
  {
    heading: "Existing customers",
    body: "Use the help form inside the app — it arrives with your organization and role attached, which saves a round trip.",
  },
  {
    heading: "Press and partnerships",
    body: "Send the form below with a line about what you are working on and we will route it to the right person.",
  },
] as const;

export default function ContactPage() {
  return (
    <>
      <header className="mx-auto w-full max-w-[1200px] px-[clamp(24px,6vw,106px)] pt-[clamp(48px,8vw,108px)] pb-[clamp(28px,4vw,48px)]">
        <Eyebrow>Contact</Eyebrow>
        <PageHeading className="mb-6 max-w-[560px]">
          Talk to a person about it.
        </PageHeading>
        <Lede className="max-w-[560px]">
          Lia is a small team. Whichever route you take below reaches someone who
          works on the product.
        </Lede>
      </header>

      <Section tinted>
        <div className="grid grid-cols-1 gap-7 md:grid-cols-3">
          {CHANNELS.map((channel) => (
            <div
              key={channel.heading}
              className="rounded-[18px] border border-site-border bg-white p-6"
            >
              <h2 className="mb-2.5 text-[16px] font-semibold text-site-ink">
                {channel.heading}
              </h2>
              <p className="text-[14.5px] leading-[1.6] text-site-body">
                {channel.body}
              </p>
            </div>
          ))}
        </div>
      </Section>

      <AccessSection sourcePath="/contact" />
    </>
  );
}
