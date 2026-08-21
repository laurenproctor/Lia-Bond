"use client";

import { useRef } from "react";
import { ReviewWidgetLayoutCarousel } from "@/components/integrations/review-widget-layout-carousel";
import { useWidgetFrameHeight } from "@/components/integrations/use-widget-frame-height";
import { cn } from "@/lib/cn";
import type { ReviewWidgetLayout, ReviewWidgetTheme } from "@/domain";

/**
 * What the widget looks like, shown to somebody who has nothing to configure.
 *
 * The empty state's job is to explain why connecting a location is worth
 * doing, and no paragraph does that as well as the card itself does. Both
 * themes are drawn at once rather than behind a toggle: a person with no
 * widget yet has not chosen a theme, and the question they are actually asking
 * — "will this look right on my site?" — is answered by seeing both.
 *
 * The layouts, by contrast, are behind a carousel. Six cards at once is a
 * specimen sheet; the question "what are the arrangements" is answered by
 * looking at one at a time, and the theme pair is what has to stay side by
 * side because comparing them *is* the question.
 *
 * The frames point at the same route the live preview uses, in its `sample`
 * mode. That is the point: the teaser is rendered by the code that renders the
 * real embed, so it cannot show a card the product does not ship. See
 * `@/lib/widgets/sample` for why the review inside it is invented, why the
 * pictures are drawings rather than photographs, and why both are stated on
 * screen rather than left to be worked out.
 */

const THEMES: ReadonlyArray<{ theme: ReviewWidgetTheme; label: string }> = [
  { theme: "light", label: "Light theme" },
  { theme: "dark", label: "Dark theme" },
];

export function ReviewWidgetTeaser() {
  return (
    <div>
      <ReviewWidgetLayoutCarousel unavailableNote="Not available to embed yet.">
        {(slide) => (
          <div className="grid gap-4 lg:grid-cols-2">
            {THEMES.map((option) => (
              <TeaserFrame
                key={`${slide.layout}-${option.theme}`}
                layout={slide.layout}
                theme={option.theme}
                label={option.label}
              />
            ))}
          </div>
        )}
      </ReviewWidgetLayoutCarousel>

      {/*
        Said plainly, and not in small print. A fabricated review that somebody
        took for one of their own — even briefly, even here — would undo the
        care the rest of this feature takes with real ones. The second sentence
        carries more weight than the first now that two of the three layouts
        are pictures: Google sends Lia no review photographs and no review
        video, and somebody who assumed otherwise from this screen would be
        planning around a feed that does not exist.
      */}
      <p className="mt-4 text-[12.5px] leading-relaxed text-gray-500">
        The review above is an example, written by us, and the pictures are
        illustrations rather than photographs. Once a location is connected, its
        own Google reviews appear here instead — Google does not send review
        photos or video, so the photo and video layouts stay examples until you
        can supply your own media.
      </p>
    </div>
  );
}

function TeaserFrame({
  layout,
  theme,
  label,
}: {
  layout: ReviewWidgetLayout;
  theme: ReviewWidgetTheme;
  label: string;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const { height, onFrameLoad } = useWidgetFrameHeight(frameRef, {
    kind: "review",
    initialHeight: 260,
  });

  return (
    <figure className="m-0">
      {/*
        The backdrop stands in for the customer's page, as it does in the live
        preview: a dark card floating on a white product surface reads as a
        mistake rather than as the option it is.
      */}
      <div
        className={cn(
          "rounded-xl border p-5",
          theme === "dark"
            ? "border-navy-900 bg-navy-950"
            : "border-gray-200 bg-gray-50",
        )}
      >
        <iframe
          ref={frameRef}
          src={`/embed/review-widget/preview?sample=1&theme=${theme}&layout=${layout}`}
          title={`Example widget, ${label.toLowerCase()}`}
          onLoad={onFrameLoad}
          className="block w-full border-0"
          style={{ height }}
        />
      </div>
      <figcaption className="mt-2 text-[12.5px] text-gray-500">{label}</figcaption>
    </figure>
  );
}
