"use client";

import { useActionState } from "react";
import { useFormStatus } from "react-dom";
import { AlertTriangle, LogIn } from "lucide-react";
import { signInAction, type SignInResult } from "@/app/actions/auth";
import { Button } from "@/components/ui/button";

/**
 * Email and password sign-in.
 *
 * The credential is posted to a server action and never touches client state —
 * there is no `useState` holding a password here, so it cannot end up in a
 * React DevTools snapshot or an error-reporting payload.
 *
 * Progressive enhancement is free with a form action: this submits and works
 * before React has hydrated.
 */

function SubmitButton() {
  // Reads the parent form's state, which is why this is a separate component —
  // `useFormStatus` returns nothing useful when called in the same component
  // that renders the form.
  const { pending } = useFormStatus();

  return (
    <Button
      type="submit"
      variant="primary"
      size="lg"
      icon={LogIn}
      className="w-full"
      disabled={pending}
    >
      {pending ? "Signing in…" : "Sign in"}
    </Button>
  );
}

export function SignInForm({ next }: { next?: string }) {
  const [state, formAction] = useActionState<SignInResult | null, FormData>(
    signInAction,
    null,
  );

  return (
    <form action={formAction} className="flex flex-col gap-4">
      {next ? <input type="hidden" name="next" value={next} /> : null}

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="email"
          className="text-[13px] font-medium text-gray-950"
        >
          Email
        </label>
        <input
          id="email"
          name="email"
          type="email"
          autoComplete="email"
          required
          autoFocus
          className="h-11 rounded-[10px] border border-gray-300 bg-white px-3.5 text-[14px] text-gray-950 outline-none focus-visible:border-purple-600 focus-visible:ring-2 focus-visible:ring-purple-600/20"
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label
          htmlFor="password"
          className="text-[13px] font-medium text-gray-950"
        >
          Password
        </label>
        <input
          id="password"
          name="password"
          type="password"
          autoComplete="current-password"
          required
          className="h-11 rounded-[10px] border border-gray-300 bg-white px-3.5 text-[14px] text-gray-950 outline-none focus-visible:border-purple-600 focus-visible:ring-2 focus-visible:ring-purple-600/20"
        />
      </div>

      {/*
        One message for a wrong password and an unknown address alike. The
        server deliberately does not distinguish them — telling someone an
        address is not registered is a free account-enumeration oracle.
      */}
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
