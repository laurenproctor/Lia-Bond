"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  hasPendingWork,
  nextStatus,
  type AutosaveStatus,
} from "@/lib/brand-voice/autosave-status";
import type { ActionResult } from "@/lib/actions/result";

/** How long to wait after the last committed edit before sending. */
const IDLE_MS = 800;

export interface UseAutosaveOptions<T> {
  /** Sends the value. Must not throw; failures come back as `ok: false`. */
  save: (value: T) => Promise<ActionResult<T>>;
  /** Applied when a save succeeds, so the server's normalisation lands. */
  onSaved: (value: T) => void;
  /** Applied when a save fails. */
  onFailed: (error: string, fieldErrors: Record<string, string>) => void;
  /** Autosave is inert when false — used for the read-only role. */
  enabled: boolean;
}

export interface Autosave {
  status: AutosaveStatus;
  /** Call when an edit is complete: a slider released, a phrase added. */
  commit: () => void;
  /** Re-send after a failure. */
  retry: () => void;
}

/**
 * Autosave with a settling delay and exactly one request in flight.
 *
 * Serialising is the important part, and it is not only about wasted requests:
 * `save` is read-then-write with no transaction available, so two overlapping
 * requests can both read version *n* and both write *n+1*, losing an edit. That
 * race is already a known gap; autosave is what would start triggering it
 * routinely. Here it cannot — a change arriving mid-flight sets a flag, and the
 * loop below drains it before releasing the lock.
 *
 * The value and the callbacks are read through refs synced in effects rather
 * than captured in closures, so one stable `send` always works from the newest
 * state instead of whatever started the timer.
 */
export function useAutosave<T>(
  value: T,
  { save, onSaved, onFailed, enabled }: UseAutosaveOptions<T>,
): Autosave {
  const [status, setStatus] = useState<AutosaveStatus>("hidden");

  const latest = useRef(value);
  const callbacks = useRef({ save, onSaved, onFailed });
  const inFlight = useRef(false);
  const resendQueued = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Synced in effects, not during render. Both are read only from the timer
  // callback and from `retry`, which run long after the commit that scheduled
  // them, so the effect has always applied by then.
  useEffect(() => {
    latest.current = value;
  }, [value]);

  useEffect(() => {
    callbacks.current = { save, onSaved, onFailed };
  }, [save, onSaved, onFailed]);

  const send = useCallback(async () => {
    // The lock. A commit landing while this runs queues instead of racing.
    if (inFlight.current) {
      resendQueued.current = true;
      return;
    }

    inFlight.current = true;

    try {
      // A loop rather than recursion: an edit that arrives mid-request is sent
      // as soon as this one lands, without waiting out another idle window
      // that may never come, and without the lock ever being released between
      // the two.
      do {
        resendQueued.current = false;
        setStatus((current) => nextStatus(current, "send"));

        const result = await callbacks.current.save(latest.current);

        if (result.ok) {
          callbacks.current.onSaved(result.data);
          setStatus((current) => nextStatus(current, "succeeded"));
        } else {
          callbacks.current.onFailed(result.error, result.fieldErrors ?? {});
          setStatus((current) => nextStatus(current, "failed"));
          // Stop draining on failure. Re-sending the queued state immediately
          // would retry a validation error in a loop.
          break;
        }
      } while (resendQueued.current);
    } finally {
      inFlight.current = false;
      resendQueued.current = false;
    }
  }, []);

  const commit = useCallback(() => {
    if (!enabled) return;

    setStatus((current) => nextStatus(current, "edit"));

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void send();
    }, IDLE_MS);
  }, [enabled, send]);

  const retry = useCallback(() => {
    if (!enabled) return;

    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    setStatus((current) => nextStatus(current, "edit"));
    void send();
  }, [enabled, send]);

  useEffect(() => {
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, []);

  // The settling delay is short, but closing the tab inside it would discard
  // the last edit with no trace. Registered only while something is actually
  // outstanding, so it never interrupts a browser that has nothing to lose.
  useEffect(() => {
    if (!hasPendingWork(status)) return;

    function warn(event: BeforeUnloadEvent) {
      event.preventDefault();
    }

    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [status]);

  return { status, commit, retry };
}
