/**
 * The hand-drawn speech bubbles.
 *
 * Purely decorative, and treated as such without exception: every one is
 * `aria-hidden`, none is focusable, none carries text, and nothing on any step
 * depends on seeing one. They exist because the reference design does, not
 * because they say anything.
 *
 * Separate from `components/site/speech-bubble.tsx` on purpose. That component
 * renders a *quote* — an illustrative testimonial with an attribution line —
 * and reusing it here would put words in a fictional customer's mouth on a
 * screen where the real customer is halfway through configuring their account.
 * These are empty outlines with three dots in them.
 *
 * At most two per screen, per the visual direction. The `float` prop reuses the
 * marketing site's drift animations, which `globals.css` disables outright
 * under `prefers-reduced-motion` rather than merely shortening — nothing is
 * communicated by the movement, so stopping it costs nothing.
 */

export type DoodleVariant = "blue" | "orange";

const STROKES: Record<DoodleVariant, string> = {
  blue: "var(--color-site-blue-mark)",
  orange: "var(--color-site-orange)",
};

export function OnboardingDoodle({
  variant = "blue",
  float,
  className,
}: {
  variant?: DoodleVariant;
  /** Which drift cycle, or none. */
  float?: "a" | "b";
  className?: string;
}) {
  const stroke = STROKES[variant];
  const drift = float === "a" ? "site-float-a" : float === "b" ? "site-float-b" : "";

  return (
    <svg
      viewBox="0 0 132 74"
      // Two attributes rather than one: `aria-hidden` removes it from the
      // accessibility tree, `focusable="false"` stops IE-era SVG focus, and
      // `role="presentation"` keeps older screen readers from announcing a
      // graphic. Belt and braces on something that must never be announced.
      aria-hidden="true"
      focusable="false"
      role="presentation"
      className={`pointer-events-none ${drift} ${className ?? ""}`}
    >
      <path
        d="M14,4 H118 a11,11 0 0 1 11,11 V44 a11,11 0 0 1 -11,11 H50 L30,70 L35,55 H14 a11,11 0 0 1 -11,-11 V15 a11,11 0 0 1 11,-11 Z"
        fill="none"
        stroke={stroke}
        strokeWidth="3.2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      <circle cx="48" cy="30" r="3.4" fill={stroke} />
      <circle cx="66" cy="30" r="3.4" fill={stroke} />
      <circle cx="84" cy="30" r="3.4" fill={stroke} />
    </svg>
  );
}

/**
 * The three short strokes that sit beside a bubble in the reference.
 *
 * Same rules: decorative, hidden, and never load-bearing.
 */
export function OnboardingSparkle({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 34 34"
      aria-hidden="true"
      focusable="false"
      role="presentation"
      className={`pointer-events-none ${className ?? ""}`}
    >
      <g
        stroke="var(--color-site-blue-mark)"
        strokeWidth="3"
        strokeLinecap="round"
        fill="none"
      >
        <path d="M4,20 L13,11" />
        <path d="M15,5 L18,15" />
        <path d="M24,17 L31,15" />
      </g>
    </svg>
  );
}
