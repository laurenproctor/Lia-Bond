"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, PlugZap, Stethoscope } from "lucide-react";
import {
  disconnectGoogleAction,
  testGoogleConnectionAction,
} from "@/app/actions/integrations";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { cn } from "@/lib/cn";

/**
 * Test and disconnect controls.
 *
 * A client component because both actions produce a result the user has to read
 * — "healthy as of just now", or a specific remediation — and a server-rendered
 * page cannot show that without a round trip that loses the message.
 *
 * The disconnect dialog states the consequences before the button is armed.
 * Disconnecting is reversible in the sense that reconnecting restores the
 * mappings, but it stops everything downstream in the meantime, and an
 * administrator deserves to know exactly what survives before they decide.
 */

interface Feedback {
  tone: "success" | "warning";
  message: string;
}

export interface ConnectionActionsProps {
  connectionId: string;
  /** Mapped profiles, quoted in the confirmation so the cost is concrete. */
  mappedProfileCount: number;
  /** Imported reviews, for the same reason: the cost has to be a number. */
  importedReviewCount: number;
  canTest: boolean;
  canDisconnect: boolean;
}

export function ConnectionActions({
  connectionId,
  mappedProfileCount,
  importedReviewCount,
  canTest,
  canDisconnect,
}: ConnectionActionsProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  function runTest() {
    setFeedback(null);
    startTransition(async () => {
      const result = await testGoogleConnectionAction({ connectionId });

      if (!result.ok) {
        setFeedback({ tone: "warning", message: result.error });
        return;
      }

      setFeedback(
        result.data.status === "healthy"
          ? { tone: "success", message: "Google accepted the connection." }
          : {
              tone: "warning",
              message:
                result.data.message ??
                "Google did not accept the connection. Reauthorize to reconnect it.",
            },
      );
      router.refresh();
    });
  }

  function runDisconnect() {
    setConfirmOpen(false);
    setFeedback(null);

    startTransition(async () => {
      const result = await disconnectGoogleAction();

      if (!result.ok) {
        setFeedback({ tone: "warning", message: result.error });
        return;
      }

      // Confirmed and unconfirmed revocation read differently on purpose: the
      // second one asks the administrator to finish the job in Google.
      setFeedback({
        tone: result.data.remoteRevocationConfirmed ? "success" : "warning",
        message: result.data.message,
      });
      router.refresh();
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap gap-2">
        {canTest ? (
          <Button
            size="sm"
            icon={Stethoscope}
            onClick={runTest}
            disabled={pending}
          >
            {pending ? "Working…" : "Test connection"}
          </Button>
        ) : null}

        {canDisconnect ? (
          <Button
            size="sm"
            variant="destructive"
            icon={PlugZap}
            onClick={() => setConfirmOpen(true)}
            disabled={pending}
          >
            Disconnect
          </Button>
        ) : null}
      </div>

      {feedback ? (
        <p
          role="status"
          className={cn(
            "flex items-start gap-1.5 rounded-lg border px-2.5 py-2 text-[12.5px]",
            feedback.tone === "success"
              ? "border-green-600/20 bg-green-100 text-green-600"
              : "border-amber-600/20 bg-amber-100 text-amber-600",
          )}
        >
          {feedback.tone === "success" ? (
            <CheckCircle2 className="mt-px size-3.5 shrink-0" aria-hidden />
          ) : (
            <AlertTriangle className="mt-px size-3.5 shrink-0" aria-hidden />
          )}
          <span className="text-gray-950">{feedback.message}</span>
        </p>
      ) : null}

      <ConfirmDialog
        open={confirmOpen}
        destructive
        title="Disconnect Google Business Profile?"
        description="Lia will stop using this Google account until it is reconnected."
        confirmLabel="Disconnect Google"
        onConfirm={runDisconnect}
        onCancel={() => setConfirmOpen(false)}
      >
        <ul className="space-y-1.5 text-[12.5px] text-gray-700">
          <li>
            <strong className="font-medium text-gray-950">
              {mappedProfileCount === 1
                ? "1 mapped location"
                : `${mappedProfileCount} mapped locations`}
            </strong>{" "}
            will be marked disconnected. The mappings are kept, so reconnecting
            restores them without redoing the work.
          </li>
          <li>Your Lia locations are kept, along with everything recorded about them.</li>
          <li>
            The audit trail is kept. Disconnecting is recorded, not erased.
          </li>
          <li>
            Lia deletes its stored Google credentials and asks Google to revoke
            them. If Google does not confirm, Lia will say so rather than assume.
          </li>
          {/*
            Reviews already imported are kept, and saying so matters: an
            operator weighing a disconnect needs to know their inbox history,
            their escalations, and the work attached to them survive it. What
            stops is new reviews arriving.
          */}
          <li>
            {importedReviewCount === 0
              ? "No Google reviews have been imported yet, so there is no imported review data to lose."
              : `${importedReviewCount === 1 ? "1 imported review" : `${importedReviewCount} imported reviews`} stay in your inbox, along with any responses, escalations, and notes on them. New reviews will stop arriving until Google is reconnected.`}
          </li>
        </ul>
      </ConfirmDialog>
    </div>
  );
}
