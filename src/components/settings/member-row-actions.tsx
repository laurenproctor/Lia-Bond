"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Ban, RotateCcw, UserMinus } from "lucide-react";
import {
  removeMemberAction,
  updateMemberRoleAction,
  updateMemberStatusAction,
} from "@/app/actions/members";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { MEMBERSHIP_ROLES, type MembershipRole, type MembershipWithUser } from "@/domain";
import { MEMBERSHIP_ROLE_LABELS } from "@/lib/labels";

/**
 * Role, suspension, and removal for one member.
 *
 * Every control here is absent rather than disabled when it does not apply.
 * A greyed-out "remove" on your own row invites the question "why not?", and
 * the answer — you would lock yourself out — is not something a tooltip
 * conveys well. Not rendering it says the same thing without the dead end.
 *
 * The server re-checks all of it. These rules exist so the interface tells the
 * truth about what will happen, not to enforce anything.
 */
export function MemberRowActions({
  member,
  actingUserId,
  actingRole,
  isLastOwner,
}: {
  member: MembershipWithUser;
  actingUserId: string;
  actingRole: MembershipRole;
  /** Whether this member is the only active owner left. */
  isLastOwner: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [confirmingRemoval, setConfirmingRemoval] = useState(false);

  const isSelf = member.userId === actingUserId;

  // Only owners may create or unmake owners. Without this an admin could
  // promote themselves, which would make the two roles the same thing.
  const canTouchOwnership = actingRole === "owner";
  const targetIsOwner = member.role === "owner";
  const locked = isSelf || isLastOwner || (targetIsOwner && !canTouchOwnership);

  const roleOptions = MEMBERSHIP_ROLES.filter(
    (role) => role !== "owner" || canTouchOwnership,
  );

  function run(action: () => Promise<{ ok: boolean; error?: string }>) {
    setError(null);
    startTransition(async () => {
      const result = await action();
      if (!result.ok) {
        setError(result.error ?? "That change could not be saved.");
        return;
      }
      router.refresh();
    });
  }

  if (locked) {
    return (
      <span className="text-[12px] text-gray-400">
        {isSelf
          ? "You"
          : isLastOwner
            ? "Only owner"
            : "Owner"}
      </span>
    );
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        <label className="sr-only" htmlFor={`role-${member.id}`}>
          Role for {member.user.fullName}
        </label>
        <select
          id={`role-${member.id}`}
          value={member.role}
          disabled={pending}
          onChange={(event) =>
            run(() =>
              updateMemberRoleAction({
                userId: member.userId,
                role: event.target.value,
              }),
            )
          }
          className="h-8 rounded-lg border border-gray-300 bg-white px-2 text-[12.5px] text-gray-950 outline-none focus-visible:border-purple-600 focus-visible:ring-2 focus-visible:ring-purple-600/20 disabled:opacity-50"
        >
          {roleOptions.map((role) => (
            <option key={role} value={role}>
              {MEMBERSHIP_ROLE_LABELS[role]}
            </option>
          ))}
        </select>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          icon={member.status === "active" ? Ban : RotateCcw}
          disabled={pending}
          onClick={() =>
            run(() =>
              updateMemberStatusAction({
                userId: member.userId,
                status: member.status === "active" ? "suspended" : "active",
              }),
            )
          }
        >
          {member.status === "active" ? "Suspend" : "Restore"}
        </Button>

        <Button
          type="button"
          variant="ghost"
          size="sm"
          icon={UserMinus}
          disabled={pending}
          onClick={() => setConfirmingRemoval(true)}
        >
          Remove
        </Button>
      </div>

      {error ? (
        <p role="alert" className="text-[12px] text-red-600">
          {error}
        </p>
      ) : null}

      <ConfirmDialog
        open={confirmingRemoval}
        title={`Remove ${member.user.fullName}?`}
        description={`They lose access to this organization immediately. Their account and anything they did stay on the record, and you can invite them again later.`}
        confirmLabel="Remove"
        destructive
        onCancel={() => setConfirmingRemoval(false)}
        onConfirm={() => {
          setConfirmingRemoval(false);
          run(() => removeMemberAction({ userId: member.userId }));
        }}
      />
    </div>
  );
}
