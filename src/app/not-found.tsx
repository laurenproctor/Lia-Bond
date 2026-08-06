import { Geist } from "next/font/google";
import { PrimaryButton, SecondaryButton } from "@/components/site/button";
import { SiteFooter } from "@/components/site/site-footer";
import { SiteNav } from "@/components/site/site-nav";
import { SpeechBubble, BubbleFilters } from "@/components/site/speech-bubble";
import { Lede, PageHeading } from "@/components/site/section";

/**
 * The 404 for any URL matching no route at all.
 *
 * Site-branded rather than product-branded, because `/` is now the marketing
 * homepage and an unmatched URL is far more likely to be a mistyped marketing
 * link or a dead result from search than a product route. `notFound()` raised
 * inside the product resolves to `(app)/not-found.tsx` instead.
 *
 * A root not-found cannot inherit a route group's layout, so the navigation,
 * footer, and font are rendered here directly rather than by `(site)/layout`.
 */
const geist = Geist({
  subsets: ["latin"],
  display: "swap",
  variable: "--font-geist",
});

export default function NotFound() {
  return (
    <div
      data-surface="site"
      className={`${geist.variable} font-site flex min-h-dvh flex-col bg-white text-[15px] text-site-body`}
    >
      <BubbleFilters />
      <SiteNav />
      <main id="main" className="flex-1">
        <div className="relative mx-auto w-full max-w-[1200px] px-[clamp(24px,6vw,106px)] py-[clamp(64px,10vw,140px)]">
          <SpeechBubble
            quote="Nothing to see here."
            attribution="This page"
            tone="amber"
            float="b"
            className="pointer-events-none absolute top-[clamp(24px,6vw,80px)] right-[clamp(10px,4vw,60px)] hidden w-[176px] lg:block"
          />
          <div className="max-w-[560px]">
            <p className="mb-5 text-[13px] font-semibold tracking-[0.16em] text-site-muted uppercase">
              404
            </p>
            <PageHeading className="mb-5 text-[clamp(32px,4.4vw,52px)]!">
              That page does not exist.
            </PageHeading>
            <Lede className="mb-8">
              The link may be out of date, or the address may have a typo in it.
              Everything else is where you left it.
            </Lede>
            <div className="flex flex-wrap gap-3">
              <PrimaryButton href="/">Back to home</PrimaryButton>
              <SecondaryButton href="/product">See how Lia works</SecondaryButton>
            </div>
          </div>
        </div>
      </main>
      <SiteFooter />
    </div>
  );
}
