import type { Metadata } from "next";
import { AccessSection } from "@/components/site/access-form";
import {
  Eyebrow,
  Lede,
  PageHeading,
  Section,
  SectionHeading,
} from "@/components/site/section";
import {
  PLATFORM_ROWS,
  PUBLISHING_LABELS,
  PUBLISHING_NOTES,
  type Publishing,
} from "@/lib/site/content/platforms";

export const metadata: Metadata = {
  title: "Platforms",
  description:
    "Where Lia reads, where it can publish for you, and where it hands you a draft to post yourself.",
};

// The design reference badged "direct" publishing in green, but the site-*
// palette (src/app/globals.css) has no success/green hue of its own — only
// ink, body, muted, border, field, tint, orange, blue, and amber. Rather than
// hand-write a hex literal outside that palette, "direct" reuses the amber
// tokens (the tone already carrying positive/affirmative weight elsewhere on
// this page's speech bubbles), which keeps it visually distinct from
// "manual" (blue) and "monitor" (neutral) without inventing a colour.
const BADGE: Record<Publishing, string> = {
  direct: "bg-site-amber-tint text-site-amber-ink ring-site-amber-edge",
  manual: "bg-site-blue-tint text-site-blue-ink ring-site-blue-edge",
  monitor: "bg-site-tint text-site-muted ring-site-border",
};

export default function PlatformsPage() {
  return (
    <>
      <header className="mx-auto w-full max-w-[1200px] px-[clamp(24px,6vw,106px)] pt-[clamp(48px,8vw,108px)] pb-[clamp(28px,4vw,48px)]">
        <Eyebrow>Platforms</Eyebrow>
        <PageHeading className="mb-6 max-w-[620px]">
          Every source, and exactly what we can do with it.
        </PageHeading>
        <Lede className="max-w-[620px]">
          Some platforms let software post a reply. Most do not. Lia tells you
          which is which up front rather than showing you a button that quietly
          fails.
        </Lede>
      </header>

      <div className="mx-auto w-full max-w-[1200px] px-[clamp(24px,6vw,106px)] pb-[clamp(40px,5vw,56px)]">
        <div className="overflow-x-auto rounded-[18px] border border-site-border">
          <table className="w-full min-w-[640px] border-collapse text-left">
            <caption className="sr-only">
              Supported platforms and how responses reach them
            </caption>
            <thead>
              <tr className="border-b border-site-border bg-site-tint">
                <th
                  scope="col"
                  className="px-6 py-4 text-[12px] font-semibold tracking-[0.08em] text-site-muted uppercase"
                >
                  Platform
                </th>
                <th
                  scope="col"
                  className="px-6 py-4 text-[12px] font-semibold tracking-[0.08em] text-site-muted uppercase"
                >
                  What Lia does
                </th>
                <th
                  scope="col"
                  className="px-6 py-4 text-[12px] font-semibold tracking-[0.08em] text-site-muted uppercase"
                >
                  Responses
                </th>
              </tr>
            </thead>
            <tbody>
              {PLATFORM_ROWS.map((row) => (
                <tr
                  key={row.name}
                  className="border-b border-site-border last:border-0"
                >
                  <th
                    scope="row"
                    className="px-6 py-5 align-top text-[15px] font-semibold text-site-ink"
                  >
                    {row.name}
                  </th>
                  <td className="max-w-[420px] px-6 py-5 align-top text-[14.5px] leading-[1.6] text-site-body">
                    {row.note}
                  </td>
                  <td className="px-6 py-5 align-top">
                    <span
                      className={`inline-block rounded-full px-3 py-1 text-[12.5px] font-semibold whitespace-nowrap ring-1 ${BADGE[row.publishing]}`}
                    >
                      {PUBLISHING_LABELS[row.publishing]}
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Section tinted>
        <SectionHeading className="mb-[clamp(28px,4vw,44px)] max-w-[620px]">
          What those three answers mean.
        </SectionHeading>
        <dl className="grid grid-cols-1 gap-7 md:grid-cols-3">
          {(["direct", "manual", "monitor"] as const).map((mode) => (
            <div key={mode}>
              <dt className="mb-2 text-[16px] font-semibold text-site-ink">
                {PUBLISHING_LABELS[mode]}
              </dt>
              <dd className="text-[14.5px] leading-[1.6] text-site-body">
                {PUBLISHING_NOTES[mode]}
              </dd>
            </div>
          ))}
        </dl>
      </Section>

      <AccessSection sourcePath="/platforms" />
    </>
  );
}
