import Link from "next/link";
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

      <p className="mb-1.5 flex items-baseline gap-1.5">
        <span
          className={`text-[42px] font-bold tracking-[-0.02em] ${featured ? "text-white" : "text-site-ink"}`}
        >
          {price}
        </span>
      </p>
      <p
        className={`mb-6 text-[12.5px] ${featured ? "text-site-muted-dark" : "text-site-muted"}`}
      >
        {priceNote}
      </p>

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
