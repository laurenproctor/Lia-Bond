"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { safeDestination } from "@/lib/auth/redirect";
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
