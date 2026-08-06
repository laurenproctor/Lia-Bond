"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { UserPlus } from "lucide-react";
import { signUpAction, type SignUpResult } from "@/app/actions/auth";
import { AuthError, AuthField } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password";

/**
 * Create an account and the organization it will own.
 *
 * Both in one form, because they are one decision. Splitting them into a
 * two-step wizard would create a state nobody wants to be in — an account with
 * no organization, sitting at a screen it cannot leave.
 *
 * As with sign-in, no password is held in client state.
 */

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <Button
      type="submit"
      variant="primary"
      size="lg"
      icon={UserPlus}
      className="w-full"
      disabled={pending}
    >
      {pending ? "Creating your account…" : "Create account"}
    </Button>
  );
}

export function SignUpForm() {
  const [state, formAction] = useActionState<SignUpResult | null, FormData>(
    signUpAction,
    null,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-4">
        <AuthField
          name="firstName"
          label="First name"
          autoComplete="given-name"
          autoFocus
        />
        <AuthField name="lastName" label="Last name" autoComplete="family-name" />
      </div>

      <AuthField
        name="organizationName"
        label="Company name"
        autoComplete="organization"
        hint="You can invite the rest of your team once you are in."
      />

      <AuthField name="email" label="Work email" type="email" autoComplete="email" />

      <AuthField
        name="password"
        label="Password"
        type="password"
        autoComplete="new-password"
        minLength={MIN_PASSWORD_LENGTH}
        hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
      />

      <AuthField
        name="confirm"
        label="Confirm password"
        type="password"
        autoComplete="new-password"
        minLength={MIN_PASSWORD_LENGTH}
      />

      {state?.error ? <AuthError>{state.error}</AuthError> : null}

      <SubmitButton />
    </form>
  );
}
