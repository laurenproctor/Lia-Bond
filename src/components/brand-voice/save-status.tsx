"use client";

import { AlertCircle, Check, Loader2 } from "lucide-react";
import { statusLabel, type AutosaveStatus } from "@/lib/brand-voice/autosave-status";
import { cn } from "@/lib/cn";

export interface SaveStatusProps {
  status: AutosaveStatus;
}

const TONE: Record<AutosaveStatus, string> = {
  hidden: "",
  unsaved: "text-gray-500",
  saving: "text-gray-500",
  saved: "text-green-600",
  failed: "text-red-600",
};

/**
 * Whether the current state is on the server.
 *
 * Rendered as the form's first row rather than inside `PageHeader`: the header
 * is server-rendered by the page while this state lives in the client form, and
 * a context provider for one string is not worth the indirection.
 *
 * The live region is always present, even while `hidden`, so a screen reader
 * announces the first transition. Mounting the region and its content together
 * would mean the first change goes unannounced.
 */
export function SaveStatus({ status }: SaveStatusProps) {
  const label = statusLabel(status);

  return (
    <p
      aria-live="polite"
      className={cn(
        "flex min-h-5 items-center justify-end gap-1.5 text-[13px]",
        TONE[status],
      )}
    >
      {status === "saving" ? (
        <Loader2 className="size-3.5 animate-spin" aria-hidden />
      ) : null}
      {status === "saved" ? <Check className="size-3.5" aria-hidden /> : null}
      {status === "failed" ? (
        <AlertCircle className="size-3.5" aria-hidden />
      ) : null}
      {label}
    </p>
  );
}
