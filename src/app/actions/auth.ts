"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import {
  hashInvitationToken,
  isInvitationTokenShaped,
} from "@/lib/auth/invitation-token";
import { MIN_PASSWORD_LENGTH, newPasswordSchema } from "@/lib/auth/password";
import { DEFAULT_SIGN_IN_DESTINATION, safeDestination } from "@/lib/auth/redirect";
import { appOrigin } from "@/lib/env";
import { getDataSource } from "@/lib/data";
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
/* Sign up                                                                     */
/* -------------------------------------------------------------------------- */

const signUpSchema = z
  .object({
    fullName: z.string().trim().min(1, "Enter your name.").max(160),
    organizationName: z
      .string()
      .trim()
      .min(1, "Enter your restaurant group's name.")
      .max(160),
    email: z.email("Enter a valid email address."),
    password: z.string().min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`),
    confirm: z.string(),
  })
  .refine((value) => value.password === value.confirm, {
    message: "Those passwords do not match.",
    path: ["confirm"],
  });

export interface SignUpResult {
  error: string;
}

/**
 * Create an account and the organization that account owns.
 *
 * Two steps that must both land, and the ordering is the whole design:
 *
 * 1. `signUp` creates the auth account. A database trigger mirrors it into
 *    `public.users`, which is what every RLS policy resolves through.
 * 2. `provision` creates the organization and the owner membership, in one
 *    transaction inside Postgres.
 *
 * Step 2 cannot be folded into step 1, and step 1 cannot be rolled back from
 * here. So a crash between them leaves an account with no organization —
 * recoverable, because signing in again lands on this same provisioning path.
 * The reverse order would leave an ownerless organization, which is not
 * recoverable by anyone.
 *
 * Nothing here reports whether an address is already registered. Supabase
 * returns a success-shaped response for a duplicate sign-up precisely so this
 * endpoint cannot be used to enumerate customers, and that behaviour is
 * preserved rather than unpicked.
 */
export async function signUpAction(
  _previous: SignUpResult | null,
  formData: FormData,
): Promise<SignUpResult> {
  const parsed = signUpSchema.safeParse({
    fullName: formData.get("fullName"),
    organizationName: formData.get("organizationName"),
    email: formData.get("email"),
    password: formData.get("password"),
    confirm: formData.get("confirm"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form and try again." };
  }

  const { fullName, organizationName, email, password } = parsed.data;
  const supabase = await createSupabaseServerClient();

  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      // Read by the profile trigger. This is the only path by which a name
      // reaches `public.users`, so omitting it would leave every new account
      // named after the local part of its address.
      data: { full_name: fullName },
      emailRedirectTo: `${appOrigin()}/auth/callback`,
    },
  });

  if (error) {
    console.error("[auth:sign-up]", error.message);
    return { error: "That account could not be created. Try again." };
  }

  // No session means the project requires email confirmation. The account
  // exists and is correct; it simply cannot act yet, and provisioning has to
  // wait until the link is clicked.
  if (!data.session) {
    redirect("/sign-in?pending=confirm");
  }

  try {
    const dataSource = await getDataSource();
    await dataSource.organizations.provision({
      userId: data.user?.id ?? "",
      name: organizationName,
    });
  } catch (cause) {
    console.error("[auth:sign-up] provisioning failed", cause);
    return {
      error:
        "Your account was created, but we could not set up your organization. Sign in to finish.",
    };
  }

  redirect(DEFAULT_SIGN_IN_DESTINATION);
}

/* -------------------------------------------------------------------------- */
/* Sign up from an invitation                                                  */
/* -------------------------------------------------------------------------- */

const acceptWithSignUpSchema = z
  .object({
    token: z
      .string()
      .refine(isInvitationTokenShaped, "That invitation link is not valid."),
    fullName: z.string().trim().min(1, "Enter your name.").max(160),
    password: z
      .string()
      .min(MIN_PASSWORD_LENGTH, `Use at least ${MIN_PASSWORD_LENGTH} characters.`),
    confirm: z.string(),
  })
  .refine((value) => value.password === value.confirm, {
    message: "Those passwords do not match.",
    path: ["confirm"],
  });

/**
 * Create an account from an invitation and join, in one step.
 *
 * The address is **not** taken from the form. It is re-read from the invitation
 * on the server, so this cannot be used to register an arbitrary address, and
 * the account it creates is guaranteed to satisfy the email match that
 * acceptance requires. A hidden field carrying the address would be one the
 * browser could edit.
 *
 * No organization is provisioned here — that is what separates this from
 * `signUpAction`. An invitee is joining a group that already exists, and
 * creating a second empty one for them is the failure this whole route avoids.
 */
export async function acceptInvitationWithSignUpAction(
  _previous: SignUpResult | null,
  formData: FormData,
): Promise<SignUpResult> {
  const parsed = acceptWithSignUpSchema.safeParse({
    token: formData.get("token"),
    fullName: formData.get("fullName"),
    password: formData.get("password"),
    confirm: formData.get("confirm"),
  });

  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? "Check the form and try again." };
  }

  const tokenHash = hashInvitationToken(parsed.data.token);
  const dataSource = await getDataSource();

  const preview = await dataSource.invitations.preview(tokenHash);
  if (!preview || preview.state !== "pending") {
    return { error: "That invitation is no longer valid. Ask for a new one." };
  }

  const supabase = await createSupabaseServerClient();
  const { data, error } = await supabase.auth.signUp({
    email: preview.email,
    password: parsed.data.password,
    options: { data: { full_name: parsed.data.fullName } },
  });

  if (error) {
    console.error("[auth:invite-sign-up]", error.message);
    return {
      error:
        "That account could not be created. If you already have one, sign in and open this link again.",
    };
  }

  if (!data.session) {
    // Email confirmation is switched on for this project. The account exists
    // but cannot act yet, so the invitation stays pending and the link stays
    // usable once they confirm.
    redirect("/sign-in?pending=confirm");
  }

  try {
    await dataSource.invitations.accept(tokenHash, data.user?.id ?? "");
  } catch (cause) {
    console.error("[auth:invite-sign-up] accept failed", cause);
    return {
      error: "Your account was created, but joining failed. Sign in and open the link again.",
    };
  }

  redirect(DEFAULT_SIGN_IN_DESTINATION);
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
