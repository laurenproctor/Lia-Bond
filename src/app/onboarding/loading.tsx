/**
 * Route-level loading state for every onboarding screen.
 *
 * Steps 2 and 3 both wait on the database and, on step 3, on Google itself —
 * account discovery is a network round trip that happens during render — so
 * this is genuinely visible rather than a formality.
 *
 * A skeleton rather than a spinner, and shaped like the screen it replaces:
 * the layout does not jump when the real content arrives. The status message is
 * screen-reader-only and polite, because "Loading" announced assertively over
 * whatever somebody was reading is worse than silence.
 */
export default function OnboardingLoading() {
  return (
    <div data-surface="site" className="font-site min-h-dvh bg-site-tint">
      <p role="status" className="sr-only">
        Loading your setup step.
      </p>

      <div
        // The blocks below stand in for content that is not there yet. They say
        // nothing, so they are hidden from assistive technology and the status
        // line above is what announces the state.
        aria-hidden="true"
        className="mx-auto flex w-full max-w-[1400px] flex-col gap-6 px-4 py-6 sm:px-6 lg:px-10 lg:py-10"
      >
        <div className="h-9 w-20 rounded-lg bg-white" />

        <div className="grid gap-6 lg:grid-cols-12 lg:gap-10">
          <div className="flex flex-col gap-4 lg:col-span-4">
            <div className="h-6 w-28 rounded-full bg-white" />
            <div className="h-24 w-full rounded-2xl bg-white" />
            <div className="h-40 w-full rounded-2xl bg-white/70" />
          </div>

          <div className="lg:col-span-8">
            <div className="h-[420px] w-full rounded-[20px] border border-site-border bg-white" />
          </div>
        </div>

        <div className="h-20 w-full rounded-2xl border border-site-border bg-white" />
      </div>
    </div>
  );
}
