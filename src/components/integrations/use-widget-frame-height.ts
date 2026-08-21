"use client";

import { useCallback, useEffect, useState, type RefObject } from "react";
import { WIDGET_KINDS, type WidgetKind } from "@/lib/widgets/kinds";

/**
 * The height of a framed widget document, as the document reports it.
 *
 * An iframe cannot size itself to its content, so every widget document posts
 * its measured height to the parent (see `heightScript` in
 * `@/lib/widgets/document` and its press twin). This is the listening half,
 * extracted because several screens now frame one of those documents — both
 * configuration previews, the review teaser, and the two samples on the
 * Website widgets landing page — and a second copy of a `postMessage` handler
 * is a second place for the origin check to be got wrong.
 *
 * `kind` selects which widget's message source to accept. The landing page
 * frames one of each at once, so a hook that accepted either would let a
 * press document resize the review sample.
 *
 * Every guard in the listener is load-bearing:
 *
 * - **Origin.** Unlike the public loader, both callers frame a same-origin
 *   document, so anything claiming to be this frame from elsewhere is not it.
 * - **Source window.** The page may hold several of these frames at once; the
 *   message is matched to the frame that sent it rather than to an id in the
 *   payload, which the sender chooses.
 * - **Range.** A height of zero collapses the frame and a wild one blows the
 *   page apart, and both are cheaper to reject here than to debug later.
 *
 * **`onFrameLoad` is not belt-and-braces.** A frame in server-rendered HTML
 * starts loading with the page and can post its height before React has
 * hydrated and attached the listener above — `postMessage` has no replay, and
 * `ResizeObserver` never fires again because nothing subsequently resizes, so
 * the frame stays at its initial height and quietly clips the review. That is
 * a race the configuration preview usually wins (its frame is replaced on the
 * first change a person makes) and the teaser reliably loses. Because both
 * callers frame a same-origin document, the parent can simply measure it on
 * `load` instead of waiting to be told.
 */
export interface WidgetFrameHeightOptions {
  /** Which widget's height messages to accept. */
  kind: WidgetKind;
  /** What to show before the document reports its own height. */
  initialHeight?: number;
}

export function useWidgetFrameHeight(
  frameRef: RefObject<HTMLIFrameElement | null>,
  options: WidgetFrameHeightOptions,
): { height: number; onFrameLoad: () => void } {
  const { kind } = options;
  const [height, setHeight] = useState(
    options.initialHeight ?? WIDGET_KINDS[kind].initialFrameHeight,
  );

  useEffect(() => {
    const expected = WIDGET_KINDS[kind].messageSource;

    function onMessage(event: MessageEvent) {
      if (event.origin !== window.location.origin) return;

      const data = event.data as { source?: string; type?: string; height?: number };
      if (data?.source !== expected || data.type !== "height") return;
      if (event.source !== frameRef.current?.contentWindow) return;

      const next = usableHeight(Number(data.height));
      if (next !== null) setHeight(next);
    }

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [frameRef, kind]);

  const onFrameLoad = useCallback(() => {
    // Null rather than an exception when the document is not same-origin, so a
    // future cross-origin caller simply falls back to the messaged height.
    const element = frameRef.current?.contentDocument?.querySelector(".widget");
    if (!(element instanceof HTMLElement)) return;

    const next = usableHeight(Math.ceil(element.getBoundingClientRect().height));
    if (next !== null) setHeight(next);
  }, [frameRef]);

  return { height, onFrameLoad };
}

/** A height worth applying, or null. Zero collapses the frame; a wild value tears the page. */
function usableHeight(value: number): number | null {
  return Number.isFinite(value) && value > 0 && value < 2000 ? value : null;
}
