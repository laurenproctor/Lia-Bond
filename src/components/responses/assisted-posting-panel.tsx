"use client";

import { useState, useTransition } from "react";
import { Check, Copy, ExternalLink, Loader2, Undo2 } from "lucide-react";
import {
  confirmResponsePublicationAction,
  unconfirmResponsePublicationAction,
} from "@/app/actions/responses";
import { Button, ButtonLink } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/cn";
import type { ResponseDraft } from "@/domain";

/**
 * The assisted-posting handoff: copy, open, confirm.
 *
 * Three controls that look like a publish button and are deliberately not one.
 * The distinctions this component exists to keep visible:
 *
 * - **Copy changes nothing.** It writes to the clipboard and says so. There is
 *   no server action behind it, which is the strongest possible guarantee that
 *   it cannot move a status.
 * - **Open changes nothing.** It is an anchor to a URL the server already
 *   validated against the Yelp host allowlist. It carries
 *   `rel="noopener noreferrer"`, and it is rendered as a link rather than a
 *   scripted `window.open` so a person can see where it goes before clicking.
 * - **Mark as posted is a claim a person makes**, so it takes a deliberate
 *   confirmation and says in the dialog exactly what Lia will and will not
 *   record.
 *
 * The panel renders only for an approved or manually-published draft. Anything
 * earlier has nothing to post; anything published by a provider was not posted
 * this way and must not offer a withdrawal.
 */

export interface AssistedPostingPanelProps {
  draft: ResponseDraft;
  /**
   * The most specific trusted destination the server resolved: a review URL
   * when one was captured, otherwise the connected listing. Null when neither
   * survived validation, in which case no link is offered at all.
   */
  destinationUrl: string | null;
  /** Whether this destination is the review itself or the listing page. */
  destinationKind: "review" | "listing";
  /** False for roles that may read the draft but not confirm a publication. */
  canConfirm: boolean;
  className?: string;
}

export function AssistedPostingPanel({
  draft,
  destinationUrl,
  destinationKind,
  canConfirm,
  className,
}: AssistedPostingPanelProps) {
  const [pending, startTransition] = useTransition();
  const [copied, setCopied] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<"post" | "withdraw" | null>(null);
  const [withdrawReason, setWithdrawReason] = useState("");

  const text = draft.finalText ?? draft.draftText;
  const postedManually =
    draft.status === "published" && draft.publicationMethod === "manual_external";

  async function copy() {
    setError(null);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      // Deliberately transient. A permanent "copied" would still be on screen
      // when somebody came back from Yelp and read it as "posted".
      window.setTimeout(() => setCopied(false), 4000);
    } catch {
      setError(
        "Lia could not reach the clipboard. Select the response text above and copy it manually.",
      );
    }
  }

  function confirmPosted() {
    setConfirming(null);
    setError(null);
    startTransition(async () => {
      const result = await confirmResponsePublicationAction({
        responseDraftId: draft.id,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOutcome(
        result.data.alreadyConfirmed
          ? "Already recorded as posted."
          : "Recorded as posted on Yelp.",
      );
    });
  }

  function withdraw() {
    // Checked here as well as in the schema. The reason is the whole value of
    // the correction — a bare reversal in an audit trail reads as indecision —
    // and bouncing off a server-side field error would lose the typed text.
    if (withdrawReason.trim().length === 0) {
      setError("Say why this is being withdrawn, so the record explains itself.");
      return;
    }

    setConfirming(null);
    setError(null);
    startTransition(async () => {
      const result = await unconfirmResponsePublicationAction({
        responseDraftId: draft.id,
        reason: withdrawReason.trim(),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setWithdrawReason("");
      setOutcome("Posted confirmation withdrawn. The response is approved again.");
    });
  }

  return (
    <div className={cn("space-y-3 border-t border-gray-200 pt-3", className)}>
      {postedManually ? (
        <p className="flex items-start gap-2 rounded-lg bg-green-50 px-3 py-2 text-[12.5px] text-green-900">
          <Check className="mt-px size-3.5 shrink-0" aria-hidden />
          {/* States whose word this is. Lia did not observe the posting, and
              the copy must not let that be forgotten later. */}
          <span>
            Marked as posted on Yelp by a person. Lia did not post this and has no
            confirmation from Yelp.
          </span>
        </p>
      ) : null}

      <div className="flex flex-wrap gap-2">
        <Button
          variant="secondary"
          icon={copied ? Check : Copy}
          disabled={pending || text.trim().length === 0}
          onClick={copy}
        >
          {copied ? "Copied" : "Copy response"}
        </Button>

        {destinationUrl ? (
          <ButtonLink
            href={destinationUrl}
            target="_blank"
            // `noopener` is the load-bearing half: without it the opened page
            // gets a handle on this one through `window.opener`. `noreferrer`
            // keeps Lia's own URLs out of Yelp's referer logs.
            rel="noopener noreferrer"
            variant="secondary"
            icon={ExternalLink}
          >
            Open in Yelp
          </ButtonLink>
        ) : null}

        {canConfirm && !postedManually ? (
          <Button
            variant="primary"
            icon={pending ? Loader2 : Check}
            disabled={pending}
            onClick={() => setConfirming("post")}
          >
            Mark as posted
          </Button>
        ) : null}

        {canConfirm && postedManually ? (
          <Button
            variant="secondary"
            icon={pending ? Loader2 : Undo2}
            disabled={pending}
            onClick={() => setConfirming("withdraw")}
          >
            Not posted after all
          </Button>
        ) : null}
      </div>

      {destinationUrl === null ? (
        <p className="text-[12.5px] text-gray-500">
          Lia has no verified Yelp address for this review, so there is no link to
          open. Find it on Yelp yourself, then mark it as posted here.
        </p>
      ) : destinationKind === "listing" ? (
        <p className="text-[12.5px] text-gray-500">
          This opens the business listing rather than the review — Lia was not given
          a link to the review itself.
        </p>
      ) : null}

      {outcome ? (
        <p role="status" className="text-[12.5px] font-medium text-gray-950">
          {outcome}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-[12.5px] font-medium text-red-700">
          {error}
        </p>
      ) : null}

      <ConfirmDialog
        open={confirming === "post"}
        title="Mark this response as posted?"
        // Says what is recorded and what is not. Somebody confirming a
        // publication months before a dispute should have been told plainly
        // that Lia is recording their word for it.
        description="Lia will record that you posted this response on Yelp, with your name and the time. Lia cannot check Yelp, so this is your confirmation rather than a verified publication. You can withdraw it if you change your mind."
        confirmLabel="Mark as posted"
        onConfirm={confirmPosted}
        onCancel={() => setConfirming(null)}
      />

      <ConfirmDialog
        open={confirming === "withdraw"}
        title="Withdraw the posted confirmation?"
        description="The response goes back to approved and the posted record is cleared. Use this when the response was not actually posted — not when it was posted and then removed from Yelp."
        confirmLabel="Withdraw confirmation"
        onConfirm={withdraw}
        onCancel={() => {
          setConfirming(null);
          setWithdrawReason("");
        }}
      >
        <label className="block text-[12.5px] font-medium text-gray-950">
          Why is this being withdrawn?
          <textarea
            value={withdrawReason}
            onChange={(event) => setWithdrawReason(event.target.value)}
            rows={3}
            maxLength={1000}
            required
            className="mt-1 w-full rounded-lg border border-gray-300 px-3 py-2 text-[13px] font-normal text-gray-950 focus:border-purple-500 focus:outline-none focus:ring-2 focus:ring-purple-200"
            placeholder="Marked as posted by mistake."
          />
        </label>
      </ConfirmDialog>
    </div>
  );
}
