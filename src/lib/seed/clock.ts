/**
 * The seed clock.
 *
 * Demo data is anchored to a fixed instant rather than the wall clock so that
 * relative times ("12m ago") render identically on the server and the client,
 * screenshots stay stable, and tests can assert on exact timestamps.
 */
export const REFERENCE_NOW = "2026-08-01T18:00:00.000Z";

const referenceMs = Date.parse(REFERENCE_NOW);

export function minutesAgo(minutes: number): string {
  return new Date(referenceMs - minutes * 60_000).toISOString();
}

export function minutesFromNow(minutes: number): string {
  return new Date(referenceMs + minutes * 60_000).toISOString();
}

export function hoursAgo(hours: number): string {
  return minutesAgo(hours * 60);
}

export function daysAgo(days: number): string {
  return minutesAgo(days * 60 * 24);
}

export function daysFromNow(days: number): string {
  return minutesFromNow(days * 60 * 24);
}
