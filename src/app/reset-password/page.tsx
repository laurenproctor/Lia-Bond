import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/components/auth/auth-shell";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password";
import { createSupabaseServerClient } from "@/lib/supabase/server";
import { isSupabaseConfigured } from "@/lib/env";

export const metadata: Metadata = { title: "Set a new password" };

/**
 * Set a new password, after following an emailed link.
 *
 * Reachable without a normal session on purpose — the recovery session is
 * established by `/auth/callback` exchanging the emailed code, and that is the
 * only thing that authorises this page. Checking here rather than letting
 * middleware bounce an unauthenticated visitor means somebody with a dead link
 * gets told the link is dead, instead of being silently returned to sign-in
 * wondering what happened.
 */
export default async function ResetPasswordPage() {
  const hasRecoverySession = await (async () => {
    if (!isSupabaseConfigured()) return false;
    const supabase = await createSupabaseServerClient();
    const { data } = await supabase.auth.getUser();
    return Boolean(data.user);
  })();

  if (!hasRecoverySession) {
    return (
      <AuthShell
        title="This link has expired"
        description="Password reset links work once and expire after an hour."
        footer={
          <Link
            href="/sign-in"
            className="text-[13px] text-white/70 underline-offset-4 hover:text-white hover:underline"
          >
            Back to sign in
          </Link>
        }
      >
        <p className="text-[13px] text-gray-700">
          Request a new link and follow it in the same browser you asked from —
          the link is tied to the browser that started the request.
        </p>
        <Link
          href="/forgot-password"
          className="mt-4 inline-flex h-11 w-full items-center justify-center rounded-[10px] border border-purple-600 bg-purple-600 text-[13px] font-medium text-white transition-colors hover:bg-purple-500"
        >
          Request a new link
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title="Set a new password"
      description="Choose something you have not used here before."
    >
      <ResetPasswordForm minLength={MIN_PASSWORD_LENGTH} />
    </AuthShell>
  );
}
