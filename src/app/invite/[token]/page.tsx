import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle } from "lucide-react";
import { AuthShell } from "@/components/auth/auth-shell";
import { AcceptInvitationForm } from "@/components/auth/accept-invitation-form";
import { AcceptInvitationSignUpForm } from "@/components/auth/accept-invitation-sign-up-form";
import type { InvitationState } from "@/domain";
import { getSession } from "@/lib/auth/session";
import {
  hashInvitationToken,
  isInvitationTokenShaped,
} from "@/lib/auth/invitation-token";
import { getDataSource } from "@/lib/data";
import { MEMBERSHIP_ROLE_LABELS } from "@/lib/labels";

export const metadata: Metadata = { title: "Join a team" };

/** No caching, ever: the answer depends on a one-time token and a session. */
export const dynamic = "force-dynamic";

/**
 * Accept an invitation.
 *
 * Public, because the person holding the link usually has no account yet. What
 * makes that safe is that the token is the only way to read anything here —
 * the page is keyed by its SHA-256 hash, so an anonymous visitor without a
 * link sees nothing, and one with a link sees only the organization they were
 * invited to.
 *
 * Three states, and each needs a different thing from the visitor:
 *
 * - **signed out** — create an account at the invited address, then join;
 * - **signed in as the invitee** — one button;
 * - **signed in as somebody else** — sign out first, because acceptance
 *   matches on email and would otherwise fail with a confusing message.
 */
export default async function InvitePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  if (!isInvitationTokenShaped(token)) {
    return <InvitationProblem reason="That invitation link is not valid." />;
  }

  const dataSource = await getDataSource();
  const invitation = await dataSource.invitations.preview(hashInvitationToken(token));

  if (!invitation) {
    return <InvitationProblem reason="That invitation link is not valid." />;
  }

  if (invitation.state !== "pending") {
    return <InvitationProblem reason={STATE_MESSAGES[invitation.state]} />;
  }

  const session = await getSession();
  const roleLabel = MEMBERSHIP_ROLE_LABELS[invitation.role];

  // Compared lower-cased, matching what the database does. A mismatch here is
  // shown as its own screen rather than left to fail on submit — being told
  // "that invitation cannot be accepted" while looking at a valid invitation
  // is the kind of dead end people file bugs about.
  const signedInAsInvitee =
    session !== null && session.email.trim().toLowerCase() === invitation.email;

  if (session && !signedInAsInvitee) {
    return (
      <AuthShell
        title="Signed in as someone else"
        description={`This invitation is for ${invitation.email}, but you are signed in as ${session.email}.`}
      >
        <p className="text-[13px] text-gray-600">
          Sign out and open the link again, or ask {invitation.organizationName} to
          invite {session.email} instead.
        </p>
        <Link
          href="/sign-in"
          className="mt-4 inline-flex text-[13px] font-medium text-purple-600 underline-offset-4 hover:underline"
        >
          Go to sign in
        </Link>
      </AuthShell>
    );
  }

  return (
    <AuthShell
      title={`Join ${invitation.organizationName}`}
      description={
        signedInAsInvitee
          ? `You have been invited as ${roleLabel.toLowerCase()}.`
          : `You have been invited as ${roleLabel.toLowerCase()}. Create your account to continue.`
      }
      footer={
        <p className="text-[12.5px] text-white/50">
          Invitation for {invitation.email}
        </p>
      }
    >
      {signedInAsInvitee ? (
        <AcceptInvitationForm
          token={token}
          organizationName={invitation.organizationName}
        />
      ) : (
        <AcceptInvitationSignUpForm token={token} email={invitation.email} />
      )}
    </AuthShell>
  );
}

/**
 * Why a link cannot be used.
 *
 * Keyed by `InvitationState` rather than `string`, so adding a state to the
 * vocabulary is a type error here instead of an undefined message rendering as
 * a blank warning box.
 */
const STATE_MESSAGES: Record<InvitationState, string> = {
  pending: "That invitation is still open.",
  accepted: "That invitation has already been used. Sign in instead.",
  revoked: "That invitation was withdrawn. Ask for a new one.",
  expired: "That invitation has expired. Ask for a new one.",
  unknown: "That invitation link is not valid.",
};

function InvitationProblem({ reason }: { reason: string }) {
  return (
    <AuthShell
      title="This link cannot be used"
      description="Invitations are single-use and expire after a week."
    >
      <p className="flex items-start gap-1.5 rounded-lg border border-amber-600/20 bg-amber-100 px-3 py-2.5 text-[13px] text-gray-950">
        <AlertTriangle className="mt-px size-4 shrink-0 text-amber-600" aria-hidden />
        {reason}
      </p>
      <Link
        href="/sign-in"
        className="mt-4 inline-flex text-[13px] font-medium text-purple-600 underline-offset-4 hover:underline"
      >
        Go to sign in
      </Link>
    </AuthShell>
  );
}
