"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  CheckCircle2,
  MapPin,
  RefreshCw,
  RotateCw,
} from "lucide-react";
import { syncGoogleReviewsAction } from "@/app/actions/integrations";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { EmptyState } from "@/components/ui/empty-state";
import { cn } from "@/lib/cn";
import { formatNumber, formatRelativeLong } from "@/lib/format";

/**
 * Per-location review sync.
 *
 * A client component because each row reports an outcome the user has to read —
 * "42 new, 3 updated", or a specific remediation — and a server-rendered page
 * cannot show that without a round trip that loses the message.
 *
 * Per row rather than one button for the whole connection, and that is a
 * deliberate limitation rather than a missing feature. Each location is a
 * separate Google request against a shared quota, and a group with forty
 * restaurants pressing one button would be forty serial page-walks behind a
 * single spinner with no way to tell which one is stuck. One location at a time
 * is legible and interruptible; a "sync everything" control is the scheduled
 * job's job, not a button's.
 */

/** Everything one row renders. Assembled server-side; never fetched here. */
export interface ConnectedLocationRow {
  platformProfileId: string;
  /** What Google calls this listing. */
  externalProfileName: string;
  /** The Lia location it is mapped to, when it is mapped. */
  locationName: string | null;
  importedReviewCount: number;
  /** End of the last run that refreshed this location. */
  lastSuccessfulSyncAt: string | null;
  /** The latest run's outcome, whether or not it succeeded. */
  lastStatus: string | null;
  /** Lia's own sentence about the last failure. Never Google's. */
  lastErrorMessage: string | null;
  /** A run was still holding the lock when the page rendered. */
  syncing: boolean;
}

interface Feedback {
  tone: "success" | "warning";
  message: string;
}

export interface LocationSyncListProps {
  locations: ConnectedLocationRow[];
  canSync: boolean;
  /** True when the connection itself needs attention before a sync can work. */
  needsReauthorization: boolean;
}

export function LocationSyncList({
  locations,
  canSync,
  needsReauthorization,
}: LocationSyncListProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  // Which row is running, so one location's sync disables only its own button
  // rather than freezing the whole list.
  const [activeId, setActiveId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Record<string, Feedback>>({});

  function runSync(platformProfileId: string) {
    setActiveId(platformProfileId);
    setFeedback((current) => {
      const next = { ...current };
      delete next[platformProfileId];
      return next;
    });

    startTransition(async () => {
      const result = await syncGoogleReviewsAction({ platformProfileId });

      setFeedback((current) => ({
        ...current,
        [platformProfileId]: result.ok
          ? {
              tone: result.data.degraded ? "warning" : "success",
              message: result.data.message,
            }
          : { tone: "warning", message: result.error },
      }));

      setActiveId(null);
      // Refreshes the imported counts and the last-synced times, and — because
      // the action revalidated them — the unified inbox this fed.
      router.refresh();
    });
  }

  if (locations.length === 0) {
    return (
      <EmptyState
        title="No locations are connected yet"
        description="Map a Google location to a Lia location before importing its reviews."
      />
    );
  }

  return (
    <ul className="divide-y divide-gray-200">
      {locations.map((location) => {
        const busy = location.syncing || (pending && activeId === location.platformProfileId);
        const rowFeedback = feedback[location.platformProfileId];
        const unmapped = location.locationName === null;

        return (
          <li key={location.platformProfileId} className="py-3 first:pt-0 last:pb-0">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="flex items-center gap-1.5 text-[13px] font-medium text-gray-950">
                  <MapPin className="size-3.5 shrink-0 text-gray-400" aria-hidden />
                  {location.locationName ?? location.externalProfileName}
                </p>

                {/*
                  Google's own name is shown alongside the Lia one whenever they
                  differ. Somebody reconciling a mismatched import needs to see
                  both to know which listing they are looking at.
                */}
                {location.locationName &&
                location.locationName !== location.externalProfileName ? (
                  <p className="mt-0.5 text-[12px] text-gray-500">
                    Google listing: {location.externalProfileName}
                  </p>
                ) : null}

                <p className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px] text-gray-500">
                  <span>
                    {location.importedReviewCount === 0
                      ? "No reviews imported"
                      : `${formatNumber(location.importedReviewCount)} ${
                          location.importedReviewCount === 1 ? "review" : "reviews"
                        } imported`}
                  </span>
                  <span>
                    {location.lastSuccessfulSyncAt
                      ? `Last synced ${formatRelativeLong(location.lastSuccessfulSyncAt)}`
                      : "Never synced"}
                  </span>
                </p>
              </div>

              <div className="flex shrink-0 items-center gap-2">
                {location.syncing ? <Badge tone="amber">Syncing</Badge> : null}
                {/*
                  An unmapped listing can still be synced — its reviews arrive
                  with no location attached, which is worse than useless in a
                  per-restaurant inbox. So the state is surfaced rather than the
                  button being hidden, and mapping is the suggested fix.
                */}
                {unmapped ? <Badge tone="neutral">Not mapped</Badge> : null}

                {canSync ? (
                  <Button
                    size="sm"
                    icon={busy ? RotateCw : RefreshCw}
                    onClick={() => runSync(location.platformProfileId)}
                    disabled={busy || pending || needsReauthorization}
                  >
                    {busy ? "Syncing…" : "Sync reviews"}
                  </Button>
                ) : null}
              </div>
            </div>

            {/*
              The stored error from a previous run, shown until a later run
              clears it. A failure that vanishes on reload is a failure nobody
              can act on.
            */}
            {!rowFeedback && location.lastStatus === "failed" && location.lastErrorMessage ? (
              <p
                role="status"
                className="mt-2 flex items-start gap-1.5 rounded-lg border border-amber-600/20 bg-amber-100 px-2.5 py-2 text-[12.5px] text-gray-950"
              >
                <AlertTriangle className="mt-px size-3.5 shrink-0 text-amber-600" aria-hidden />
                {location.lastErrorMessage}
              </p>
            ) : null}

            {rowFeedback ? (
              <p
                role="status"
                className={cn(
                  "mt-2 flex items-start gap-1.5 rounded-lg border px-2.5 py-2 text-[12.5px] text-gray-950",
                  rowFeedback.tone === "success"
                    ? "border-green-600/20 bg-green-100"
                    : "border-amber-600/20 bg-amber-100",
                )}
              >
                {rowFeedback.tone === "success" ? (
                  <CheckCircle2 className="mt-px size-3.5 shrink-0 text-green-600" aria-hidden />
                ) : (
                  <AlertTriangle className="mt-px size-3.5 shrink-0 text-amber-600" aria-hidden />
                )}
                {rowFeedback.message}
              </p>
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}
