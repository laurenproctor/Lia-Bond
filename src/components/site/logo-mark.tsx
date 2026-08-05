/**
 * The Lia wordmark: "lia", with the dot of the i replaced by a speech bubble.
 *
 * Type plus one small SVG rather than an image. The reference ships a raster
 * whose navigation variant is a blue mark on an opaque black tile — a black
 * square against a white bar — and the pair weighs 1.6MB. This takes
 * `currentColor`, so the same component renders ink on the white navigation and
 * cream on the dark footer, and it stays sharp at any size.
 *
 * The bubble is the product's own idea in miniature: public speech, held and
 * handled. It reappears at full size as the testimonial motif.
 *
 * The i's stem is a drawn bar, not the dotless-ı character (U+0131). That
 * character sits outside the Google Fonts "latin" subset that Geist is
 * loaded with here, so the browser silently substituted a fallback system
 * font for just that glyph — a different typeface with its own ascent and
 * advance width. The visible symptom was the speech-bubble dot: positioned
 * in em units relative to that fallback glyph's box, it floated well above
 * and left of where it belonged. Drawing the stem ourselves removes the
 * dependency on any particular font supporting that character, so the
 * bubble's position (anchored to the stem) is exact at any size.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <span
      className={`relative inline-flex items-baseline font-site text-[27px] leading-none font-semibold tracking-[-0.045em] select-none ${className ?? ""}`}
      // The bubble is decorative; the accessible name comes from the wrapper.
      aria-hidden="true"
    >
      l
      <span className="relative ml-[0.24em] inline-block h-[0.52em] w-[0.1em] self-end rounded-[0.01em] bg-current">
        {/* The stem of the i, drawn rather than typeset — see comment above. */}
        <svg
          viewBox="0 0 24 24"
          className="absolute -top-[0.5em] left-1/2 h-[0.46em] w-[0.46em] -translate-x-1/2 overflow-visible"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M12 1.6a10.4 10.4 0 1 1-6.7 18.35l-3.1 1.35a.5.5 0 0 1-.68-.63l1.15-3.2A10.4 10.4 0 0 1 12 1.6Z"
            stroke="currentColor"
            strokeWidth="2.6"
            strokeLinejoin="round"
          />
        </svg>
      </span>
      a
    </span>
  );
}
