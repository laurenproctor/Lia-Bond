"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  RotateCw,
  ShieldAlert,
  Sparkles,
} from "lucide-react";
import { analyzeMentionsAction } from "@/app/actions/analysis";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { formatNumber, formatRelativeLong } from "@/lib/format";

/**
 * The analysis backlog, and the button that drains it.
 *
 * Lives on the inbox because that is where the backlog is visible — the count
 * and the action belong together, rather than the count being here and the
 * control somewhere an operator has to go looking for.
 *
 * A client component because the run reports an outcome somebody has to read:
 * how many were analysed, how many were escalated, and how many are still
 * waiting. A server-rendered page cannot show that without a round trip that
 * loses the message.
 */

export interface AnalysisPanelProps {
  unanalyzedCount: number;
  /** End of the last run that got through anything. */
  lastRunAt: string | null;
  /** The latest run's outcome, whether or not it succeeded. */
  lastStatus: string | null;
  /** Lia's own sentence about the last failure. Never the provider's. */
  lastErrorMessage: string | null;
  /** A run held the lock when the page rendered. */
  running: boolean;
  canAnalyze: boolean;
  /** False when no analysis provider is configured on this server. */
  available: boolean;
}

interface Feedback {
  tone: "success" | "warning";
  message: string;
}

export function AnalysisPanel({
  unanalyzedCount,
  lastRunAt,
  lastStatus,
  lastErrorMessage,
  running,
  canAnalyze,
  available,
}: AnalysisPanelProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const busy = running || pending;

  function runAnalysis() {
    setFeedback(null);

    startTransition(async () => {
      const result = await analyzeMentionsAction({});

      setFeedback(
        result.ok
          ? {
              tone: result.data.degraded ? "warning" : "success",
              message: result.data.message,
            }
          : { tone: "warning", message: result.error },
      );

      // Refreshes the backlog count and the queue itself — the action
      // revalidated both, along with the escalations any run may have raised.
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-[13px] font-medium text-gray-950">
            <Sparkles className="size-3.5 shrink-0 text-purple-600" aria-hidden />
            {unanalyzedCount === 0
              ? "Everything is analyzed"
              : `${formatNumber(unanalyzedCount)} ${
                  unanalyzedCount === 1 ? "mention" : "mentions"
                } not yet analyzed`}
          </p>

          <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-gray-500">
            <span>
              {lastRunAt
                ? `Last analyzed ${formatRelativeLong(lastRunAt)}`
                : "Never analyzed"}
            </span>
            {/*
              Said plainly rather than implied by a green badge. An operator who
              assumed analysis was continuous would treat an un-triaged queue as
              an empty one.
            */}
            <span>Runs when you ask it to — not continuously.</span>
          </p>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {running ? <Badge tone="amber">Analyzing</Badge> : null}

          {canAnalyze ? (
            <Button
              size="sm"
              variant="primary"
              icon={busy ? RotateCw : Sparkles}
              onClick={runAnalysis}
              disabled={busy || !available || unanalyzedCount === 0}
            >
              {busy ? "Analyzing…" : "Analyze"}
            </Button>
          ) : null}
        </div>
      </div>

      {!available ? (
        <p className="rounded-lg border border-gray-200 bg-gray-50 px-2.5 py-2 text-[12.5px] text-gray-700">
          Analysis is not configured on this server. Your administrator needs to
          set an analysis API key before mentions can be classified.
        </p>
      ) : null}

      {/*
        The stored error from a previous run, shown until a later run clears it.
        A failure that vanishes on reload is a failure nobody can act on.
      */}
      {!feedback && lastStatus === "failed" && lastErrorMessage ? (
        <p
          role="status"
          className="flex items-start gap-1.5 rounded-lg border border-amber-600/20 bg-amber-100 px-2.5 py-2 text-[12.5px] text-gray-950"
        >
          <AlertTriangle className="mt-px size-3.5 shrink-0 text-amber-600" aria-hidden />
          {lastErrorMessage}
        </p>
      ) : null}

      {feedback ? (
        <p
          role="status"
          className={cn(
            "flex items-start gap-1.5 rounded-lg border px-2.5 py-2 text-[12.5px] text-gray-950",
            feedback.tone === "success"
              ? "border-green-600/20 bg-green-100"
              : "border-amber-600/20 bg-amber-100",
          )}
        >
          {feedback.tone === "success" ? (
            <CheckCircle2 className="mt-px size-3.5 shrink-0 text-green-600" aria-hidden />
          ) : (
            <ShieldAlert className="mt-px size-3.5 shrink-0 text-amber-600" aria-hidden />
          )}
          {feedback.message}
        </p>
      ) : null}
    </div>
  );
}
