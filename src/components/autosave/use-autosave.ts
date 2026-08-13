"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  hasPendingWork,
  nextStatus,
  type AutosaveStatus,
} from "@/lib/autosave/status";
import type { ActionResult } from "@/lib/actions/result";

/**
 * How long to wait after the last committed edit before sending.
 *
 * The default for a screen whose only guarantee is this timer. A caller that
 * flushes on every way out can afford to wait longer and coalesce harder —
 * which is the one lever there is on audit-trail volume, since `audit_events`
 * is append-only and cannot be merged after the fact.
 */
const DEFAULT_IDLE_MS = 800;

/**
 * What a caller is told about the state of the server after `flush`.
 *
 * `clean` means there was nothing to send, not that a save happened.
 */
export type FlushOutcome = "clean" | "saved" | "failed";

/**
 * The action itself threw rather than returning a typed failure — a dropped
 * connection or a deploy mid-request, not anything the server decided. Its own
 * sentence, because "check the highlighted fields" would be a lie.
 */
const TRANSPORT_FAILURE = "That did not save. Check your connection and try again.";

export interface UseAutosaveOptions<T, R> {
  /** Sends the value. Failures are expected back as `ok: false`. */
  save: (value: T) => Promise<ActionResult<R>>;
  /** Applied when a save succeeds, with whatever the server returned. */
  onSaved: (saved: R) => void;
  /** Applied when a save fails. */
  onFailed: (error: string, fieldErrors: Record<string, string>) => void;
  /** Autosave is inert when false — used for read-only roles. */
  enabled: boolean;
  /** Overrides the settling window. See `DEFAULT_IDLE_MS`. */
  idleMs?: number;
}

export interface Autosave {
  status: AutosaveStatus;
  /** Call when an edit is complete: a slider released, a phrase added. */
  commit: () => void;
  /** Re-send after a failure. */
  retry: () => void;
  /**
   * Send anything outstanding now, without waiting out the idle window, and
   * resolve once the server has answered. For the moments autosave cannot
   * cover on its own: navigating away, or closing the editor.
   */
  flush: () => Promise<FlushOutcome>;
}

/**
 * Autosave with a settling delay and exactly one request in flight.
 *
 * Serialising is the important part, and it is not only about wasted requests:
 * `save` is typically read-then-write with no transaction available, so two
 * overlapping requests can both read version *n* and both write *n+1*, losing
 * an edit. Here that cannot happen — a change arriving mid-flight sets a flag,
 * and the loop below drains it before releasing the lock.
 *
 * The value and the callbacks are read through refs synced in effects rather
 * than captured in closures, so one stable `send` always works from the newest
 * state instead of whatever started the timer.
 *
 * `R` is what the action returns, which is not always the edited value: a form
 * that would rather keep what the user is typing than re-seed itself from the
 * response can ignore it entirely.
 */
export function useAutosave<T, R = T>(
  value: T,
  { save, onSaved, onFailed, enabled, idleMs = DEFAULT_IDLE_MS }: UseAutosaveOptions<T, R>,
): Autosave {
  const [status, setStatus] = useState<AutosaveStatus>("hidden");

  const latest = useRef(value);
  const callbacks = useRef({ save, onSaved, onFailed });
  /** Something is on screen that the server has not accepted. */
  const dirty = useRef(false);
  /** The in-flight drain, so `flush` can await the request already running. */
  const drain = useRef<Promise<FlushOutcome> | null>(null);
  const resendQueued = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Synced in effects, not during render. Both are read only from the timer
  // callback and from `retry`/`flush`, which run long after the commit that
  // scheduled them, so the effect has always applied by then.
  useEffect(() => {
    latest.current = value;
  }, [value]);

  useEffect(() => {
    callbacks.current = { save, onSaved, onFailed };
  }, [save, onSaved, onFailed]);

  const send = useCallback((): Promise<FlushOutcome> => {
    // The lock. A send requested while one runs queues onto that drain and
    // shares its promise, so a caller awaiting either gets the real outcome.
    if (drain.current) {
      resendQueued.current = true;
      return drain.current;
    }

    const run = (async (): Promise<FlushOutcome> => {
      let outcome: FlushOutcome = "clean";

      try {
        // A loop rather than recursion: an edit that arrives mid-request is
        // sent as soon as this one lands, without waiting out another idle
        // window that may never come, and without the lock ever being released
        // between the two.
        do {
          resendQueued.current = false;
          // Cleared before the request, not after: an edit landing while it is
          // in flight must leave this true.
          dirty.current = false;
          setStatus((current) => nextStatus(current, "send"));

          let result: ActionResult<R>;
          try {
            result = await callbacks.current.save(latest.current);
          } catch (error) {
            console.error("[autosave] save threw", error);
            result = { ok: false, error: TRANSPORT_FAILURE };
          }

          if (result.ok) {
            callbacks.current.onSaved(result.data);
            setStatus((current) => nextStatus(current, "succeeded"));
            outcome = "saved";
          } else {
            callbacks.current.onFailed(result.error, result.fieldErrors ?? {});
            setStatus((current) => nextStatus(current, "failed"));
            // Still not on the server, so a later flush must try again.
            dirty.current = true;
            outcome = "failed";
            // Stop draining on failure. Re-sending the queued state
            // immediately would retry a validation error in a loop.
            break;
          }
        } while (resendQueued.current);
      } finally {
        drain.current = null;
        resendQueued.current = false;
      }

      return outcome;
    })();

    drain.current = run;
    return run;
  }, []);

  const commit = useCallback(() => {
    if (!enabled) return;

    dirty.current = true;
    setStatus((current) => nextStatus(current, "edit"));

    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => {
      timer.current = null;
      void send();
    }, idleMs);
  }, [enabled, idleMs, send]);

  const retry = useCallback(() => {
    if (!enabled) return;

    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    dirty.current = true;
    setStatus((current) => nextStatus(current, "edit"));
    void send();
  }, [enabled, send]);

  const flush = useCallback((): Promise<FlushOutcome> => {
    if (!enabled) return Promise.resolve("clean");

    if (timer.current) clearTimeout(timer.current);
    timer.current = null;

    // Already sending. Awaiting that drain is enough — but an edit made since
    // it started has to be queued onto it first, or flushing would report on a
    // request that predates what is on screen.
    if (drain.current) {
      if (dirty.current) resendQueued.current = true;
      return drain.current;
    }

    if (!dirty.current) return Promise.resolve("clean");
    return send();
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

  return { status, commit, retry, flush };
}
