"use client";

import { useRef, useState } from "react";
import { ArrowRight, Moon, Sun } from "lucide-react";
import Link from "next/link";
import { useWidgetFrameHeight } from "@/components/integrations/use-widget-frame-height";
import { cn } from "@/lib/cn";
import type { WebsiteWidgetTheme } from "@/domain";
import type { WidgetKind } from "@/lib/widgets/kinds";

/**
 * One of the two product cards on the Website widgets landing page.
 *
 * Its whole job is to answer "which of these two do I want" in under five
 * seconds, and the thing that answers it is the widget itself. So the card
 * frames the real preview route in its sample mode — the same document a
 * customer's website will get, drawn by the same renderer — rather than a
 * screenshot or a hand-built imitation in React.
 *
 * That choice costs a little: two iframes on one page, each measuring and
 * posting its height. It buys the property that makes the page worth having,
 * which is that neither sample can ever show a card the product does not
 * ship. A screenshot goes stale silently the first time a padding changes; a
 * React imitation goes stale the same way and is harder to notice.
 *
 * **The theme control changes the sample and nothing else.** It is not a
 * setting: nothing is saved, nothing is previewed against tenant data, and the
 * customer's own theme is chosen on the configuration screen this card links
 * to. It is here because "will this look right on my site" is the second
 * question after "which one is it", and both samples answer it in one click.
 *
 * The two cards are separate instances of this component rather than two
 * bespoke ones, because they differ only in their copy, their route, and which
 * widget's height messages they listen for — and a page whose two halves were
 * built twice would be a page where one half drifts.
 */

export interface WebsiteWidgetSampleCardProps {
  kind: WidgetKind;
  title: string;
  description: string;
  /** The sample preview route, without the theme parameter. */
  sampleSrc: string;
  ctaLabel: string;
  ctaHref: string;
  /** Said under the sample, plainly. Never in small print. */
  sampleNote: string;
  /** Roughly what the sample measures, so the card does not jump on load. */
  initialHeight: number;
}

export function WebsiteWidgetSampleCard({
  kind,
  title,
  description,
  sampleSrc,
  ctaLabel,
  ctaHref,
  sampleNote,
  initialHeight,
}: WebsiteWidgetSampleCardProps) {
  const [theme, setTheme] = useState<WebsiteWidgetTheme>("light");
  const frameRef = useRef<HTMLIFrameElement>(null);
  const { height, onFrameLoad } = useWidgetFrameHeight(frameRef, {
    kind,
    initialHeight,
  });

  const src = `${sampleSrc}${sampleSrc.includes("?") ? "&" : "?"}theme=${theme}`;

  return (
    <section
      aria-labelledby={`${kind}-widget-card`}
      className="flex flex-col rounded-xl border border-gray-200 bg-white p-5"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2
            id={`${kind}-widget-card`}
            className="text-[15px] font-semibold text-gray-950"
          >
            {title}
          </h2>
          <p className="mt-1 max-w-prose text-[13px] text-gray-700">{description}</p>
        </div>

        <div
          className="inline-flex shrink-0 rounded-lg border border-gray-300 p-0.5"
          role="group"
          aria-label={`${title} example theme`}
        >
          {(["light", "dark"] as const).map((option) => {
            const Icon = option === "light" ? Sun : Moon;
            return (
              <button
                key={option}
                type="button"
                onClick={() => setTheme(option)}
                aria-pressed={theme === option}
                className={cn(
                  "inline-flex size-7 items-center justify-center rounded-md transition-colors",
                  theme === option
                    ? "bg-gray-100 text-gray-950"
                    : "text-gray-500 hover:text-gray-950",
                )}
              >
                <Icon className="size-3.5" aria-hidden />
                <span className="sr-only">{option} theme</span>
              </button>
            );
          })}
        </div>
      </div>

      {/*
        The backdrop stands in for the customer's page, as it does in both live
        previews: a dark card floating on a white product surface reads as a
        mistake rather than as the option it is.
      */}
      {/*
        `flex-1` with the frame centred, rather than a backdrop that hugs its
        content. The two cards are the same height by design, and the two
        samples are not — a three-story press strip is roughly half again as
        tall as a review card. Without this the shorter card carries a band of
        dead space above its call to action, which reads as a layout bug rather
        than as the deliberate equal-height row it is.
      */}
      <div
        className={cn(
          "mt-4 flex flex-1 items-center rounded-xl border p-4 transition-colors",
          theme === "dark" ? "border-navy-900 bg-navy-950" : "border-gray-200 bg-gray-50",
        )}
      >
        <iframe
          ref={frameRef}
          key={src}
          src={src}
          title={`${title} example, ${theme} theme`}
          onLoad={onFrameLoad}
          className="block w-full self-center border-0"
          style={{ height }}
        />
      </div>

      {/*
        Said plainly, and not in small print. An invented review or an invented
        publication that somebody took for real — even briefly, even here —
        would undo the care the rest of this feature takes with the genuine
        article.
      */}
      <p className="mt-3 text-[12.5px] text-gray-500">{sampleNote}</p>

      {/* `mt-auto` rather than a fixed height: the two cards sit in one grid
          row, their samples measure to different heights, and the calls to
          action have to line up at the bottom regardless. */}
      <div className="mt-auto pt-4">
        <Link
          href={ctaHref}
          className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg bg-purple-600 px-3 text-[13px] font-medium whitespace-nowrap text-white transition-colors hover:bg-purple-700 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-600"
        >
          {ctaLabel}
          <ArrowRight className="size-4 shrink-0" aria-hidden />
        </Link>
      </div>
    </section>
  );
}
