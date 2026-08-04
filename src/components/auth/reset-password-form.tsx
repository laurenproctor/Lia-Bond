"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { AlertTriangle, KeyRound } from "lucide-react";
import {
  updatePasswordAction,
  type UpdatePasswordResult,
} from "@/app/actions/auth";
import { AUTH_INPUT_CLASS } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";

function SubmitButton() {
  const { pending } = useFormStatus();

  return (
    <Button
      type="submit"
      variant="primary"
      size="lg"
      icon={KeyRound}
      className="w-full"
      disabled={pending}
    >
      {pending ? "Saving…" : "Set new password"}
    </Button>
  );
}

export function ResetPasswordForm({ minLength }: { minLength: number }) {
  const [state, formAction] = useActionState<UpdatePasswordResult | null, FormData>(
    updatePasswordAction,
    null,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="password" className="text-[13px] font-medium text-gray-950">
          New password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          // `new-password` rather than `current-password`, so a password
          // manager offers to generate one instead of filling the old one.
          autoComplete="new-password"
          minLength={minLength}
          required
          autoFocus
          className={AUTH_INPUT_CLASS}
          aria-describedby="password-hint"
        />
        <p id="password-hint" className="text-[12px] text-gray-500">
          At least {minLength} characters. Length is what matters — a manager
          will generate something better than any rule could ask for.
        </p>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="confirm" className="text-[13px] font-medium text-gray-950">
          Confirm new password
        </label>
        <input
          id="confirm"
          name="confirm"
          type="password"
          autoComplete="new-password"
          minLength={minLength}
          required
          className={AUTH_INPUT_CLASS}
        />
      </div>

      {state?.error ? (
        <p
          role="alert"
          className="flex items-start gap-1.5 rounded-lg border border-red-600/20 bg-red-100 px-3 py-2.5 text-[13px] text-gray-950"
        >
          <AlertTriangle className="mt-px size-4 shrink-0 text-red-600" aria-hidden />
          {state.error}
        </p>
      ) : null}

      <SubmitButton />
    </form>
  );
}
