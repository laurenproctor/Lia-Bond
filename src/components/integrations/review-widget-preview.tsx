"use client";

import { useRef, useState } from "react";
import { Monitor, Smartphone } from "lucide-react";
import { ReviewWidgetLayoutCarousel } from "@/components/integrations/review-widget-layout-carousel";
import { useWidgetFrameHeight } from "@/components/integrations/use-widget-frame-height";
import { cn } from "@/lib/cn";
import type { ReviewWidgetLayout, ReviewWidgetTheme } from "@/domain";

/**
 * The widget, rendered exactly as a website visitor will see it.
 *
 * An iframe pointed at `/embed/review-widget/preview`, which returns the same
 * document the public embed does — not a React re-creation of it. A
 * re-creation would be easier to build and would be a different program: it
 * would drift the first time somebody adjusted a padding in one and not the
 * other, and the whole promise of a preview is that it does not.
 *
 * Two widths rather than a resizable frame. "Desktop" and "mobile" are the two
 * questions a customer actually has, and a drag handle invites them to spend
 * time on widths their website does not have.
 *
 * **Only the first slide is their widget.** The photo and video layouts are
 * drawn from `@/lib/widgets/sample` — the same invented review the empty state
 * shows — because Google sends no review photographs and no review video, so
 * there is nothing of this customer's to put in them. Pairing their genuine
 * review with invented pictures would be the one arrangement somebody could
 * reasonably read as a promise about their own feed, so the media slides drop
 * the real review entirely rather than half-keeping it, and say so underneath.
 */

const WIDTHS = {
  desktop: { label: "Desktop", width: "100%", icon: Monitor },
  mobile: { label: "Mobile", width: "380px", icon: Smartphone },
} as const;

type WidthKey = keyof typeof WIDTHS;

export interface ReviewWidgetPreviewProps {
  /** Built by the configurator from the current, possibly unsaved, form state. */
  src: string;
  /** Dark previews sit on a dark backdrop, as they would on the real site. */
  theme: ReviewWidgetTheme;
}

export function ReviewWidgetPreview({ src, theme }: ReviewWidgetPreviewProps) {
  const [width, setWidth] = useState<WidthKey>("desktop");

  return (
    <ReviewWidgetLayoutCarousel
      unavailableNote="Example content — not your reviews, and not embeddable yet."
      toolbar={<WidthToggle width={width} onChange={setWidth} />}
    >
      {(slide) => (
        <PreviewFrame
          src={slide.available ? src : sampleSrc(slide.layout, theme)}
          theme={theme}
          width={width}
        />
      )}
    </ReviewWidgetLayoutCarousel>
  );
}

/**
 * The sample document, at the theme the customer has actually chosen.
 *
 * The theme carries across even though the review does not, because it is the
 * one setting on this screen a media layout can honour honestly: it is the
 * customer's decision, it is not review data, and previewing a photo card in
 * light while the widget beside it is dark would be a difference nobody could
 * account for.
 */
function sampleSrc(layout: ReviewWidgetLayout, theme: ReviewWidgetTheme): string {
  return `/embed/review-widget/preview?sample=1&theme=${theme}&layout=${layout}`;
}

function WidthToggle({
  width,
  onChange,
}: {
  width: WidthKey;
  onChange: (next: WidthKey) => void;
}) {
  return (
    <div
      className="inline-flex rounded-lg border border-gray-300 p-0.5"
      role="group"
      aria-label="Preview width"
    >
      {(Object.keys(WIDTHS) as WidthKey[]).map((key) => {
        const option = WIDTHS[key];
        const Icon = option.icon;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            aria-pressed={width === key}
            className={cn(
              "inline-flex h-7 items-center gap-1.5 rounded-md px-2.5 text-[12.5px] font-medium transition-colors",
              width === key
                ? "bg-gray-100 text-gray-950"
                : "text-gray-500 hover:text-gray-950",
            )}
          >
            <Icon className="size-3.5" aria-hidden />
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

function PreviewFrame({
  src,
  theme,
  width,
}: {
  src: string;
  theme: ReviewWidgetTheme;
  width: WidthKey;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const { height, onFrameLoad } = useWidgetFrameHeight(frameRef);

  return (
    // The backdrop is part of the preview, not decoration. A dark card on a
    // white product surface looks wrong in a way it will not look on the
    // customer's own dark page, and somebody would change their theme to fix a
    // problem that does not exist.
    <div
      className={cn(
        "flex justify-center rounded-xl border p-5 transition-colors",
        theme === "dark" ? "border-navy-900 bg-navy-950" : "border-gray-200 bg-gray-50",
      )}
    >
      <div style={{ width: WIDTHS[width].width, maxWidth: "100%" }}>
        <iframe
          ref={frameRef}
          // Keyed by src so a theme or layout change reloads rather than
          // leaving the previous document up while the new one fetches.
          key={src}
          src={src}
          title="Widget preview"
          onLoad={onFrameLoad}
          className="block w-full border-0"
          style={{ height }}
        />
      </div>
    </div>
  );
}
