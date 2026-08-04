"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check } from "lucide-react";
import { acceptInvitationAction } from "@/app/actions/invitations";
import { AuthError } from "@/components/auth/auth-shell";
import { Button } from "@/components/ui/button";

/**
 * Accept, for somebody already signed in as the invited person.
 *
 * One button, because there is nothing left to ask. The page has already
 * confirmed the session's address matches the invitation; everything else the
 * grant needs is bound into the invitation row.
 */
export function AcceptInvitationForm({
  token,
  organizationName,
}: {
  token: string;
  organizationName: string;
}) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function accept() {
    setError(null);
    startTransition(async () => {
      const result = await acceptInvitationAction({ token });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      // `refresh()` before navigating, so the organization switcher and the
      // sidebar are rebuilt with the membership that now exists. Without it the
      // overview renders against a cached tree that predates the join.
      router.refresh();
      router.push("/overview");
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <p className="text-[13px] text-gray-600">
        Accepting adds {organizationName} to your account. You can switch between
        organizations at any time.
      </p>

      {error ? <AuthError>{error}</AuthError> : null}

      <Button
        type="button"
        variant="primary"
        size="lg"
        icon={Check}
        className="w-full"
        disabled={pending}
        onClick={accept}
      >
        {pending ? "Joining…" : `Join ${organizationName}`}
      </Button>
    </div>
  );
}
