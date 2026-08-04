"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { AlertTriangle, CheckCircle2, Mail } from "lucide-react";
import {
  requestPasswordResetAction,
  type ResetRequestResult,
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
      icon={Mail}
      className="w-full"
      disabled={pending}
    >
      {pending ? "Sending…" : "Send reset link"}
    </Button>
  );
}

export function ForgotPasswordForm() {
  const [state, formAction] = useActionState<ResetRequestResult | null, FormData>(
    requestPasswordResetAction,
    null,
  );

  // Deliberately the same message whether or not the address exists. Confirming
  // an account would let anyone walk a list of addresses through this page —
  // which needs no session — and learn which ones are customers.
  if (state?.sent) {
    return (
      <p
        role="status"
        className="flex items-start gap-2 rounded-lg border border-green-600/20 bg-green-100 px-3 py-2.5 text-[13px] text-gray-950"
      >
        <CheckCircle2 className="mt-px size-4 shrink-0 text-green-600" aria-hidden />
        <span>
          If an account exists for that address, a reset link is on its way. The
          link works once and expires after an hour.
        </span>
      </p>
    );
  }

  return (
    <form action={formAction} className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <label htmlFor="email" className="text-[13px] font-medium text-gray-950">
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          autoFocus
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
