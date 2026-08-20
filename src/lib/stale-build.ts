/**
 * Recovering from a deployment that landed under somebody's feet.
 *
 * Lia is deployed by merging to `master`, and Vercel serves each build's
 * JavaScript from a path that contains that build's id. A browser that loaded
 * the app before a deploy therefore holds markup pointing at chunks the new
 * deployment no longer serves. Nothing is wrong with the page until it needs a
 * file it has not already downloaded — and then a client-side navigation, or
 * any lazily loaded component, fetches a 404 and React throws.
 *
 * Vercel sells the real fix for this (skew protection: the client sends its
 * build id and the platform routes it to the deployment that made it). It is a
 * Pro feature and this project is on the hobby plan, so the application has to
 * recover on its own.
 *
 * **Recovery is a full page load, and only a full page load.** An error
 * boundary's `reset()` re-renders the same component tree from the same stale
 * document — it re-requests the chunk that just 404'd, usually from the
 * browser's negative cache, and fails again instantly. That is why the "Try
 * again" button on a skew failure appears to do nothing at all: it is not
 * broken, it is retrying something that cannot succeed until the document
 * itself is replaced.
 *
 * This module deliberately holds no React. The boundaries that use it are
 * client components; this is plain functions so it can be unit tested without
 * rendering anything.
 */

/**
 * What a stale build actually looks like by the time it reaches a boundary.
 *
 * Matched on message text rather than on an error class, because there is no
 * single class to match. Webpack raises a `ChunkLoadError`; native ESM raises a
 * `TypeError` whose wording differs per engine — Chrome and Firefox say
 * "Failed to fetch dynamically imported module", Safari says "Importing a
 * module script failed"; and Next's own router reports a failed flight fetch in
 * its own words. All four mean the same thing here.
 *
 * The list is deliberately narrow. Everything it matches describes *fetching
 * code*, never running it, so a genuine application bug cannot fall into it and
 * be answered with a reload — which would turn one visible error into a loop
 * that hides the cause.
 */
const STALE_BUILD_PATTERNS: readonly RegExp[] = [
  /loading chunk \S+ failed/i,
  /loading css chunk \S+ failed/i,
  /failed to fetch dynamically imported module/i,
  /error loading dynamically imported module/i,
  /importing a module script failed/i,
  /failed to fetch rsc payload/i,
];

/** True when this error is a missing asset from a retired deployment. */
export function isStaleBuildError(error: unknown): boolean {
  if (!error) return false;

  // Webpack names its own, and the name survives the message being rewritten.
  if (error instanceof Error && error.name === "ChunkLoadError") return true;

  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";

  if (!message) return false;
  return STALE_BUILD_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * The key recording that this tab has already tried a reload.
 *
 * `sessionStorage`, not `localStorage`: the marker is about one tab's attempt
 * to recover and must not be read by a second tab that has its own stale
 * document to replace.
 */
const RELOAD_MARKER = "lia:stale-build-reload";

/**
 * How long a reload attempt suppresses the next one.
 *
 * The reload is the whole recovery, so if the fresh document *still* fails the
 * cause is not skew and reloading again would spin. Fifteen seconds is longer
 * than a cold load of this app and far shorter than a person's second visit, so
 * a genuine skew failure an hour later still recovers automatically.
 */
const RELOAD_COOLDOWN_MS = 15_000;

/**
 * Replace the document, unless this tab just tried that.
 *
 * Returns whether a reload was started. Callers use the answer to decide what
 * to paint in the moment before the page goes away: showing a full error screen
 * that is about to be discarded reads as a failure the person then watches
 * disappear, which is worse than showing nothing.
 *
 * Guarded rather than unconditional. Without the marker, an error that this
 * module misclassified — or a deployment genuinely serving a broken chunk —
 * would reload forever, and a reload loop is the one failure mode a person
 * cannot report, because the screen never stays still long enough to read.
 */
export function recoverFromStaleBuild(): boolean {
  if (typeof window === "undefined") return false;

  const now = Date.now();

  try {
    const previous = Number(window.sessionStorage.getItem(RELOAD_MARKER));
    if (Number.isFinite(previous) && previous > 0 && now - previous < RELOAD_COOLDOWN_MS) {
      // Already tried. Let the boundary render its error screen instead, so
      // whatever is actually wrong is visible and reportable.
      return false;
    }
    window.sessionStorage.setItem(RELOAD_MARKER, String(now));
  } catch {
    // Storage can throw in private modes and under strict cookie policies.
    // Recovery matters more than the loop guard, and a reload that fetches a
    // working document ends the loop by itself — the failing chunk is only
    // requested again if the new document still references it, which is exactly
    // the case where reloading is right.
  }

  // `location.reload()` rather than assigning to `href`: this must re-request
  // the document Lia is currently on, including its query string, without
  // adding a history entry the back button would land on.
  window.location.reload();
  return true;
}

/**
 * Clear the marker once the app has rendered successfully.
 *
 * Without this, a person who hits a skew failure, recovers, and then hits a
 * genuinely different error inside the cooldown gets the second one handled as
 * "already tried" — correct for a loop, wrong once the first problem is over.
 */
export function clearStaleBuildMarker(): void {
  if (typeof window === "undefined") return;
  try {
    window.sessionStorage.removeItem(RELOAD_MARKER);
  } catch {
    /* See `recoverFromStaleBuild`. */
  }
}
