"use client";

import { useState, useTransition } from "react";
import { Check, Copy, Loader2, Power, RefreshCw } from "lucide-react";
import {
  rotatePressWidgetEmbedIdAction,
  setPressWidgetStatusAction,
} from "@/app/actions/press-widget";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/cn";
import { buildEmbedSnippet } from "@/lib/widgets/snippet";
import type { PressWidgetStatus } from "@/domain";

/**
 * The press embed code, and the two controls that can take it off the internet.
 *
 * Separate from the configuration form on purpose. Saving a theme and
 * invalidating every snippet a customer has already published are not the same
 * class of act, and putting them under one button is how somebody does the
 * second while meaning the first.
 *
 * Rotation is behind a confirmation and reports the old id afterwards. Lia
 * cannot know which pages carry the old snippet, so telling the customer what
 * to search their site for is the only honest help available.
 *
 * Its own component rather than a generalisation of the review widget's panel.
 * The two differ in the actions they call and in whether those actions take a
 * location; the shared part is `buildEmbedSnippet`, which is where the two
 * snippets could actually diverge and therefore where sharing earns its keep.
 */

export interface PressWidgetEmbedPanelProps {
  publicId: string;
  status: PressWidgetStatus;
  origin: string;
  canManage: boolean;
}

export function PressWidgetEmbedPanel({
  publicId: initialPublicId,
  status: initialStatus,
  origin,
  canManage,
}: PressWidgetEmbedPanelProps) {
  const [pending, startTransition] = useTransition();
  const [publicId, setPublicId] = useState(initialPublicId);
  const [status, setStatus] = useState(initialStatus);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmingRotate, setConfirmingRotate] = useState(false);
  const [retiredId, setRetiredId] = useState<string | null>(null);

  const snippet = buildEmbedSnippet(origin, publicId, "press");

  async function copy() {
    setError(null);
    try {
      await navigator.clipboard.writeText(snippet);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard access is denied in some embedded browsers and over plain
      // HTTP. The textarea below is selectable, so saying so is a complete
      // answer rather than a dead end.
      setError("Could not copy automatically. Select the code and copy it.");
    }
  }

  function toggle() {
    setError(null);
    const next: PressWidgetStatus = status === "active" ? "disabled" : "active";

    startTransition(async () => {
      const result = await setPressWidgetStatusAction({ status: next });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setStatus(result.data.status);
    });
  }

  function rotate() {
    setError(null);
    setConfirmingRotate(false);

    startTransition(async () => {
      const result = await rotatePressWidgetEmbedIdAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPublicId(result.data.widget.publicId);
      setRetiredId(result.data.previousPublicId);
    });
  }

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[12px] font-medium",
            status === "active"
              ? "bg-green-100 text-green-600"
              : "bg-gray-100 text-gray-500",
          )}
        >
          <span
            className={cn(
              "size-1.5 rounded-full",
              status === "active" ? "bg-green-600" : "bg-gray-400",
            )}
            aria-hidden
          />
          {status === "active" ? "Live" : "Switched off"}
        </span>

        {canManage ? (
          <>
            <Button
              size="sm"
              icon={pending ? Loader2 : Power}
              disabled={pending}
              onClick={toggle}
            >
              {status === "active" ? "Switch off" : "Switch on"}
            </Button>
            <Button
              size="sm"
              icon={RefreshCw}
              disabled={pending}
              onClick={() => setConfirmingRotate(true)}
            >
              Regenerate embed code
            </Button>
          </>
        ) : null}
      </div>

      <label className="block">
        <span className="sr-only">Press widget embed code</span>
        <textarea
          readOnly
          value={snippet}
          rows={2}
          spellCheck={false}
          onFocus={(event) => event.currentTarget.select()}
          className="w-full resize-none rounded-lg border border-gray-300 bg-gray-50 px-2.5 py-2 font-mono text-[12px] leading-5 text-gray-950"
        />
      </label>

      <div className="flex flex-wrap items-center gap-2">
        <Button
          variant="primary"
          size="sm"
          icon={copied ? Check : Copy}
          onClick={copy}
        >
          {copied ? "Copied" : "Copy embed code"}
        </Button>
        <span className="text-[12px] text-gray-500">
          Paste both lines where the coverage should appear.
        </span>
      </div>

      {status === "disabled" ? (
        <p className="rounded-lg border border-gray-200 bg-gray-50 px-3 py-2 text-[12.5px] text-gray-700">
          The snippet stays on your pages while the widget is switched off — it
          shows a short line saying so, rather than a broken frame. Switch it
          back on to start showing coverage again.
        </p>
      ) : null}

      {retiredId ? (
        <p
          role="status"
          className="rounded-lg border border-amber-600/25 bg-amber-100 px-3 py-2 text-[12.5px] text-gray-950"
        >
          A new embed code has been issued. Any page still using{" "}
          <code className="font-mono">{retiredId}</code> has stopped showing your
          coverage — search your site for that value and replace those blocks
          with the code above.
        </p>
      ) : null}

      {error ? (
        <p
          role="alert"
          className="rounded-lg border border-red-600/25 bg-red-100 px-3 py-2 text-[12.5px] text-gray-950"
        >
          {error}
        </p>
      ) : null}

      <ConfirmDialog
        open={confirmingRotate}
        title="Regenerate the embed code?"
        description="Every page already using the current code will stop showing your press coverage until you replace it."
        confirmLabel="Regenerate code"
        destructive
        onConfirm={rotate}
        onCancel={() => setConfirmingRotate(false)}
      >
        <p className="text-[12.5px] text-gray-700">
          Lia cannot tell which of your pages carry the old snippet, and cannot
          undo this. Do it if the current code has been shared somewhere it
          should not have been — otherwise switching the widget off is the
          reversible option.
        </p>
      </ConfirmDialog>
    </div>
  );
}
