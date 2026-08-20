"use client";

import { useRef } from "react";
import { useWidgetFrameHeight } from "@/components/integrations/use-widget-frame-height";
import { cn } from "@/lib/cn";
import type { ReviewWidgetTheme } from "@/domain";

/**
 * What the widget looks like, shown to somebody who has nothing to configure.
 *
 * The empty state's job is to explain why connecting a location is worth
 * doing, and no paragraph does that as well as the card itself does. Both
 * themes are drawn at once rather than behind a toggle: a person with no
 * widget yet has not chosen a theme, and the question they are actually asking
 * — "will this look right on my site?" — is answered by seeing both.
 *
 * The frames point at the same route the live preview uses, in its `sample`
 * mode. That is the point: the teaser is rendered by the code that renders the
 * real embed, so it cannot show a card the product does not ship. See
 * `@/lib/widgets/sample` for why the review inside it is invented and why that
 * is stated on screen rather than left to be worked out.
 */

const THEMES: ReadonlyArray<{ theme: ReviewWidgetTheme; label: string }> = [
  { theme: "light", label: "Light theme" },
  { theme: "dark", label: "Dark theme" },
];

export function ReviewWidgetTeaser() {
  return (
    <div>
      <div className="grid gap-4 lg:grid-cols-2">
        {THEMES.map((option) => (
          <TeaserFrame key={option.theme} theme={option.theme} label={option.label} />
        ))}
      </div>

      {/*
        Said plainly, and not in small print. A fabricated review that somebody
        took for one of their own — even briefly, even here — would undo the
        care the rest of this feature takes with real ones.
      */}
      <p className="mt-3 text-[12.5px] text-gray-500">
        The review above is an example, written by us. Once a location is
        connected, its own Google reviews appear here instead.
      </p>
    </div>
  );
}

function TeaserFrame({
  theme,
  label,
}: {
  theme: ReviewWidgetTheme;
  label: string;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const { height, onFrameLoad } = useWidgetFrameHeight(frameRef, 260);

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
          src={`/embed/review-widget/preview?sample=1&theme=${theme}`}
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
