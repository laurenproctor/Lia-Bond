"use client";

import { useState, useTransition } from "react";
import { Loader2, PlugZap, RefreshCw } from "lucide-react";
import {
  checkYelpListingAction,
  disconnectYelpListingAction,
} from "@/app/actions/yelp";
import { YelpActivityList } from "@/components/integrations/yelp-activity-list";
import { YelpCaptureForm } from "@/components/integrations/yelp-capture-form";
import { Button, ButtonLink } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { formatRelativeShort } from "@/lib/format";
import type { PlatformProfile, YelpActivityOccurrence } from "@/domain";

/**
 * One connected Yelp listing, its recent activity, and the controls for it.
 *
 * Client-side because three things here are interactive — checking now,
 * disconnecting, and the capture form — and because the capture form has to
 * open in place next to the change that prompted it. Everything it renders was
 * read on the server and passed down; this component queries nothing.
 *
 * "Check for activity" exists as a visible control rather than as a
 * developer-only path, and that is a rollout decision rather than a
 * convenience: the scheduled sweep is not wired to cron on this deployment
 * yet (see the route's own comment), so this is currently the way a check
 * happens at all. Same service, same lock, same idempotency — only the trigger
 * differs.
 */

export interface YelpListingPanelProps {
  profile: PlatformProfile;
  locationName: string | null;
  occurrences: YelpActivityOccurrence[];
  locationNames: Record<string, string>;
  lastCheckedAt: string | null;
  reviewCount: number | null;
  rating: number | null;
  canCheck: boolean;
  canResolve: boolean;
  canDisconnect: boolean;
}

export function YelpListingPanel({
  profile,
  locationName,
  occurrences,
  locationNames,
  lastCheckedAt,
  reviewCount,
  rating,
  canCheck,
  canResolve,
  canDisconnect,
}: YelpListingPanelProps) {
  const [pending, startTransition] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [capturing, setCapturing] = useState<YelpActivityOccurrence | null>(null);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [confirmingDisconnect, setConfirmingDisconnect] = useState(false);

  function checkNow() {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await checkYelpListingAction({ profileId: profile.id });
      if (!result.ok) {
        setError(result.error);
        return;
      }

      const outcome = result.data;
      // Each branch says exactly what happened. "Checked" with no qualifier
      // would leave somebody wondering whether a quiet result meant no activity
      // or a check that never ran.
      if (outcome.status === "skipped") {
        setMessage("A check is already running for this listing.");
      } else if (outcome.status === "failed") {
        setError(outcome.errorMessage ?? "The check did not finish.");
      } else if (outcome.baselineEstablished) {
        setMessage(
          "Recorded this listing's current review count and rating. Lia will report changes from here on.",
        );
      } else if (outcome.occurrence) {
        setMessage("Review activity detected — see below.");
      } else {
        setMessage("Checked. Nothing has changed since the last check.");
      }
    });
  }

  function disconnect() {
    setConfirmingDisconnect(false);
    setError(null);
    startTransition(async () => {
      const result = await disconnectYelpListingAction({ profileId: profile.id });
      if (!result.ok) setError(result.error);
    });
  }

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[13px] font-medium text-gray-950">
            {profile.externalProfileName}
          </p>
          <p className="mt-0.5 text-[12.5px] text-gray-500">
            {locationName ?? "Not linked to a location"}
          </p>

          <dl className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[12.5px] text-gray-700">
            <div className="flex gap-1.5">
              <dt className="text-gray-500">Reviews on Yelp</dt>
              <dd className="font-medium text-gray-950">
                {reviewCount ?? "Not reported"}
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="text-gray-500">Rating</dt>
              <dd className="font-medium text-gray-950">
                {rating === null ? "Not reported" : rating.toFixed(1)}
              </dd>
            </div>
            <div className="flex gap-1.5">
              <dt className="text-gray-500">Last checked</dt>
              <dd>
                {lastCheckedAt ? formatRelativeShort(lastCheckedAt) : "Never"}
              </dd>
            </div>
          </dl>
        </div>

        <div className="flex shrink-0 flex-wrap gap-2">
          {profile.profileUrl ? (
            <ButtonLink
              href={profile.profileUrl}
              target="_blank"
              rel="noopener noreferrer"
              variant="ghost"
              size="sm"
            >
              Open in Yelp
            </ButtonLink>
          ) : null}
          {canCheck ? (
            <Button
              variant="secondary"
              size="sm"
              icon={pending ? Loader2 : RefreshCw}
              disabled={pending}
              onClick={checkNow}
            >
              Check for activity
            </Button>
          ) : null}
          {canResolve ? (
            <Button
              variant="secondary"
              size="sm"
              disabled={pending}
              onClick={() => {
                setCapturing(null);
                setCaptureOpen((open) => !open);
              }}
            >
              Add a review
            </Button>
          ) : null}
          {canDisconnect ? (
            <Button
              variant="ghost"
              size="sm"
              icon={PlugZap}
              disabled={pending}
              onClick={() => setConfirmingDisconnect(true)}
            >
              Disconnect
            </Button>
          ) : null}
        </div>
      </div>

      {message ? (
        <p role="status" className="mt-2 text-[12.5px] font-medium text-gray-950">
          {message}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-[12.5px] font-medium text-red-700">
          {error}
        </p>
      ) : null}

      {captureOpen || capturing ? (
        <div className="mt-3 rounded-lg border border-gray-200 p-3">
          <YelpCaptureForm
            platformProfileId={profile.id}
            occurrence={capturing}
            onCaptured={() => {
              setCaptureOpen(false);
              setCapturing(null);
              setMessage("Review added. It is now in the inbox with everything else.");
            }}
            onCancel={() => {
              setCaptureOpen(false);
              setCapturing(null);
            }}
          />
        </div>
      ) : null}

      <div className="mt-4">
        <h3 className="text-[12.5px] font-medium text-gray-950">
          Review activity detected
        </h3>
        <div className="mt-2">
          <YelpActivityList
            occurrences={occurrences}
            locationNames={locationNames}
            canResolve={canResolve}
            onAddReview={(occurrence) => {
              setCaptureOpen(false);
              setCapturing(occurrence);
            }}
          />
        </div>
      </div>

      <ConfirmDialog
        open={confirmingDisconnect}
        title="Disconnect this Yelp listing?"
        // Says what survives, because the fear this dialog has to answer is
        // "will I lose the reviews I typed in".
        description="Lia stops checking this listing for review activity. Reviews you added, responses, escalations, and the audit trail all stay exactly as they are, and you can reconnect the same listing later."
        confirmLabel="Disconnect"
        onConfirm={disconnect}
        onCancel={() => setConfirmingDisconnect(false)}
      />
    </div>
  );
}
