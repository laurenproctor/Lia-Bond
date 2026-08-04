import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, MailCheck } from "lucide-react";
import { AuthShell } from "@/components/auth/auth-shell";
import { SignInForm } from "@/components/auth/sign-in-form";
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
  searchParams: Promise<{ next?: string; error?: string; pending?: string }>;
}) {
  const { next, error, pending } = await searchParams;

  return (
    <AuthShell
      title="Sign in"
      description="Use your work email to continue."
      footer={
        /*
          Shown only when no Supabase project is configured — that is, when the
          app runs on the seed dataset. Gated on configuration rather than
          NODE_ENV so a real deployment cannot print it even if somebody builds
          in development mode.
        */
        !isSupabaseConfigured() ? (
          <p className="text-[12.5px] text-white/50">
            Demo mode — no database configured. Sign-in is not required.
          </p>
        ) : undefined
      }
    >
      {/*
        Carried by /auth/callback when an emailed link is dead. Lia's own
        wording; the provider's text never reaches here.
      */}
      {/*
        Set when sign-up created an account that cannot act yet, because the
        project requires email confirmation. Saying so here is the difference
        between "nothing happened" and "check your email".
      */}
      {pending === "confirm" ? (
        <p
          role="status"
          className="mb-4 flex items-start gap-1.5 rounded-lg border border-purple-600/20 bg-purple-50 px-3 py-2.5 text-[13px] text-gray-950"
        >
          <MailCheck className="mt-px size-4 shrink-0 text-purple-600" aria-hidden />
          Your account was created. Confirm your email address, then sign in.
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="mb-4 flex items-start gap-1.5 rounded-lg border border-amber-600/20 bg-amber-100 px-3 py-2.5 text-[13px] text-gray-950"
        >
          <AlertTriangle className="mt-px size-4 shrink-0 text-amber-600" aria-hidden />
          {error}
        </p>
      ) : null}

      <SignInForm next={next} />

      <p className="mt-4 text-center text-[12.5px] text-gray-500">
        <Link
          href="/forgot-password"
          className="text-purple-600 underline-offset-4 hover:underline"
        >
          Forgot your password?
        </Link>
      </p>

      <p className="mt-3 border-t border-gray-200 pt-4 text-center text-[12.5px] text-gray-500">
        New to Lia?{" "}
        <Link
          href="/sign-up"
          className="font-medium text-purple-600 underline-offset-4 hover:underline"
        >
          Create an account
        </Link>
      </p>
    </AuthShell>
  );
}
