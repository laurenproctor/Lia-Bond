import type { Metadata } from "next";
import { SignInForm } from "@/components/auth/sign-in-form";
import { Logo } from "@/components/shell/logo";
import { isSupabaseConfigured } from "@/lib/env";

export const metadata: Metadata = { title: "Sign in" };

/**
 * Sign in.
 *
 * Deliberately outside the `(app)` route group, so it renders with no sidebar,
 * no organization switcher, and no user menu — every one of which would need a
 * session this page exists to establish.
 *
 * `CLAUDE.md` fixes the route list and does not include this path. Adding it
 * is a considered exception rather than drift: every route on that list is a
 * product screen for a signed-in user, and all of them are unreachable without
 * somewhere to sign in. Recorded as decision D46.
 */
export default async function SignInPage({
  searchParams,
}: {
  searchParams: Promise<{ next?: string }>;
}) {
  const { next } = await searchParams;

  return (
    <main
      id="main"
      className="flex min-h-dvh flex-col items-center justify-center bg-navy-900 px-4 py-10"
    >
      <div className="w-full max-w-[26rem]">
        <div className="mb-6 flex flex-col items-center gap-2 text-center">
          <Logo />
          <p className="text-[13px] text-white/60">
            Reputation intelligence for restaurants
          </p>
        </div>

        <div className="rounded-2xl border border-gray-200 bg-white p-6 shadow-sm">
          <h1 className="text-[17px] font-semibold text-gray-950">Sign in</h1>
          <p className="mt-1 mb-5 text-[13px] text-gray-500">
            Use your work email to continue.
          </p>

          <SignInForm next={next} />
        </div>

        {/*
          Development affordance, shown only when no Supabase project is
          configured — that is, when the app is running on the seed dataset and
          these are the only accounts that could exist. It is gated on
          configuration rather than on NODE_ENV so a real deployment cannot
          print it even if someone builds in development mode.
        */}
        {!isSupabaseConfigured() ? (
          <p className="mt-4 text-center text-[12.5px] text-white/50">
            Demo mode — no database configured. Sign-in is not required.
          </p>
        ) : null}
      </div>
    </main>
  );
}
