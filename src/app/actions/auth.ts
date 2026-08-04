"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { newPasswordSchema } from "@/lib/auth/password";
import { safeDestination } from "@/lib/auth/redirect";
import { appOrigin } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * Sign in and sign out.
 *
 * Deliberately not wrapped in `runAction()` like every other action in this
 * directory. That helper resolves an organization scope and a permission,
 * neither of which exists before somebody is signed in — the whole point of
 * this file is the moment before that.
 *
 * The credential never leaves the server: the form posts to this action, and
 * the browser only ever receives a cookie Supabase set.
 */

const signInSchema = z.object({
  email: z.email("Enter a valid email address."),
  password: z.string().min(1, "Enter your password."),
  next: z.string().optional(),
});

export interface SignInResult {
  error: string;
}

/**
 * Sign in with email and password.
 *
 * Returns a message on failure and redirects on success. It never says whether
 * the address exists — "that email is not registered" is a free account-
 * enumeration oracle, and the person who mistyped their address is helped just
 * as well by the generic sentence.
 */
export async function signInAction(
  _previous: SignInResult | null,
  formData: FormData,
): Promise<SignInResult> {
  const parsed = signInSchema.safeParse({
    email: formData.get("email"),
    password: formData.get("password"),
    next: formData.get("next") ?? undefined,
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form and try again." };
  }

  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.signInWithPassword({
    email: parsed.data.email,
    password: parsed.data.password,
  });

  if (error) {
    // Supabase's own message is not surfaced: it distinguishes an unknown
    // address from a wrong password, which is precisely the distinction that
    // must not be published.
    console.error("[auth:sign-in]", error.message);
    return { error: "That email and password did not match. Try again." };
  }

  redirect(safeDestination(parsed.data.next));
}

/**
 * Sign out.
 *
 * Redirects rather than returning, so the browser lands on the sign-in page
 * with the session cookie already cleared.
 */
export async function signOutAction(): Promise<void> {
  const supabase = await createSupabaseServerClient();
  await supabase.auth.signOut();
  redirect("/sign-in");
}

/* -------------------------------------------------------------------------- */
/* Password reset                                                              */
/* -------------------------------------------------------------------------- */

const resetRequestSchema = z.object({
  email: z.email("Enter a valid email address."),
});

export interface ResetRequestResult {
  error?: string;
  sent?: boolean;
}

/**
 * Ask for a reset link.
 *
 * Reports success whether or not the address exists, and does so
 * unconditionally rather than as a convenience. "No account with that email"
 * is a free account-enumeration oracle, and this endpoint is reachable without
 * a session — anyone could walk a list of addresses through it and learn which
 * ones belong to customers.
 *
 * The provider's own failures are logged and swallowed for the same reason: a
 * rate-limit error tells the caller the address was worth rate-limiting.
 */
export async function requestPasswordResetAction(
  _previous: ResetRequestResult | null,
  formData: FormData,
): Promise<ResetRequestResult> {
  const parsed = resetRequestSchema.safeParse({ email: formData.get("email") });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Enter a valid email address." };
  }

  const supabase = await createSupabaseServerClient();

  const { error } = await supabase.auth.resetPasswordForEmail(parsed.data.email, {
    // Absolute, and built from configuration rather than from the request, so
    // a spoofed Host header cannot redirect a password-reset link off-site.
    redirectTo: `${appOrigin()}/auth/callback?next=${encodeURIComponent("/reset-password")}`,
  });

  if (error) console.error("[auth:reset-request]", error.message);

  return { sent: true };
}

export interface UpdatePasswordResult {
  error: string;
}

/**
 * Set a new password.
 *
 * Requires the recovery session the emailed link established — `updateUser`
 * acts on whoever the cookie says is signed in, so there is no user id in the
 * form and no way to aim this at somebody else's account.
 */
export async function updatePasswordAction(
  _previous: UpdatePasswordResult | null,
  formData: FormData,
): Promise<UpdatePasswordResult> {
  const parsed = newPasswordSchema.safeParse({
    password: formData.get("password"),
    confirm: formData.get("confirm"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form and try again." };
  }

  const supabase = await createSupabaseServerClient();

  // Checked explicitly rather than relying on updateUser to fail: a recovery
  // link that has expired or been used should say so, not produce a provider
  // message about a missing session.
  const { data, error: sessionError } = await supabase.auth.getUser();
  if (sessionError || !data.user) {
    return {
      error:
        "This reset link has expired or was already used. Request a new one and try again.",
    };
  }

  const { error } = await supabase.auth.updateUser({ password: parsed.data.password });

  if (error) {
    console.error("[auth:update-password]", error.message);
    return {
      error: "That password could not be saved. Try again, or request a new link.",
    };
  }

  redirect("/overview");
}
