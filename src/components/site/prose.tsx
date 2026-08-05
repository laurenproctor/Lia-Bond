import { Eyebrow, PageHeading } from "@/components/site/section";

export interface LegalSection {
  heading: string;
  paragraphs: readonly string[];
}

/**
 * The shared shell for privacy and terms.
 *
 * A narrow measure and no illustration: these pages are read, not scanned, and
 * the speech bubbles that carry the rest of the site would be flippant here.
 */
export function LegalPage({
  eyebrow,
  title,
  updated,
  intro,
  sections,
}: {
  eyebrow: string;
  title: string;
  /** ISO date, rendered as written. */
  updated: string;
  intro: string;
  sections: readonly LegalSection[];
}) {
  return (
    <div className="mx-auto w-full max-w-[1200px] px-[clamp(24px,6vw,106px)] pt-[clamp(48px,8vw,96px)] pb-[clamp(56px,8vw,110px)]">
      <div className="max-w-[720px]">
        <Eyebrow>{eyebrow}</Eyebrow>
        <PageHeading className="mb-5 text-[clamp(32px,4vw,48px)]!">
          {title}
        </PageHeading>
        <p className="mb-8 text-[13px] text-site-muted">
          Last updated {updated}
        </p>
        <p className="mb-10 text-[17px] leading-[1.65] text-site-body">
          {intro}
        </p>

        {sections.map((section) => (
          <section key={section.heading} className="mb-9">
            <h2 className="mb-3 text-[19px] font-semibold text-site-ink">
              {section.heading}
            </h2>
            {section.paragraphs.map((paragraph) => (
              <p
                key={paragraph.slice(0, 32)}
                className="mb-3.5 text-[15.5px] leading-[1.68] text-site-body"
              >
                {paragraph}
              </p>
            ))}
          </section>
        ))}
      </div>
    </div>
  );
}
