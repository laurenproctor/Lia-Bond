"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Loader2, Sparkles } from "lucide-react";
import { generateResponseDraftAction } from "@/app/actions/responses";
import { Button } from "@/components/ui/button";
import { resolveGenerateButtonView } from "@/lib/responses/generate-button-state";
import type { GenerationAttempt, Mention } from "@/domain";

export interface GenerateResponseButtonProps {
  mention: Mention;
  latestAttempt: GenerationAttempt | null;
  hasDraft: boolean;
  /** False for roles that may read the workspace but not ask for a draft. */
  canGenerate: boolean;
}

/**
 * The one control that asks Lia to write a reply.
 *
 * Holds no authority: `generateResponseDraftAction` re-checks the role and
 * `claim_generation_attempt` re-checks everything else, so the worst a stale
 * render can do is spend a request that comes back `in_progress` or
 * `draft_exists`. Both of those are successes, and both are shown as
 * information rather than as errors — the only red text here is a genuine
 * failure, in Lia's words.
 */
export function GenerateResponseButton({
  mention,
  latestAttempt,
  hasDraft,
  canGenerate,
}: GenerateResponseButtonProps) {
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const view = resolveGenerateButtonView(mention, latestAttempt, hasDraft);
  if (view.state === "hidden" || !canGenerate) return null;

  function generate() {
    setError(null);
    setNotice(null);
    startTransition(async () => {
      const result = await generateResponseDraftAction({ mentionId: mention.id });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      if (result.data.kind === "in_progress") {
        setNotice("A reply is already being written for this review.");
        return;
      }
      if (result.data.kind === "draft_exists") {
        setNotice("This review already has a draft.");
      }

      // The draft lives on the server; re-render the page around it rather
      // than holding a second copy of it in this component.
      router.refresh();
    });
  }

  const busy = pending || view.state === "pending";

  return (
    <div className="flex flex-col items-start gap-2">
      <Button
        variant="primary"
        icon={busy ? Loader2 : Sparkles}
        disabled={busy}
        onClick={generate}
      >
        {busy ? "Generating response" : view.label}
      </Button>

      {view.hint ? <p className="text-[12.5px] text-gray-500">{view.hint}</p> : null}

      {notice ? (
        <p role="status" className="text-[12.5px] text-gray-600">
          {notice}
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-[12.5px] font-medium text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}
