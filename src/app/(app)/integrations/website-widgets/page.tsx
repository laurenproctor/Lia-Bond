import type { Metadata } from "next";
import { Globe, Palette, RefreshCw, ShieldCheck } from "lucide-react";
import { PageBody } from "@/components/shell/app-shell";
import { WebsiteWidgetSampleCard } from "@/components/integrations/website-widget-sample-card";
import { PageHeader } from "@/components/ui/page-header";

export const metadata: Metadata = { title: "Website widgets" };

/**
 * Choosing between the two things Lia can put on a customer's website.
 *
 * A landing route rather than a tab on either configurator, because the
 * question it answers comes *before* configuration: a person arriving from the
 * sidebar or the integrations screen does not yet know that Lia publishes two
 * different embeds, and putting one of the configurators here would make that
 * one the product and the other a link somebody might not notice.
 *
 * **It reads no tenant data at all.** No organization context, no locations,
 * no mentions, no widget rows — so it is fast, cacheable, and shown identically
 * to every member of every organization, including the ones who will never
 * hold `website_widget.manage`. Its two samples are invented and are rendered
 * by the two real renderers through each widget's own
 * `/embed/…/preview?sample=1` branch, which answers
 * before organization context is resolved for the same reason.
 *
 * The deliberate consequence is that this page cannot say "you have a review
 * widget already". That belongs on the screens that know — the configurators
 * themselves and the integrations entry card — and buying the sentence here
 * would cost the page its independence from tenancy for very little.
 *
 * `/integrations/review-widget` keeps working untouched. Saved links, pasted
 * URLs, and the audit trail's references all still resolve; this route is a
 * new front door, not a redirect.
 */
export default function WebsiteWidgetsPage() {
  return (
    <PageBody>
      <PageHeader
        title="Website widgets"
        description="Turn the reputation Lia monitors into credible proof on your website."
      />

      {/*
        Two equal columns on desktop, stacked below. `items-stretch` is what
        makes them the same height when one sample measures taller than the
        other — the alternative is two cards whose calls to action sit at
        different heights, which reads as one being the primary choice.
      */}
      <div className="grid items-stretch gap-4 lg:grid-cols-2">
        <WebsiteWidgetSampleCard
          kind="review"
          title="Review widget"
          description="Show one recent Google review for a location. Lia keeps it current and stops showing it when it no longer qualifies."
          sampleSrc="/embed/review-widget/preview?sample=1"
          sampleNote="The review above is an example, written by us. Once a location is connected, its own Google reviews appear here instead."
          ctaLabel="Set up review widget"
          ctaHref="/integrations/review-widget"
          initialHeight={260}
        />

        <WebsiteWidgetSampleCard
          kind="press"
          title="Recent press widget"
          description="Show your latest earned-media coverage with publication logos, headlines, dates, and links to the original stories."
          sampleSrc="/embed/press-widget/preview?sample=1"
          sampleNote="The three publications above are invented, and so is their coverage. Your own widget shows the articles Lia has actually found."
          ctaLabel="Set up press widget"
          ctaHref="/integrations/press-widget"
          initialHeight={430}
        />
      </div>

      <SharedCapabilities />
    </PageBody>
  );
}

/**
 * What both widgets do, said once.
 *
 * Restrained on purpose: four short facts in a row, not a feature grid with
 * icons the size of the samples above them. Everything here is true of both
 * products, which is exactly why it is below the cards rather than repeated
 * inside each of them — a line that appears twice reads as a difference until
 * you check that it is not.
 */
const SHARED = [
  { icon: Palette, label: "Light and dark themes" },
  { icon: Globe, label: "Responsive on any screen" },
  { icon: ShieldCheck, label: "Approved-domain controls" },
  { icon: RefreshCw, label: "Automatically stays current" },
] as const;

function SharedCapabilities() {
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-5 py-4">
      <h2 className="text-[13px] font-semibold text-gray-950">Both widgets</h2>
      <ul className="mt-2.5 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-4">
        {SHARED.map((item) => {
          const Icon = item.icon;
          return (
            <li key={item.label} className="flex items-center gap-2 text-[12.5px] text-gray-700">
              <Icon className="size-3.5 shrink-0 text-gray-500" aria-hidden />
              {item.label}
            </li>
          );
        })}
      </ul>
      <p className="mt-3 text-[12.5px] text-gray-500">
        Both are copy-and-paste embed codes that work in any website builder
        accepting HTML. Neither adds a third-party request to your page.
      </p>
    </div>
  );
}
