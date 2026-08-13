/**
 * The autosave status machine.
 *
 * Pure: no React, no timers, no I/O. The rules live here rather than inside the
 * hook because the hook cannot be tested in this repository — vitest runs in a
 * node environment with no DOM and no testing-library dependency — and these
 * transitions are the part worth testing.
 *
 * The whole job is to never claim a save that has not happened. Two rules carry
 * that: an edit always wins over an in-flight request, and a response is only
 * believed while the machine is still `saving`.
 */

export const AUTOSAVE_STATUSES = [
  /** Nothing has been edited yet, so there is nothing to report. */
  "hidden",
  /** Edited and not yet sent, or sent and superseded. */
  "unsaved",
  "saving",
  "saved",
  "failed",
] as const;

export type AutosaveStatus = (typeof AUTOSAVE_STATUSES)[number];

export type AutosaveEvent =
  /** The user changed something, or asked to retry. */
  | "edit"
  /** A request is being dispatched. */
  | "send"
  | "succeeded"
  | "failed";

export function nextStatus(
  current: AutosaveStatus,
  event: AutosaveEvent,
): AutosaveStatus {
  switch (event) {
    // An edit always wins. It is also the retry path: there is something on
    // screen that is not on the server, which is exactly what `unsaved` means.
    case "edit":
      return "unsaved";

    // Only ever dispatched from `unsaved`. Guarded rather than assumed so a
    // stray call cannot show a spinner for a request nobody made.
    case "send":
      return current === "unsaved" ? "saving" : current;

    // Believed only while still saving. If the user edited while the request
    // was in flight the machine is already `unsaved`, and that newer state is
    // the truth — reporting "Saved" here would describe a payload that has not
    // been sent.
    case "succeeded":
      return current === "saving" ? "saved" : current;

    case "failed":
      return current === "saving" ? "failed" : current;
  }
}

/** The copy for a status, or null when nothing should be shown. */
export function statusLabel(status: AutosaveStatus): string | null {
  switch (status) {
    case "hidden":
      return null;
    case "unsaved":
      return "Unsaved";
    case "saving":
      return "Saving…";
    case "saved":
      return "Saved";
    case "failed":
      return "Couldn't save";
  }
}

/** True while there is work the server has not accepted yet. */
export function hasPendingWork(status: AutosaveStatus): boolean {
  return status === "unsaved" || status === "saving";
}
