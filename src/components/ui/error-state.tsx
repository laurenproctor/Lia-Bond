"use client";

import { AlertTriangle, RotateCw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";

export interface ErrorStateProps {
  title?: string;
  description?: string;
  /** Digest or reference shown so the failure can be traced in logs. */
  reference?: string;
  onRetry?: () => void;
  className?: string;
}

export function ErrorState({
  title = "Something went wrong",
  description = "We couldn't load this view. Try again, and if it keeps happening let your administrator know.",
  reference,
  onRetry,
  className,
}: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={cn(
        "lia-card flex flex-col items-center justify-center px-6 py-14 text-center",
        className,
      )}
    >
      <span className="inline-flex size-11 items-center justify-center rounded-full bg-red-100 text-red-600">
        <AlertTriangle className="size-5" aria-hidden />
      </span>
      <p className="mt-3 text-sm font-semibold text-gray-950">{title}</p>
      <p className="mt-1 max-w-md text-[13px] text-gray-500">{description}</p>
      {reference ? (
        <p className="mt-2 font-mono text-[11px] text-gray-400">
          Reference {reference}
        </p>
      ) : null}
      {onRetry ? (
        <Button className="mt-4" variant="secondary" icon={RotateCw} onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
