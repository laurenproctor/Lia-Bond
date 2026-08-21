"use client";

import { useRef, useState } from "react";
import { Monitor, Smartphone } from "lucide-react";
import { useWidgetFrameHeight } from "@/components/integrations/use-widget-frame-height";
import { cn } from "@/lib/cn";

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
  theme: "light" | "dark";
}

export function ReviewWidgetPreview({ src, theme }: ReviewWidgetPreviewProps) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [width, setWidth] = useState<WidthKey>("desktop");
  const { height, onFrameLoad } = useWidgetFrameHeight(frameRef, { kind: "review" });

  return (
    <div className="space-y-3">
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
              onClick={() => setWidth(key)}
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

      {/*
        The backdrop is part of the preview, not decoration. A dark card on a
        white product surface looks wrong in a way it will not look on the
        customer's own dark page, and somebody would change their theme to fix
        a problem that does not exist.
      */}
      <div
        className={cn(
          "flex justify-center rounded-xl border p-5 transition-colors",
          theme === "dark" ? "border-navy-900 bg-navy-950" : "border-gray-200 bg-gray-50",
        )}
      >
        <div style={{ width: WIDTHS[width].width, maxWidth: "100%" }}>
          <iframe
            ref={frameRef}
            // Keyed by src so a theme change reloads rather than leaving the
            // previous document up while the new one fetches.
            key={src}
            src={src}
            title="Widget preview"
            onLoad={onFrameLoad}
            className="block w-full border-0"
            style={{ height }}
          />
        </div>
      </div>
    </div>
  );
}
