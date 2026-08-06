"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { UserPlus } from "lucide-react";
import {
  acceptInvitationWithSignUpAction,
  type SignUpResult,
} from "@/app/actions/auth";
import { AuthError, AuthField } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";
import { MIN_PASSWORD_LENGTH } from "@/lib/auth/password";

/**
 * Create an account from an invitation.
 *
 * The address is shown but not editable, and it is not what the server reads —
 * the server re-reads it from the invitation. Rendering it read-only rather
 * than omitting it is deliberate: somebody about to type a password should be
 * able to see which account they are creating.
 *
 * No organization name field, because an invitee is joining a group that
 * already exists. Asking for one is how a person ends up owning a second,
 * empty organization and wondering where their team went.
 */

function SubmitButton({ pendingLabel }: { pendingLabel: string }) {
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
      {pending ? pendingLabel : "Create account and join"}
    </Button>
  );
}

export function AcceptInvitationSignUpForm({
  token,
  email,
}: {
  token: string;
  email: string;
}) {
  const [state, formAction] = useActionState<SignUpResult | null, FormData>(
    acceptInvitationWithSignUpAction,
    null,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <input type="hidden" name="token" value={token} />

      {/*
        `readOnly` rather than `disabled`: a disabled input is not submitted,
        and while the server ignores this value anyway, a field that silently
        vanishes from the payload is a trap for whoever edits this next.
      */}
      <AuthField
        name="email"
        label="Email"
        type="email"
        defaultValue={email}
        readOnly
        autoComplete="email"
        hint="Set by the invitation."
      />

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

      <SubmitButton pendingLabel="Creating your account…" />
    </form>
  );
}
