"use client";

import { useEffect, useId, useRef } from "react";
import type { ReactNode } from "react";
import { AlertTriangle } from "lucide-react";
import { Button, type ButtonVariant } from "@/components/ui/button";
import { cn } from "@/lib/cn";

export interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  cancelLabel?: string;
  /** Marks the action as irreversible: red confirm button and a warning mark. */
  destructive?: boolean;
  confirmVariant?: ButtonVariant;
  onConfirm: () => void;
  onCancel: () => void;
  /** Extra context — what will be published, where, and by whom. */
  children?: ReactNode;
}

/**
 * Approval gate for high-risk actions.
 *
 * Built on `<dialog>` so focus trapping, Escape handling, and the inert
 * backdrop come from the platform rather than from a hand-rolled focus manager.
 */
export function ConfirmDialog({
  open,
  title,
  description,
  confirmLabel,
  cancelLabel = "Cancel",
  destructive = false,
  confirmVariant,
  onConfirm,
  onCancel,
  children,
}: ConfirmDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const descriptionId = useId();

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;

    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      aria-describedby={descriptionId}
      onCancel={(event) => {
        event.preventDefault();
        onCancel();
      }}
      onClick={(event) => {
        if (event.target === dialogRef.current) onCancel();
      }}
      className={cn(
        "m-auto w-[min(28rem,calc(100vw-2rem))] rounded-card border border-gray-200 bg-white p-0 text-gray-950 shadow-panel",
        "backdrop:bg-navy-950/40",
      )}
    >
      <div className="flex gap-3 p-5">
        {destructive ? (
          <span className="inline-flex size-9 shrink-0 items-center justify-center rounded-full bg-red-100 text-red-600">
            <AlertTriangle className="size-4.5" aria-hidden />
          </span>
        ) : null}
        <div className="min-w-0">
          <h2 id={titleId} className="text-[15px] font-semibold">
            {title}
          </h2>
          <div id={descriptionId} className="mt-1 text-[13px] text-gray-500">
            {description}
          </div>
          {children ? <div className="mt-3">{children}</div> : null}
        </div>
      </div>
      <div className="flex justify-end gap-2 border-t border-gray-200 px-5 py-3">
        <Button variant="secondary" onClick={onCancel}>
          {cancelLabel}
        </Button>
        <Button
          variant={confirmVariant ?? (destructive ? "destructive" : "primary")}
          onClick={onConfirm}
        >
          {confirmLabel}
        </Button>
      </div>
    </dialog>
  );
}
