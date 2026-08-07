"use client";

import { useId, useState, useTransition } from "react";
import {
  CheckCircle2,
  Info,
  Loader2,
  PencilLine,
  Send,
  ThumbsDown,
  ThumbsUp,
} from "lucide-react";
import {
  decideResponseDraftAction,
  saveResponseDraftAction,
} from "@/app/actions/responses";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { ResponseStatusBadge } from "@/components/ui/status-badge";
import { cn } from "@/lib/cn";
import { GENERATED_BY_LABELS, RESPONSE_TYPE_LABELS } from "@/lib/labels";
import { canEditDraft, type PublishingMode, type ResponseDraft } from "@/domain";

export interface ResponseComposerProps {
  draft: ResponseDraft;
  /** What the source connector actually permits. Drives the primary action. */
  publishing: PublishingMode;
  /** False for roles that may read a draft but not decide on it. */
  canDecide: boolean;
  /** Role-level edit permission; the composer also checks the status itself. */
  canEdit: boolean;
  className?: string;
}

const PUBLISHING_COPY: Record<PublishingMode, string> = {
  direct: "Lia can publish this reply directly to the source.",
  manual:
    "This source has no publishing API. Lia prepares the text and a person posts it.",
  unavailable:
    "Responses cannot be posted to this source. Use email or an owned channel instead.",
};

/**
 * Draft editor and decision row.
 *
 * The publishing sentence comes from the connector's own capabilities, so the
 * screen can never imply direct publishing where the platform does not offer
 * it. Approval and rejection go through the audited server action — this
 * component holds no authority of its own; `canDecide` only decides whether to
 * render the controls, and the action re-checks the role regardless.
 */
export function ResponseComposer({
  draft,
  publishing,
  canDecide,
  canEdit,
  className,
}: ResponseComposerProps) {
  const textareaId = useId();
  const [content, setContent] = useState(draft.finalText ?? draft.draftText);
  const [confirming, setConfirming] = useState<"approve" | "reject" | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const stored = draft.finalText ?? draft.draftText;
  const dirty = content !== stored;
  const editable = canEdit && canEditDraft(draft.status);

  function save() {
    setError(null);
    setOutcome(null);
    startTransition(async () => {
      const result = await saveResponseDraftAction({
        responseDraftId: draft.id,
        finalText: content,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOutcome("Draft saved.");
    });
  }

  function decide(decision: "approved" | "rejected") {
    setError(null);
    setOutcome(null);
    startTransition(async () => {
      const result = await decideResponseDraftAction({
        responseDraftId: draft.id,
        decision,
        ...(decision === "approved" && dirty && content.trim().length > 0
          ? { finalText: content }
          : {}),
      });

      setConfirming(null);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOutcome(
        decision === "approved"
          ? "Approved. It's ready for publishing."
          : "Sent back to draft.",
      );
    });
  }

  return (
    <div className={cn("flex min-w-0 flex-col gap-3", className)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-[15px] font-semibold text-gray-950">
          {RESPONSE_TYPE_LABELS[draft.responseType]}
        </h3>
        <div className="flex items-center gap-2">
          <span className="text-[12px] text-gray-500">
            {GENERATED_BY_LABELS[draft.generatedBy]}
          </span>
          <ResponseStatusBadge status={draft.status} />
        </div>
      </div>

      <div>
        <label htmlFor={textareaId} className="sr-only">
          Response draft
        </label>
        <textarea
          id={textareaId}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          rows={9}
          maxLength={5000}
          readOnly={!editable || pending}
          className="lia-scroll w-full resize-y rounded-[10px] border border-gray-300 bg-white px-3.5 py-3 text-[13.5px] leading-relaxed text-gray-950"
        />
        <p className="mt-1 text-right text-[12px] text-gray-400 tabular-nums">
          {content.length} characters
        </p>
        {canEdit && !canEditDraft(draft.status) ? (
          <p className="mt-1 text-[12px] text-gray-500">
            Approved responses can no longer be edited.
          </p>
        ) : null}
      </div>

      <p className="flex items-start gap-2 rounded-lg bg-gray-50 px-3 py-2 text-[12.5px] text-gray-700">
        <Info className="mt-px size-3.5 shrink-0 text-gray-500" aria-hidden />
        <span>{PUBLISHING_COPY[publishing]}</span>
      </p>

      {canDecide || editable ? (
        <div className="flex flex-wrap gap-2 border-t border-gray-200 pt-3">
          {canDecide ? (
            <>
              <Button
                variant="primary"
                icon={pending ? Loader2 : ThumbsUp}
                disabled={pending || content.trim().length === 0}
                onClick={() => setConfirming("approve")}
              >
                Approve
              </Button>
              <Button
                variant="secondary"
                icon={ThumbsDown}
                disabled={pending}
                onClick={() => setConfirming("reject")}
              >
                Send back
              </Button>
            </>
          ) : null}
          <Button
            variant="secondary"
            icon={pending ? Loader2 : PencilLine}
            disabled={pending || !editable || !dirty || content.trim().length === 0}
            onClick={save}
          >
            Save draft
          </Button>
          <Button
            variant={publishing === "direct" ? "primary" : "secondary"}
            icon={Send}
            disabled
          >
            {publishing === "direct" ? "Publish reply" : "Copy for manual publishing"}
          </Button>
        </div>
      ) : (
        <p className="border-t border-gray-200 pt-3 text-[12.5px] text-gray-500">
          Your role can read this response but not decide on it.
        </p>
      )}

      {outcome ? (
        <p
          role="status"
          className="flex items-center gap-1.5 text-[12.5px] font-medium text-green-600"
        >
          <CheckCircle2 className="size-3.5" aria-hidden />
          {outcome}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-[12.5px] font-medium text-red-600">
          {error}
        </p>
      ) : null}

      <ConfirmDialog
        open={confirming === "approve"}
        title="Approve this response"
        description={PUBLISHING_COPY[publishing]}
        confirmLabel="Approve"
        onCancel={() => setConfirming(null)}
        onConfirm={() => decide("approved")}
      >
        <p className="rounded-lg bg-gray-50 px-3 py-2 text-[12.5px] whitespace-pre-line text-gray-700">
          {content.slice(0, 220)}
          {content.length > 220 ? "…" : ""}
        </p>
      </ConfirmDialog>

      <ConfirmDialog
        open={confirming === "reject"}
        destructive
        title="Send this back to draft"
        description="The response returns to the writer. Nothing is published, and the decision is recorded in the audit trail."
        confirmLabel="Send back"
        onCancel={() => setConfirming(null)}
        onConfirm={() => decide("rejected")}
      />
    </div>
  );
}
