import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { AccessSection } from "@/components/site/access-form";
import { PrimaryButton, SecondaryButton } from "@/components/site/button";
import { SpeechBubble } from "@/components/site/speech-bubble";
import {
  Eyebrow,
  Lede,
  PageHeading,
  Section,
  SectionHeading,
} from "@/components/site/section";
import { HOME_STAGES } from "@/lib/site/content/home";
import { INDUSTRY_CONTENT } from "@/lib/site/content/industries";
import { INDUSTRIES, type IndustrySlug } from "@/lib/site/routes";

/**
 * The four vertical pages.
 *
 * One template, because they differ only in copy. `generateStaticParams`
 * prerenders exactly the four in `INDUSTRIES`; `resolve` below 404s anything
 * else, so `/for/dentists` is a genuine miss rather than an empty template.
 */

interface Params {
  params: Promise<{ industry: string }>;
}

export function generateStaticParams() {
  return INDUSTRIES.map((industry) => ({ industry: industry.slug }));
}

function resolve(slug: string): IndustrySlug {
  const match = INDUSTRIES.find((industry) => industry.slug === slug);
  if (!match) notFound();
  return match.slug;
}

export async function generateMetadata({ params }: Params): Promise<Metadata> {
  const { industry } = await params;
  const slug = resolve(industry);
  const content = INDUSTRY_CONTENT[slug];
  const label = INDUSTRIES.find((entry) => entry.slug === slug)!.label;

  return {
    title: `Lia for ${label.toLowerCase()}`,
    description: content.metaDescription,
  };
}

export default async function IndustryPage({ params }: Params) {
  const { industry } = await params;
  const slug = resolve(industry);
  const content = INDUSTRY_CONTENT[slug];
  const label = INDUSTRIES.find((entry) => entry.slug === slug)!.label;

  return (
    <>
      <header className="relative mx-auto w-full max-w-[1200px] px-[clamp(24px,6vw,106px)] pt-[clamp(48px,8vw,108px)] pb-[clamp(28px,4vw,48px)]">
        <SpeechBubble
          quote={content.quote.text}
          attribution={content.quote.attribution}
          tone="blue"
          float="a"
          className="pointer-events-none absolute top-1/2 right-[clamp(10px,3vw,40px)] hidden w-[196px] -translate-y-1/2 lg:block"
        />

        <Eyebrow>Lia for {label.toLowerCase()}</Eyebrow>
        <PageHeading className="mb-6 max-w-[620px]">
          {content.heading}
        </PageHeading>
        <Lede className="mb-8 max-w-[580px]">{content.lede}</Lede>
        <div className="flex flex-wrap gap-3">
          <PrimaryButton href="#access">Request early access</PrimaryButton>
          <SecondaryButton href="/pricing">See pricing</SecondaryButton>
        </div>
      </header>

      <Section tinted>
        <SectionHeading className="mb-[clamp(28px,4vw,48px)] max-w-[560px]">
          What makes this different from any other inbox.
        </SectionHeading>
        <div className="grid grid-cols-1 gap-7 md:grid-cols-3">
          {content.pressures.map((pressure) => (
            <div
              key={pressure.title}
              className="rounded-[18px] border border-site-border bg-white p-6"
            >
              <h3 className="mb-2.5 text-[16px] font-semibold text-site-ink">
                {pressure.title}
              </h3>
              <p className="text-[14.5px] leading-[1.6] text-site-body">
                {pressure.body}
              </p>
            </div>
          ))}
        </div>
      </Section>

      <Section>
        <SectionHeading className="mb-[clamp(28px,4vw,44px)] max-w-[560px]">
          The same six stages, whatever you run.
        </SectionHeading>
        <ol className="grid grid-cols-1 gap-x-[clamp(24px,4vw,56px)] gap-y-8 sm:grid-cols-2 lg:grid-cols-3">
          {HOME_STAGES.map((stage, index) => (
            <li key={stage.name}>
              <span className="mb-2.5 inline-flex size-7 items-center justify-center rounded-full bg-site-tint text-[12.5px] font-semibold text-site-blue ring-1 ring-site-blue-edge">
                {index + 1}
              </span>
              <h3 className="mb-1.5 text-[16px] font-semibold text-site-ink">
                {stage.name}
              </h3>
              <p className="text-[14.5px] leading-[1.6] text-site-body">
                {stage.description}
              </p>
            </li>
          ))}
        </ol>
      </Section>

      <AccessSection industry={slug} sourcePath={`/for/${slug}`} />
    </>
  );
}
