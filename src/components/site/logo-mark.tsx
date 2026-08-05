/**
 * The Lia wordmark: "lia", with the dot of the i drawn as a small speech bubble.
 *
 * Every element — the l, the i's stem, the bubble, and the a — is drawn in one
 * `<svg>` sharing a single `viewBox`. That is the whole point of this file.
 *
 * The two earlier versions typeset "lia" from font glyphs and hung the bubble
 * over them as an absolutely-positioned overlay. That cannot be made to line up
 * here. Geist is loaded with the Google Fonts "latin" subset, which does not
 * contain the dotless-ı character (U+0131), so the browser silently swapped in a
 * fallback system font for that one glyph — a different typeface with its own
 * ascent, x-height and advance width. The bubble's offsets, expressed in `em`,
 * were therefore measured against metrics nobody had chosen, and the bubble
 * floated above and left of the stem it was supposed to sit on. Nudging the
 * offsets only moved the error around: it changes with the font that happens to
 * load, the subset, and the fallback the OS supplies.
 *
 * Drawing the whole word as vectors removes that dependency entirely. Alignment
 * is exact by construction — the bubble is centred on the i's stem because they
 * share an x coordinate in the same coordinate system — and it stays exact at
 * any size, on any machine, whether or not the webfont has loaded.
 *
 * Geometry (viewBox units): baseline y=68.5, x-height top y=30.5, and the l
 * ascends to y=16.1 — the proportions of the original brand artwork. The bubble
 * is centred on the i's stem at x=22 and its tail clears the top of that stem
 * by seven units, the gap that makes it read as a dot rather than a separate
 * object. The a's bowl is tangent to its own stem at x=67.
 *
 * Strokes are `currentColor`, so one component renders ink on the white
 * navigation and cream on the dark footer. The mark is sized in `em`, so it
 * scales with whatever font-size the caller sets.
 *
 * The bubble is the product's own idea in miniature: public speech, held and
 * handled. It reappears at full size as the testimonial motif.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    // Decorative: the accessible name comes from the wrapping link.
    <span className="inline-flex items-center text-[27px]" aria-hidden="true">
      <svg
        viewBox="0 0 69.3 70.8"
        // The caller's font-size lands on the svg itself, so `1em` below
        // resolves against it and no font-size utilities ever collide.
        className={["block h-[1em] w-auto", className].filter(Boolean).join(" ")}
        fill="none"
        stroke="currentColor"
        strokeWidth={4.6}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        {/* l: stem with a foot curving right onto the baseline. */}
        <path d="M2.3 16.1V58.9c0 5.3 3.8 9.6 8.5 9.6" />
        {/* The speech bubble that dots the i: a ring with a tail at lower left. */}
        <path d="M19.03 21.03A9.6 9.6 0 1 0 14.14 17.41L14.48 23.04Z" />
        {/* i: the stem, sharing x=22 with the bubble's centre. */}
        <path d="M22 30.5V68.5" />
        {/* a: a bowl tangent to its stem at x=67. */}
        <ellipse cx="52" cy="49.5" rx="15" ry="19" />
        <path d="M67 30.5V68.5" />
      </svg>
    </span>
  );
}
