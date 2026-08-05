"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, RotateCw, Trash2 } from "lucide-react";
import {
  deleteMonitoringQueryAction,
  pollMonitoringQueryAction,
  updateMonitoringQueryAction,
} from "@/app/actions/monitoring";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  QueryEditor,
  type MonitoringLocationOption,
} from "@/components/integrations/monitoring-query-form";
import { cn } from "@/lib/cn";
import type { MonitoringQuery } from "@/domain";

/**
 * Enable, poll, edit, and delete — for one existing monitoring query.
 *
 * Its own file, split out from `monitoring-query-form.tsx`, following the
 * codebase's one-client-concern-per-file convention (`rule-toggle.tsx`,
 * `connection-actions.tsx`): creating a query and managing an existing one
 * are different concerns that happen to both need a browser, not one concern.
 *
 * Edit matters more here than a normal CRUD nicety. `news_poll_runs` and
 * `news_rejected_candidates` both reference `monitoring_queries` with
 * `on delete cascade` — deleting a query destroys its entire poll history and
 * rejection log, the exact record D64 exists to make the relevance gate
 * falsifiable. Without an edit path, the only way to add a second keyword or
 * loosen a threshold would be delete-and-recreate, which erases the evidence
 * a person would tune against. Editing in place keeps that history intact.
 */

export interface MonitoringQueryRowActionsProps {
  query: MonitoringQuery;
  locations: MonitoringLocationOption[];
  canManage: boolean;
  canPoll: boolean;
  /** False when news monitoring is not configured on this deployment. */
  connectorAvailable: boolean;
}

interface RowFeedback {
  tone: "success" | "warning";
  message: string;
}

export function MonitoringQueryRowActions({
  query,
  locations,
  canManage,
  canPoll,
  connectorAvailable,
}: MonitoringQueryRowActionsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const [feedback, setFeedback] = useState<RowFeedback | null>(null);
  const [enabled, setEnabled] = useState(query.enabled);

  function toggleEnabled() {
    const next = !enabled;
    setEnabled(next);
    setFeedback(null);

    startTransition(async () => {
      const result = await updateMonitoringQueryAction({ queryId: query.id, enabled: next });

      if (!result.ok) {
        setEnabled(!next);
        setFeedback({ tone: "warning", message: result.error });
        return;
      }
      router.refresh();
    });
  }

  function pollNow() {
    setFeedback(null);
    startTransition(async () => {
      const result = await pollMonitoringQueryAction({ queryId: query.id });

      setFeedback(
        result.ok
          ? { tone: result.data.degraded ? "warning" : "success", message: result.data.message }
          : { tone: "warning", message: result.error },
      );
      router.refresh();
    });
  }

  function runDelete() {
    setConfirmOpen(false);
    setFeedback(null);

    startTransition(async () => {
      const result = await deleteMonitoringQueryAction({ queryId: query.id });

      if (!result.ok) {
        setFeedback({ tone: "warning", message: result.error });
        return;
      }
      router.refresh();
    });
  }

  if (editing) {
    return (
      <QueryEditor
        mode="edit"
        query={query}
        locations={locations}
        onCancel={() => setEditing(false)}
        onSaved={() => {
          setEditing(false);
          router.refresh();
        }}
      />
    );
  }

  return (
    <div className="flex flex-col items-end gap-1.5">
      <div className="flex items-center gap-2">
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          aria-label={`${enabled ? "Disable" : "Enable"} ${query.name}`}
          disabled={!canManage || pending}
          onClick={toggleEnabled}
          className={cn(
            "relative inline-flex h-5 w-9 shrink-0 items-center rounded-full transition-colors",
            enabled ? "bg-purple-600" : "bg-gray-300",
            (!canManage || pending) && "cursor-not-allowed opacity-50",
          )}
        >
          <span
            className={cn(
              "inline-block size-4 rounded-full bg-white transition-transform",
              enabled ? "translate-x-4.5" : "translate-x-0.5",
            )}
          />
        </button>

        {canPoll ? (
          <Button
            size="sm"
            icon={pending ? RotateCw : undefined}
            onClick={pollNow}
            disabled={pending || !connectorAvailable}
            title={
              connectorAvailable
                ? "Poll this query now"
                : "News monitoring is not configured on this server"
            }
          >
            {pending ? "Polling…" : "Poll now"}
          </Button>
        ) : null}

        {canManage ? (
          <Button
            size="sm"
            icon={Pencil}
            iconOnly
            onClick={() => setEditing(true)}
            disabled={pending}
          >
            Edit {query.name}
          </Button>
        ) : null}

        {canManage ? (
          <Button
            size="sm"
            variant="destructive"
            icon={Trash2}
            iconOnly
            onClick={() => setConfirmOpen(true)}
            disabled={pending}
          >
            Delete {query.name}
          </Button>
        ) : null}
      </div>

      {feedback ? (
        <p
          role="status"
          className={cn(
            "max-w-64 text-right text-[12px]",
            feedback.tone === "success" ? "text-green-600" : "text-amber-600",
          )}
        >
          {feedback.message}
        </p>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        destructive
        title={`Delete "${query.name}"?`}
        description="This deletes the query's entire poll and rejection history, not just the query. If you only need to change a keyword, publisher, or threshold, edit it instead."
        confirmLabel="Delete query"
        onConfirm={runDelete}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  );
}
