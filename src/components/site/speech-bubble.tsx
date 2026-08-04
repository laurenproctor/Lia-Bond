/**
 * The testimonial motif: a quote in a hand-drawn bubble.
 *
 * The wobble is a turbulence displacement filter over a plain rounded path, so
 * one path definition yields an edge that never repeats exactly. The two filter
 * definitions live in `BubbleFilters`, which the site layout renders once per
 * document rather than each bubble carrying its own — a page shows up to four
 * of these, and inline `<defs>` in each would be four copies of one turbulence.
 *
 * These are decoration. They are marked `aria-hidden` and carry
 * `pointer-events-none`: the quotes are illustrative, not attributed
 * testimonials from named customers, and presenting them to a screen reader as
 * quoted evidence would overstate them.
 */

const TONES = {
  blue: {
    fill: "var(--color-site-blue-tint)",
    stroke: "var(--color-site-blue-mark)",
    quote: "text-site-blue-ink",
    meta: "text-site-blue-meta",
    filter: "url(#lia-rough-a)",
  },
  amber: {
    fill: "var(--color-site-amber-tint)",
    stroke: "var(--color-site-amber-edge)",
    quote: "text-site-amber-ink",
    meta: "text-site-amber-meta",
    filter: "url(#lia-rough-b)",
  },
  plain: {
    fill: "#ffffff",
    stroke: "var(--color-site-ink)",
    quote: "text-site-ink",
    meta: "text-site-muted",
    filter: "url(#lia-rough-b)",
  },
} as const;

export type BubbleTone = keyof typeof TONES;

/** Shared filter definitions. Render once per page that uses bubbles. */
export function BubbleFilters() {
  return (
    <svg width="0" height="0" className="absolute" aria-hidden="true">
      <defs>
        <filter id="lia-rough-a" x="-18%" y="-18%" width="136%" height="136%">
          <feTurbulence
            type="turbulence"
            baseFrequency="0.016"
            numOctaves="2"
            seed="7"
            result="noise"
          />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="4.5" />
        </filter>
        <filter id="lia-rough-b" x="-18%" y="-18%" width="136%" height="136%">
          <feTurbulence
            type="turbulence"
            baseFrequency="0.02"
            numOctaves="2"
            seed="3"
            result="noise"
          />
          <feDisplacementMap in="SourceGraphic" in2="noise" scale="5" />
        </filter>
      </defs>
    </svg>
  );
}

export function SpeechBubble({
  quote,
  attribution,
  tone = "blue",
  float,
  className,
}: {
  quote: string;
  attribution: string;
  tone?: BubbleTone;
  /** Which drift cycle, or none. Disabled under prefers-reduced-motion. */
  float?: "a" | "b";
  className?: string;
}) {
  const style = TONES[tone];
  const drift = float === "a" ? "site-float-a" : float === "b" ? "site-float-b" : "";

  return (
    <div
      className={`pointer-events-none relative text-left ${drift} ${className ?? ""}`}
      aria-hidden="true"
    >
      <svg
        viewBox="0 0 220 96"
        preserveAspectRatio="none"
        className="absolute inset-0 size-full overflow-visible"
      >
        <path
          filter={style.filter}
          d="M18,5 H202 a13,13 0 0 1 13,13 V60 a13,13 0 0 1 -13,13 H66 L46,92 L51,73 H18 a13,13 0 0 1 -13,-13 V18 a13,13 0 0 1 13,-13 Z"
          fill={style.fill}
          stroke={style.stroke}
          strokeWidth="2.6"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      </svg>
      <div className="relative px-5 pt-3.5 pb-6">
        <p className={`text-[12.5px] leading-[1.34] font-medium ${style.quote}`}>
          {quote}
        </p>
        <p className={`mt-1.5 text-[10px] font-semibold tracking-[0.02em] ${style.meta}`}>
          {attribution}
        </p>
      </div>
    </div>
  );
}
