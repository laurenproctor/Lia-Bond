import type { LiaDataSource } from "@/lib/data/types";

/**
 * The daily request ceiling, shared by every tenant.
 *
 * New in this workflow (D67). Google's quota was per connection, so a noisy
 * customer could only hurt themselves; here one organization with forty
 * queries can exhaust the day for everyone, which is why this is enforced
 * above the tenant loop rather than inside it.
 */
export const DAILY_REQUEST_BUDGET = 100;

/** Held back from the scheduler so a person can always poll by hand. */
export const MANUAL_RESERVE = 20;

function startOfUtcDay(now: string): string {
  const date = new Date(now);
  date.setUTCHours(0, 0, 0, 0);
  return date.toISOString();
}

/** What the scheduler may still spend today. Never negative. */
export async function remainingScheduledRequests(
  dataSource: LiaDataSource,
  now: string,
): Promise<number> {
  const spent = await dataSource.newsPollRuns.requestsSpentSince(startOfUtcDay(now));
  return Math.max(0, DAILY_REQUEST_BUDGET - MANUAL_RESERVE - spent);
}
