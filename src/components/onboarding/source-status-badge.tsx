import { CheckCircle2 } from "lucide-react";
import { cn } from "@/lib/cn";

/**
 * The status word on a step-2 source card.
 *
 * Always a word, never only a colour: "Connected" and "Configured" carry a
 * tick as reinforcement, but the text is what a screen reader gets and what
 * a colour-blind reader falls back on. The vocabulary is closed — a source
 * is recommended, optional, connected, configured, or not available yet —
 * so a card cannot invent a state ("Active", "Live") the system behind it
 * cannot prove.
 */

export type SourceStatus =
  | "recommended"
  | "optional"
  | "connected"
  | "configured"
  | "unavailable";

const STATUS_LABELS: Record<SourceStatus, string> = {
  recommended: "Recommended",
  optional: "Optional",
  connected: "Connected",
  configured: "Configured",
  unavailable: "Available after setup",
};

const STATUS_CLASSES: Record<SourceStatus, string> = {
  recommended: "bg-site-blue-tint text-site-blue",
  optional: "bg-site-tint text-site-muted",
  connected: "bg-green-100 text-green-600",
  configured: "bg-green-100 text-green-600",
  unavailable: "bg-site-tint text-site-muted",
};

export function SourceStatusBadge({ status }: { status: SourceStatus }) {
  const settled = status === "connected" || status === "configured";
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[11px] font-bold",
        STATUS_CLASSES[status],
      )}
    >
      {settled ? <CheckCircle2 className="size-3.5" aria-hidden /> : null}
      {STATUS_LABELS[status]}
    </span>
  );
}
