"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Check, Copy, Lock, Plus, Users, X } from "lucide-react";
import {
  completeOnboardingTeamAction,
  skipOnboardingTeamAction,
  type IssuedOnboardingInvitation,
  type InvitationRowFailure,
} from "@/app/actions/onboarding";
import {
  OnboardingActions,
  OnboardingError,
  PrimaryAction,
  SecondaryLink,
  TertiaryAction,
} from "@/components/onboarding/onboarding-actions";
import {
  OnboardingCard,
  OnboardingNote,
  OnboardingStepHeader,
} from "@/components/onboarding/onboarding-card";
import { INVITABLE_ROLES, type InvitableRole } from "@/domain";
import { MEMBERSHIP_ROLE_LABELS } from "@/lib/labels";

/**
 * Step 5's form.
 *
 * Two things about this screen are load-bearing and easy to get wrong:
 *
 * 1. **It never claims an email was sent.** Lia issues copyable links. The
 *    button says "Create invitation links", the results panel says the links
 *    must be shared, and the "what happens next" list says the same. Nothing on
 *    this screen contains the word "sent".
 * 2. **A link is shown exactly once.** The raw token is not persisted, not
 *    logged, and not audited — only its SHA-256 hash reaches the database — so
 *    a link that is not copied from this panel cannot be recovered. It can only
 *    be revoked and reissued from `/settings`, which the panel says.
 *
 * Failures are per row. One invalid address must not discard the links already
 * generated beside it, because those links cannot be regenerated.
 */

export interface OwnerRow {
  name: string;
  email: string;
  initials: string;
}

interface TeammateRow {
  /** Local only. Not submitted — the invitation carries an address and a role. */
  id: string;
  name: string;
  email: string;
  role: InvitableRole;
}

const ROLE_OPTIONS = INVITABLE_ROLES.map((role) => ({
  value: role,
  label: MEMBERSHIP_ROLE_LABELS[role],
}));

let rowSequence = 0;
function newRow(): TeammateRow {
  rowSequence += 1;
  return { id: `row-${rowSequence}`, name: "", email: "", role: "admin" };
}

export function TeamStepForm({
  owner,
  brandVoiceSaved,
  locationsConfigured,
}: {
  owner: OwnerRow;
  brandVoiceSaved: boolean;
  locationsConfigured: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [rows, setRows] = useState<TeammateRow[]>([newRow()]);
  const [error, setError] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedOnboardingInvitation[]>([]);
  const [failures, setFailures] = useState<InvitationRowFailure[]>([]);
  const [nextPath, setNextPath] = useState<string | null>(null);

  function updateRow(id: string, update: Partial<TeammateRow>) {
    setRows((current) =>
      current.map((row) => (row.id === id ? { ...row, ...update } : row)),
    );
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    setError(null);
    setFailures([]);

    const teammates = rows
      .filter((row) => row.email.trim().length > 0)
      .map((row) => ({ email: row.email.trim(), role: row.role }));

    if (teammates.length === 0) {
      setError(
        "Add at least one work email, or choose Skip for now to finish without inviting anybody.",
      );
      return;
    }

    startTransition(async () => {
      const result = await completeOnboardingTeamAction({ teammates });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      setIssued(result.data.issued);
      setFailures(result.data.failures);
      // Setup is complete either way; the person stays here until they have
      // copied the links, because leaving loses them permanently.
      setNextPath(result.data.nextPath);
    });
  }

  function skip() {
    if (pending) return;
    setError(null);
    startTransition(async () => {
      const result = await skipOnboardingTeamAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(result.data.nextPath);
    });
  }

  // Once links exist the form is replaced: re-submitting would issue a second
  // set and the first would be unrecoverable.
  if (nextPath) {
    return (
      <IssuedLinksPanel
        issued={issued}
        failures={failures}
        onContinue={() => router.push(nextPath)}
      />
    );
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-6">
      <OnboardingCard className="flex flex-col gap-6">
        <OnboardingStepHeader
          icon={Users}
          title="Invite teammates"
          description="Invite your team to help manage your reputation. You can always add more people or change roles later."
        />

        <div className="flex flex-col gap-3">
          {/* The owner. Locked, with no remove control: the database refuses to
              leave an organization with no active owner, so an editable row
              here would offer something that cannot happen. */}
          <div className="flex items-center gap-3 rounded-xl border border-site-border bg-site-tint px-3 py-3">
            <span
              className="flex size-9 shrink-0 items-center justify-center rounded-full bg-site-blue-tint text-[12px] font-bold text-site-blue"
              aria-hidden
            >
              {owner.initials}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-[14px] font-semibold text-site-ink">
                You ({owner.name})
              </p>
              <p className="truncate text-[12.5px] text-site-body">{owner.email}</p>
            </div>
            <span className="hidden text-[13px] font-semibold text-site-body sm:block">
              Owner
            </span>
            <Lock className="size-4 shrink-0 text-site-muted" aria-hidden />
            <span className="sr-only">
              Your own membership. It cannot be changed here.
            </span>
          </div>

          {rows.map((row, index) => (
            <div
              key={row.id}
              // The four-column layout waits for `xl`, not `sm`. Between `lg`
              // and `xl` the contextual panel takes a third of the width, so
              // the card is at its narrowest exactly where a `sm:` grid would
              // already be four columns wide — which overflowed at 1024px.
              //
              // Aligned to the *top*, not the bottom. Under `items-end` a
              // column that grows even slightly taller than its neighbours
              // drags its own label and control upward, and the email field
              // grows for reasons this component does not control: password
              // managers attach their badge to it and nothing else. Anchoring
              // to the top means each control sits at label height + gap, which
              // is identical in all three columns, and anything appended below
              // a control can only extend downward.
              className="grid gap-3 rounded-xl border border-site-border p-3 sm:grid-cols-2 xl:grid-cols-[1fr_1.3fr_auto_auto] xl:items-start"
            >
              <div className="flex min-w-0 flex-col gap-1.5">
                <label
                  htmlFor={`${row.id}-name`}
                  className="text-[12.5px] leading-[18px] font-semibold text-site-ink"
                >
                  Name
                  <span className="ml-1 font-normal text-site-muted">(optional)</span>
                </label>
                <input
                  id={`${row.id}-name`}
                  type="text"
                  value={row.name}
                  maxLength={160}
                  autoComplete="off"
                  placeholder="Maria Thompson"
                  onChange={(event) => updateRow(row.id, { name: event.target.value })}
                  className="min-h-[44px] rounded-xl border border-site-field bg-white px-3 text-[14px] text-site-ink placeholder:text-site-muted focus:border-site-blue focus:outline-none"
                />
                <span className="sr-only">
                  Used on this form only. Their name comes from the account they
                  create.
                </span>
              </div>

              <div className="flex min-w-0 flex-col gap-1.5">
                <label
                  htmlFor={`${row.id}-email`}
                  className="text-[12.5px] leading-[18px] font-semibold text-site-ink"
                >
                  Work email
                </label>
                <input
                  id={`${row.id}-email`}
                  type="email"
                  inputMode="email"
                  autoComplete="off"
                  value={row.email}
                  placeholder="maria@yourcompany.com"
                  onChange={(event) => updateRow(row.id, { email: event.target.value })}
                  className="min-h-[44px] rounded-xl border border-site-field bg-white px-3 text-[14px] text-site-ink placeholder:text-site-muted focus:border-site-blue focus:outline-none"
                />
              </div>

              <div className="flex min-w-0 flex-col gap-1.5">
                <label
                  htmlFor={`${row.id}-role`}
                  className="text-[12.5px] leading-[18px] font-semibold text-site-ink"
                >
                  Role
                </label>
                {/* Owner is absent from `INVITABLE_ROLES` and therefore from
                    this list. Ownership is transferred between people who
                    already share an organization, never handed to an address
                    over a link. */}
                <select
                  id={`${row.id}-role`}
                  value={row.role}
                  onChange={(event) =>
                    updateRow(row.id, { role: event.target.value as InvitableRole })
                  }
                  className="min-h-[44px] rounded-xl border border-site-field bg-white px-3 text-[14px] text-site-ink focus:border-site-blue focus:outline-none"
                >
                  {ROLE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>

              <div className="flex flex-col gap-1.5">
                {/* Stands in for the label the other three columns have, so the
                    button lands on the control row rather than the label row.
                    It matches `leading-[18px]` above. Hidden in the one-column
                    layout, where the button has no neighbour to line up with. */}
                <span aria-hidden className="hidden h-[18px] sm:block" />
                <button
                  type="button"
                  onClick={() =>
                    setRows((current) => current.filter((r) => r.id !== row.id))
                  }
                  disabled={rows.length === 1}
                  aria-label={`Remove teammate ${index + 1}`}
                  className="inline-flex size-11 items-center justify-center rounded-xl text-site-muted transition-colors hover:bg-site-tint hover:text-site-ink disabled:opacity-40"
                >
                  <X className="size-4" aria-hidden />
                </button>
              </div>
            </div>
          ))}

          <button
            type="button"
            onClick={() => setRows((current) => [...current, newRow()])}
            disabled={rows.length >= 20}
            className="inline-flex min-h-[44px] w-fit items-center gap-2 rounded-xl px-3 text-[14px] font-semibold text-site-blue transition-colors hover:bg-site-blue-tint disabled:opacity-50"
          >
            <Plus className="size-4" aria-hidden />
            Add another teammate
          </button>
        </div>

        <WhatHappensNext
          brandVoiceSaved={brandVoiceSaved}
          locationsConfigured={locationsConfigured}
        />

        {error ? <OnboardingError>{error}</OnboardingError> : null}

        <OnboardingActions
          primary={
            <PrimaryAction pending={pending} pendingLabel="Creating links…">
              Finish setup
            </PrimaryAction>
          }
          secondary={<SecondaryLink href="/onboarding/brand-voice">Back</SecondaryLink>}
          tertiary={
            <TertiaryAction type="button" disabled={pending} onClick={skip}>
              Skip for now
            </TertiaryAction>
          }
          note="Teammates can be invited anytime from Settings."
        />
      </OnboardingCard>
    </form>
  );
}

/**
 * What finishing actually does.
 *
 * Every line is checked against real state before it is written. "Your brand
 * voice has been saved" appears only when it has, and the invitation line says
 * links can be copied and shared — never that anybody will receive an email,
 * because nobody will.
 */
function WhatHappensNext({
  brandVoiceSaved,
  locationsConfigured,
}: {
  brandVoiceSaved: boolean;
  locationsConfigured: boolean;
}) {
  const lines = [
    "Your workspace setup will be completed.",
    locationsConfigured
      ? "Your connected locations will be available."
      : "You can connect locations at any time from your workspace.",
    brandVoiceSaved
      ? "Your brand voice has been saved."
      : "You can set your brand voice at any time from your workspace.",
    "Invitation links can be copied and shared with your teammates.",
  ];

  return (
    <OnboardingNote title="What happens next">
      <ul className="flex flex-col gap-1">
        {lines.map((line) => (
          <li key={line} className="flex gap-2">
            <Check className="mt-0.5 size-3.5 shrink-0" strokeWidth={3} aria-hidden />
            {line}
          </li>
        ))}
      </ul>
    </OnboardingNote>
  );
}

/**
 * The links, shown once.
 *
 * `Copy` uses the async clipboard API, which needs a secure context. The link
 * is also rendered as selectable text in a `<code>` block, so somebody on plain
 * HTTP — or with clipboard permission denied — can still select it by hand
 * rather than losing the invitation entirely.
 */
function IssuedLinksPanel({
  issued,
  failures,
  onContinue,
}: {
  issued: IssuedOnboardingInvitation[];
  failures: InvitationRowFailure[];
  onContinue: () => void;
}) {
  const [copied, setCopied] = useState<string | null>(null);

  async function copy(url: string, email: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(email);
      window.setTimeout(() => setCopied(null), 2500);
    } catch {
      // Clipboard refused — a non-secure context, or a denied permission. The
      // link is still on screen and selectable, so nothing is lost; saying
      // "copied" here would be the actual failure.
      setCopied(null);
    }
  }

  return (
    <OnboardingCard className="flex flex-col gap-6">
      <OnboardingStepHeader
        icon={Users}
        title="Copy these invitation links now"
        description="Lia does not email invitations. Send each link to the person it belongs to — this is the only time it is shown."
      />

      {issued.length > 0 ? (
        <ul className="flex flex-col gap-3">
          {issued.map((invitation) => (
            <li
              key={invitation.email}
              className="flex flex-col gap-2 rounded-xl border border-site-border p-3"
            >
              <div className="flex flex-wrap items-baseline justify-between gap-2">
                <p className="text-[14px] font-semibold text-site-ink">
                  {invitation.email}
                </p>
                <p className="text-[12px] text-site-muted">
                  Expires{" "}
                  {new Date(invitation.expiresAt).toLocaleDateString(undefined, {
                    year: "numeric",
                    month: "long",
                    day: "numeric",
                  })}
                </p>
              </div>

              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <code className="min-w-0 flex-1 truncate rounded-lg bg-site-tint px-3 py-2.5 font-mono text-[12px] text-site-body select-all">
                  {invitation.url}
                </code>
                <button
                  type="button"
                  onClick={() => copy(invitation.url, invitation.email)}
                  className="inline-flex min-h-[44px] items-center justify-center gap-2 rounded-xl border border-site-blue-edge bg-white px-4 text-[13.5px] font-semibold text-site-blue transition-colors hover:bg-site-blue-tint"
                >
                  {copied === invitation.email ? (
                    <>
                      <Check className="size-4" aria-hidden />
                      Copied
                    </>
                  ) : (
                    <>
                      <Copy className="size-4" aria-hidden />
                      Copy invitation link
                    </>
                  )}
                </button>
              </div>
              {/* Announced rather than left to the icon swap alone. */}
              <span aria-live="polite" className="sr-only">
                {copied === invitation.email
                  ? `Invitation link for ${invitation.email} copied.`
                  : ""}
              </span>
            </li>
          ))}
        </ul>
      ) : null}

      {failures.length > 0 ? (
        <div className="rounded-xl border border-site-amber-edge/40 bg-site-amber-tint px-4 py-3">
          <p className="text-[13.5px] font-semibold text-site-amber-ink">
            {failures.length === 1
              ? "One invitation could not be created"
              : `${failures.length} invitations could not be created`}
          </p>
          <ul className="mt-1.5 flex flex-col gap-1">
            {failures.map((failure) => (
              <li key={failure.email} className="text-[13px] text-site-amber-ink">
                <strong className="font-semibold">{failure.email}</strong> —{" "}
                {failure.message}
              </li>
            ))}
          </ul>
          <p className="mt-2 text-[12.5px] text-site-amber-ink">
            You can invite them again from Settings. Setup is already complete.
          </p>
        </div>
      ) : null}

      <OnboardingNote title="Links are shown once">
        Lia stores only a hash of each link, so it cannot show one again. If a link
        is lost, revoke the invitation in Settings and issue a new one.
      </OnboardingNote>

      <OnboardingActions
        primary={
          <PrimaryAction type="button" onClick={onContinue}>
            I&rsquo;ve copied them — continue
          </PrimaryAction>
        }
      />
    </OnboardingCard>
  );
}
