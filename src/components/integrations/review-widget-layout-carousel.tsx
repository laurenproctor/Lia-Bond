"use client";

import { useCallback, useId, useState, type ReactNode } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { cn } from "@/lib/cn";
import {
  REVIEW_WIDGET_LAYOUTS,
  SAVABLE_REVIEW_WIDGET_LAYOUTS,
  type ReviewWidgetLayout,
} from "@/domain";

/**
 * The three arrangements of the review card, one at a time.
 *
 * Both screens that show the widget show all three now — the empty state,
 * where the question is "what is this feature", and the configuration screen,
 * where it is "what are my options". A carousel rather than three cards side
 * by side because the widget is wide: three of them at once are three
 * thumbnails, and a thumbnail of a layout is exactly the thing a preview
 * exists to avoid being.
 *
 * **It is a shell, not a viewer.** It owns which layout is showing and the
 * controls for changing it, and knows nothing about iframes, themes or widths.
 * The two callers frame their own documents — the teaser draws a light and a
 * dark card per slide, the configuration preview draws one at a chosen width —
 * and neither could be expressed as a variation of the other without a prop
 * that means "which of my two callers am I".
 *
 * One slide is mounted at a time rather than all three hidden with CSS: each
 * slide is one or two iframes, and three simultaneous documents measuring and
 * posting their heights to the same parent is a race for no benefit.
 */

export interface WidgetLayoutSlide {
  layout: ReviewWidgetLayout;
  /** The control's label. Sentence case, like the rest of the interface. */
  label: string;
  /** What this arrangement is, in one line, under the card. */
  blurb: string;
  /**
   * Whether a customer can put this on their website today.
   *
   * Derived from `SAVABLE_REVIEW_WIDGET_LAYOUTS` rather than written down, so
   * the day media gets a real source and that list widens, every one of these
   * notices disappears on its own instead of surviving as a lie about a
   * feature that shipped.
   */
  available: boolean;
}

const LABELS: Record<ReviewWidgetLayout, { label: string; blurb: string }> = {
  single_review_text: {
    label: "Review text",
    blurb: "The words, the rating, and who wrote them.",
  },
  single_review_photo: {
    label: "With photos",
    blurb: "Up to three pictures between the review and the reviewer's name.",
  },
  single_review_video: {
    label: "With video",
    blurb: "A clip, shown as its opening frame until a visitor presses play.",
  },
};

const SAVABLE = new Set<string>(SAVABLE_REVIEW_WIDGET_LAYOUTS);

export const WIDGET_LAYOUT_SLIDES: readonly WidgetLayoutSlide[] =
  REVIEW_WIDGET_LAYOUTS.map((layout) => ({
    layout,
    ...LABELS[layout],
    available: SAVABLE.has(layout),
  }));

export interface ReviewWidgetLayoutCarouselProps {
  /** Drawn between the controls and the blurb. Called once, for the active slide. */
  children: (slide: WidgetLayoutSlide) => ReactNode;
  /**
   * Anything the caller wants beside the layout controls — the preview's
   * desktop/mobile toggle, in practice. Kept in the same row because both are
   * questions about how to look at the card rather than what the card is.
   */
  toolbar?: ReactNode;
  /**
   * What to say under a layout nobody can embed yet.
   *
   * Passed in rather than written here: the empty state and the configuration
   * screen are talking to people at different moments, and "this is coming"
   * reads differently to somebody choosing a product than to somebody who has
   * already bought it and is looking for the control.
   */
  unavailableNote: string;
}

export function ReviewWidgetLayoutCarousel({
  children,
  toolbar,
  unavailableNote,
}: ReviewWidgetLayoutCarouselProps) {
  const [index, setIndex] = useState(0);
  const slideId = useId();

  const count = WIDGET_LAYOUT_SLIDES.length;
  // Non-null: the index only ever moves through `step`, which wraps.
  const slide = WIDGET_LAYOUT_SLIDES[index] as WidgetLayoutSlide;

  // Wrapping, so neither arrow is ever disabled. A control that greys out at
  // the end of three items reads as broken more often than it reads as a
  // boundary.
  const step = useCallback(
    (delta: number) => setIndex((current) => (current + delta + count) % count),
    [count],
  );

  return (
    <div
      role="group"
      aria-roledescription="carousel"
      aria-label="Widget layouts"
      className="space-y-3"
      onKeyDown={(event) => {
        // Only when the focus is not inside a control that wants these keys
        // itself — the frame's video scrubber being the one that will.
        if (event.target !== event.currentTarget) return;
        if (event.key === "ArrowLeft") {
          event.preventDefault();
          step(-1);
        }
        if (event.key === "ArrowRight") {
          event.preventDefault();
          step(1);
        }
      }}
      tabIndex={-1}
    >
      <div className="flex flex-wrap items-center gap-3">
        <div
          className="inline-flex rounded-lg border border-gray-300 p-0.5"
          role="group"
          aria-label="Layout"
        >
          {WIDGET_LAYOUT_SLIDES.map((option, position) => (
            <button
              key={option.layout}
              type="button"
              onClick={() => setIndex(position)}
              aria-pressed={position === index}
              aria-controls={slideId}
              className={cn(
                "inline-flex h-7 items-center rounded-md px-2.5 text-[12.5px] font-medium transition-colors",
                position === index
                  ? "bg-purple-50 text-purple-800"
                  : "text-gray-500 hover:text-gray-950",
              )}
            >
              {option.label}
            </button>
          ))}
        </div>

        <div className="inline-flex items-center gap-1">
          <ArrowButton label="Previous layout" onClick={() => step(-1)}>
            <ChevronLeft className="size-4" aria-hidden />
          </ArrowButton>
          <ArrowButton label="Next layout" onClick={() => step(1)}>
            <ChevronRight className="size-4" aria-hidden />
          </ArrowButton>
        </div>

        {toolbar ? <div className="ml-auto">{toolbar}</div> : null}
      </div>

      {/*
        Polite rather than assertive, and on the slide rather than on a
        separate announcement: changing a preview is not an interruption, and a
        second live region describing the first is how a screen reader user
        hears everything twice.
      */}
      <div
        id={slideId}
        aria-live="polite"
        aria-roledescription="slide"
        aria-label={`${slide.label}, ${index + 1} of ${count}`}
      >
        {children(slide)}
      </div>

      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
        <p className="text-[12.5px] text-gray-500">{slide.blurb}</p>
        {slide.available ? null : (
          <p className="text-[12.5px] font-medium text-amber-700">{unavailableNote}</p>
        )}
      </div>
    </div>
  );
}

function ArrowButton({
  label,
  onClick,
  children,
}: {
  label: string;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="inline-flex size-7 items-center justify-center rounded-md border border-gray-300 text-gray-500 transition-colors hover:text-gray-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-600"
    >
      {children}
    </button>
  );
}
