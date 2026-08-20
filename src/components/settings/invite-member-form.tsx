"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Check, Copy, UserPlus } from "lucide-react";
import { inviteMemberAction, type IssuedInvitation } from "@/app/actions/invitations";
import { Button } from "@/components/ui/button";
import { INVITABLE_ROLES } from "@/domain";
import type { InvitationDeliveryStatus } from "@/lib/email/invitation-message";
import { MEMBERSHIP_ROLE_LABELS } from "@/lib/labels";

/**
 * Invite somebody by email, and say what became of the invitation.
 *
 * Lia emails the link when a verified sender is configured, and shows it to the
 * inviter either way. The link is *not* hidden on a successful send: it costs
 * one line, and it is the only recovery available when a message goes to spam
 * or the address had a typo that is still a deliverable mailbox.
 *
 * The link is shown **once**. Nothing stores it — the server keeps only a
 * SHA-256 hash — so navigating away loses it and the remedy is to revoke and
 * re-invite. That is stated on screen rather than left to be discovered.
 *
 * The three outcomes that are not a send each say who has to do what next,
 * because "invitation created" alone reads as "we emailed them" and leaves an
 * inviter waiting on a message that was never going to arrive.
 *
 * Owner is absent from the picker on purpose: ownership is transferred between
 * people who already share an organization, not granted through a link.
 */

/** What the inviter is told, per outcome. Sentence case, and never a claim. */
const DELIVERY_COPY: Record<
  InvitationDeliveryStatus,
  { tone: "green" | "amber"; headline: string; detail: string }
> = {
  sent: {
    tone: "green",
    headline: "Invitation emailed to",
    detail:
      "Keep this link in case the email does not arrive — it is the same invitation.",
  },
  logged: {
    tone: "amber",
    headline: "Invitation created for",
    detail:
      "Email is in log mode on this server, so nothing was delivered. The message was written to the server log. Send this link yourself.",
  },
  not_configured: {
    tone: "amber",
    headline: "Invitation created for",
    detail:
      "Lia is not set up to send invitation email on this server, so nothing was delivered. Send this link yourself, or ask your administrator to configure a sender.",
  },
  failed: {
    tone: "amber",
    headline: "Invitation created for",
    detail:
      "We could not email it — the mail service refused the message. The invitation is valid, so send this link yourself.",
  },
};

const TONE_STYLES = {
  green: "border-green-600/20 bg-green-50",
  amber: "border-amber-600/20 bg-amber-100",
} as const;
export function InviteMemberForm() {
  const router = useRouter();
  const emailId = useId();
  const roleId = useId();

  const [issued, setIssued] = useState<IssuedInvitation | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit(formData: FormData) {
    setError(null);
    setCopied(false);

    startTransition(async () => {
      const result = await inviteMemberAction({
        email: formData.get("email"),
        role: formData.get("role"),
      });

      if (!result.ok) {
        setError(result.error);
        setIssued(null);
        return;
      }

      setIssued(result.data);
      router.refresh();
    });
  }

  async function copy() {
    if (!issued) return;
    try {
      await navigator.clipboard.writeText(issued.url);
      setCopied(true);
    } catch {
      // Clipboard access can be refused — an insecure origin, a permissions
      // policy, a browser that asks. The input is selectable, so the link is
      // still reachable; only the shortcut is lost.
      setCopied(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      <form action={submit} className="flex flex-col gap-3 sm:flex-row sm:items-end">
        <div className="flex flex-1 flex-col gap-1.5">
          <label htmlFor={emailId} className="text-[13px] font-medium text-gray-950">
            Email
          </label>
          <input
            id={emailId}
            name="email"
            type="email"
            required
            placeholder="name@restaurant.com"
            className="h-10 w-full rounded-[10px] border border-gray-300 bg-white px-3 text-[13.5px] text-gray-950 outline-none focus-visible:border-purple-600 focus-visible:ring-2 focus-visible:ring-purple-600/20"
          />
        </div>

        <div className="flex flex-col gap-1.5 sm:w-56">
          <label htmlFor={roleId} className="text-[13px] font-medium text-gray-950">
            Role
          </label>
          <select
            id={roleId}
            name="role"
            defaultValue="viewer"
            className="h-10 w-full rounded-[10px] border border-gray-300 bg-white px-3 text-[13.5px] text-gray-950 outline-none focus-visible:border-purple-600 focus-visible:ring-2 focus-visible:ring-purple-600/20"
          >
            {INVITABLE_ROLES.map((role) => (
              <option key={role} value={role}>
                {MEMBERSHIP_ROLE_LABELS[role]}
              </option>
            ))}
          </select>
        </div>

        <Button type="submit" variant="primary" icon={UserPlus} disabled={pending}>
          {pending ? "Inviting…" : "Invite"}
        </Button>
      </form>

      {error ? (
        <p
          role="alert"
          className="flex items-start gap-1.5 rounded-lg border border-red-600/20 bg-red-100 px-3 py-2.5 text-[13px] text-gray-950"
        >
          <AlertTriangle className="mt-px size-4 shrink-0 text-red-600" aria-hidden />
          {error}
        </p>
      ) : null}

      {issued ? (
        <div
          role="status"
          className={`flex flex-col gap-2 rounded-lg border px-3 py-3 ${
            TONE_STYLES[DELIVERY_COPY[issued.delivery].tone]
          }`}
        >
          <p className="text-[13px] text-gray-950">
            {DELIVERY_COPY[issued.delivery].headline}{" "}
            <span className="font-medium">{issued.email}</span>. The link works
            once and expires in seven days.
          </p>

          <div className="flex items-center gap-2">
            <input
              readOnly
              value={issued.url}
              aria-label="Invitation link"
              onFocus={(event) => event.currentTarget.select()}
              className="h-9 flex-1 rounded-lg border border-gray-300 bg-white px-2.5 font-mono text-[12px] text-gray-700 outline-none focus-visible:border-purple-600"
            />
            <Button
              type="button"
              variant="secondary"
              icon={copied ? Check : Copy}
              onClick={copy}
            >
              {copied ? "Copied" : "Copy"}
            </Button>
          </div>

          <p className="text-[12px] text-gray-500">
            {DELIVERY_COPY[issued.delivery].detail} We do not store it — if you
            lose it, revoke the invitation and send a new one.
          </p>
        </div>
      ) : null}
    </div>
  );
}
