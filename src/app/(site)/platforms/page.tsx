import type { Metadata } from "next";
import { ClosingCta } from "@/components/site/closing-cta";
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
  UNAVAILABLE_LABEL,
  UNAVAILABLE_NOTE,
  type Publishing,
} from "@/lib/site/content/platforms";

export const metadata: Metadata = {
  title: "Platforms",
  description:
    "Where Lia reads, and exactly how a reply reaches each platform — drafted for you to send, or nothing to reply to at all.",
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

// An unavailable platform is an absence rather than a warning, so it takes the
// same neutral tokens as "monitor" rather than the amber ones. Nothing on this
// page should read as an alarm; the row simply does not offer an answer yet.
const UNAVAILABLE_BADGE = "bg-site-tint text-site-muted ring-site-border";

/**
 * The publishing modes the table actually uses, in a stable display order.
 *
 * Derived rather than listed so the legend below can only ever explain an
 * answer some row gives.
 */
const MODE_ORDER: readonly Publishing[] = ["direct", "manual", "monitor"];
const PUBLISHING_MODES_IN_USE = MODE_ORDER.filter((mode) =>
  PLATFORM_ROWS.some((row) => row.available && row.publishing === mode),
);

/*
 * Whether any row is switched off, which decides if the legend explains what
 * "Not available" means. Derived for the same reason the modes above are: an
 * explanation for a state no row is in reads as a state some row might be.
 */
const HAS_UNAVAILABLE = PLATFORM_ROWS.some((row) => !row.available);

export default function PlatformsPage() {
  return (
    <>
      <header className="mx-auto w-full max-w-[1200px] px-[clamp(24px,6vw,106px)] pt-[clamp(48px,8vw,108px)] pb-[clamp(28px,4vw,48px)]">
        <Eyebrow>Platforms</Eyebrow>
        <PageHeading className="mb-6 max-w-[620px]">
          Every source, and exactly what we can do with it.
        </PageHeading>
        <Lede className="max-w-[620px]">
          Not every platform lets software post a reply back. Lia tells you
          exactly how each one works — copied for you to send, or nothing to
          reply to at all — rather than showing you a button that quietly
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
                    className={`px-6 py-5 align-top text-[15px] font-semibold ${
                      row.available ? "text-site-ink" : "text-site-muted"
                    }`}
                  >
                    {row.name}
                  </th>
                  <td className="max-w-[420px] px-6 py-5 align-top text-[14.5px] leading-[1.6] text-site-body">
                    {row.note}
                  </td>
                  <td className="px-6 py-5 align-top">
                    {/*
                      An unavailable platform shows no publishing answer at
                      all. Rendering its `publishing` mode here would promise
                      the reply route it will have one day as though it had it
                      now, which is the exact overclaim this table exists to
                      prevent.
                    */}
                    <span
                      className={`inline-block rounded-full px-3 py-1 text-[12.5px] font-semibold whitespace-nowrap ring-1 ${
                        row.available
                          ? BADGE[row.publishing]
                          : UNAVAILABLE_BADGE
                      }`}
                    >
                      {row.available
                        ? PUBLISHING_LABELS[row.publishing]
                        : UNAVAILABLE_LABEL}
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
          What those answers mean.
        </SectionHeading>
        {/*
          Derived from the rows rather than hard-coded, so this can only ever
          explain an answer the table actually gives. Hard-coding all three
          modes meant the page described "Publish from Lia" while no platform
          offered it — the same overclaim the table itself was corrected for,
          moved one section down. When direct publishing ships, adding it to a
          row brings its explanation back automatically.
        */}
        <dl className="grid grid-cols-1 gap-7 md:grid-cols-3">
          {PUBLISHING_MODES_IN_USE.map((mode) => (
            <div key={mode}>
              <dt className="mb-2 text-[16px] font-semibold text-site-ink">
                {PUBLISHING_LABELS[mode]}
              </dt>
              <dd className="text-[14.5px] leading-[1.6] text-site-body">
                {PUBLISHING_NOTES[mode]}
              </dd>
            </div>
          ))}
          {HAS_UNAVAILABLE && (
            <div>
              <dt className="mb-2 text-[16px] font-semibold text-site-ink">
                {UNAVAILABLE_LABEL}
              </dt>
              <dd className="text-[14.5px] leading-[1.6] text-site-body">
                {UNAVAILABLE_NOTE}
              </dd>
            </div>
          )}
        </dl>
      </Section>

      <ClosingCta />
    </>
  );
}
