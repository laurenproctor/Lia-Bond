"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { X } from "lucide-react";
import { revokeInvitationAction } from "@/app/actions/invitations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { invitationState, type InvitationWithInviter } from "@/domain";
import { MEMBERSHIP_ROLE_LABELS } from "@/lib/labels";

/**
 * Invitations that have been sent and not yet used.
 *
 * Expired ones are still listed. An invitation that quietly disappeared when
 * it aged out would leave the inviter believing it was still outstanding, and
 * the fix — send another — is only obvious if the stale one is visible.
 */
export function PendingInvitations({
  invitations,
  canManage,
}: {
  invitations: InvitationWithInviter[];
  canManage: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  if (invitations.length === 0) {
    return (
      <p className="px-5 pb-5 text-[13px] text-gray-500">
        No pending invitations.
      </p>
    );
  }

  function revoke(invitationId: string) {
    setError(null);
    startTransition(async () => {
      const result = await revokeInvitationAction({ invitationId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col">
      {error ? (
        <p role="alert" className="px-5 pb-2 text-[12.5px] text-red-600">
          {error}
        </p>
      ) : null}

      <ul className="divide-y divide-gray-200 border-t border-gray-200">
        {invitations.map((invitation) => {
          const expired = invitationState(invitation) === "expired";

          return (
            <li
              key={invitation.id}
              className="flex items-center justify-between gap-3 px-5 py-3"
            >
              <span className="min-w-0">
                <span className="block truncate text-[13.5px] font-medium text-gray-950">
                  {invitation.email}
                </span>
                <span className="block text-[12px] text-gray-500">
                  {MEMBERSHIP_ROLE_LABELS[invitation.role]}
                  {invitation.invitedByName ? ` · invited by ${invitation.invitedByName}` : ""}
                </span>
              </span>

              <span className="flex shrink-0 items-center gap-2">
                <Badge tone={expired ? "amber" : "neutral"}>
                  {expired ? "Expired" : "Pending"}
                </Badge>

                {canManage ? (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    icon={X}
                    disabled={pending}
                    onClick={() => revoke(invitation.id)}
                  >
                    Revoke
                  </Button>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
