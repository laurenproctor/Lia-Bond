import Link from "next/link";
import type { ReactNode } from "react";
import { Check } from "lucide-react";

/**
 * A pricing card, light or featured.
 *
 * The featured variant inverts to the ink surface. Its muted text uses
 * `site-muted-dark` — the reference grey, which measures 2.93:1 on the pale
 * surface and 6.19:1 on this one, so it is correct here and only here.
 */
export function PricingTier({
  name,
  blurb,
  price,
  priceNote,
  ctaLabel,
  ctaHref,
  savingNote = null,
  onSavingNoteClick,
  billedNote = null,
  priceSlot = null,
  features,
  featured = false,
}: {
  name: string;
  blurb: string;
  price: string;
  priceNote: string;
  ctaLabel: string;
  /**
   * A prop rather than the `#access` anchor this used to hard-code. The two
   * self-serve tiers now go to `/sign-up`; the custom tier has no price to
   * sign up against and goes to `/contact`, so the destination varies with the
   * tier and belongs with the copy that describes it.
   */
  ctaHref: string;
  /**
   * What annual billing saves on this tier, already phrased for the period on
   * screen. `null` on the quoted tier, which has no listed rate to discount —
   * an empty pill there would imply a saving nobody can name.
   */
  savingNote?: string | null;
  /**
   * Switches the page to annual billing.
   *
   * When given, the saving turns from a label into the control that takes it:
   * a reader who has just read "save $118 a year" has been told what to want
   * and then left to find the switch themselves. Absent on the annual face,
   * where the saving is already taken and there is nowhere to go.
   */
  onSavingNoteClick?: () => void;
  /** What is actually charged and when, under the per-month headline. */
  billedNote?: string | null;
  /**
   * Replaces the whole price block — figure, note, and saving pill — when a
   * card prices itself interactively. Substitution rather than addition: a
   * card showing both a fixed headline and a live one is two prices, and the
   * reader has no way to know which is theirs.
   */
  priceSlot?: ReactNode;
  features: readonly string[];
  featured?: boolean;
}) {
  return (
    <div
      className={
        featured
          ? "relative flex flex-col rounded-[18px] border border-site-ink bg-site-ink p-7 shadow-[0_30px_70px_-34px_rgb(11_15_24_/_0.55)]"
          : "flex flex-col rounded-[18px] border border-site-border bg-white p-7"
      }
      data-surface={featured ? "dark" : undefined}
    >
      {featured ? (
        <span className="absolute top-5.5 right-6 rounded-[20px] bg-site-orange px-2.5 py-1 text-[11px] font-semibold text-site-ink">
          Most popular
        </span>
      ) : null}

      {/* `h2`, not `h3`: three of these cards are the page's first heading
          level after `PageHeading`'s `h1` (`/pricing`), so they sit at the
          same depth as "Questions, answered" further down the page — a hard
          `h3` here would skip a level on every render. */}
      <h2
        className={`mb-1.5 text-[14px] font-semibold ${featured ? "text-white" : "text-site-ink"}`}
      >
        {name}
      </h2>
      <p
        className={`mb-5.5 text-[13.5px] leading-[1.5] ${featured ? "text-site-muted-dark" : "text-site-muted"}`}
      >
        {blurb}
      </p>

      {priceSlot ?? (
        <>
          <p className="mb-1.5 flex items-baseline gap-1.5">
            <span
              className={`text-[42px] font-bold tracking-[-0.02em] ${featured ? "text-white" : "text-site-ink"}`}
            >
              {price}
            </span>
          </p>
          <p
            className={`text-[12.5px] ${billedNote || savingNote ? "mb-1.5" : "mb-6"} ${featured ? "text-site-muted-dark" : "text-site-muted"}`}
          >
            {priceNote}
          </p>

          {billedNote ? (
            <p
              className={`text-[13px] font-semibold ${savingNote ? "mb-2.5" : "mb-6"} ${featured ? "text-white" : "text-site-ink"}`}
            >
              {billedNote}
            </p>
          ) : null}

          {savingNote ? (
            <SavingNote
              featured={featured}
              onClick={onSavingNoteClick}
              text={savingNote}
            />
          ) : null}
        </>
      )}

      <Link
        href={ctaHref}
        className={
          featured
            ? "mb-6.5 rounded-[10px] bg-site-orange py-3.5 text-center text-[14px] font-semibold text-site-ink transition-colors hover:bg-site-orange-hover"
            : // Brief specified a literal `#eff5ff` hover fill. `site-blue-tint`
              // (#eaf3ff) is the nearest existing token — close enough to read
              // as the same pale wash — so it replaces the hand-written hex.
              "mb-6.5 rounded-[10px] border border-site-blue-edge py-3 text-center text-[14px] font-semibold text-site-blue transition-colors hover:bg-site-blue-tint"
        }
      >
        {ctaLabel}
      </Link>

      <ul className="flex flex-col gap-3.5">
        {features.map((feature) => (
          <li key={feature} className="flex items-start gap-2.5">
            <Check
              className={`mt-0.5 size-3.5 shrink-0 ${featured ? "text-site-orange" : "text-site-blue"}`}
              aria-hidden="true"
            />
            <span
              // Brief specified a literal `#e6eaf0` here — that value already
              // exists as `site-border`, so the token replaces the hex exactly
              // rather than approximately.
              className={`text-[14px] leading-[1.5] ${featured ? "text-site-border" : "text-site-body"}`}
            >
              {feature}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/**
 * The saving, as a label or as the button that takes it.
 *
 * `w-fit` on a block rather than an inline pill: the text is short enough to
 * sit on one line at every card width, and a block keeps the pill hugging its
 * copy instead of stretching the card's full measure.
 *
 * The button carries an arrow and a hover state so it reads as something that
 * does rather than something that says. Its accessible name spells out the
 * action, because "save $118 a year on annual billing" describes an outcome
 * and a screen-reader user tabbing onto a control needs the verb.
 */
function SavingNote({
  text,
  featured,
  onClick,
}: {
  text: string;
  featured: boolean;
  onClick?: () => void;
}) {
  const base = `mb-6 w-fit rounded-[20px] px-2.5 py-1 text-[12px] font-semibold ${
    featured
      ? "bg-white/10 text-site-orange"
      : "bg-site-blue-tint text-site-blue"
  }`;

  if (!onClick) return <p className={base}>{text}</p>;

  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={`Switch to annual billing and ${text.toLowerCase()}`}
      className={`${base} inline-flex items-center gap-1 transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 ${
        featured
          ? "cursor-pointer hover:bg-white/20 focus-visible:outline-site-orange"
          : "cursor-pointer hover:bg-site-blue-edge focus-visible:outline-site-blue"
      }`}
    >
      {text}
      <span aria-hidden="true">&rarr;</span>
    </button>
  );
}
