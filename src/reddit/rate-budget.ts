import { redditError } from "@/reddit/errors";

/**
 * The provider-global request budget.
 *
 * Reddit meters per OAuth client, not per customer: the limit is consumed by
 * every tenant at once, and exceeding it throttles or bans the deployment
 * rather than one organization. That makes this the one piece of Reddit state
 * in the system that is deliberately not tenant-scoped.
 *
 * It has to live in Postgres. An in-memory limiter is not merely weaker here,
 * it is actively misleading: serverless runs many instances with no shared
 * memory, so a per-instance counter of "100 remaining" across eight instances
 * permits eight hundred requests while reporting a limit of one hundred. A
 * limiter that multiplies the thing it is limiting is worse than none, because
 * it also supplies the false confidence.
 *
 * The store is injected rather than imported so this module stays pure and
 * testable — the Postgres implementation lands with the poll service that
 * needs it (Task 8), and the deterministic in-memory one below is what mock
 * mode and the tests run against.
 */

export interface RateBudgetSnapshot {
  readonly remaining: number;
  readonly reserved: number;
  readonly resetAt: string | null;
  readonly observedAt: string;
}

export interface RateBudgetStore {
  /**
   * Reserve `count` requests, or refuse.
   *
   * Atomic by contract: the Postgres implementation does this in one statement
   * under a row lock. A read-then-write here would let concurrent workers each
   * see the same headroom and all spend it, which is the exact failure the
   * global budget exists to prevent.
   */
  reserve(clientKeyId: string, count: number): Promise<boolean>;
  /** Release a reservation whose request never went out. */
  release(clientKeyId: string, count: number): Promise<void>;
  /** Fold a response's `X-Ratelimit-*` headers back into the budget. */
  observe(clientKeyId: string, observation: RateLimitObservation): Promise<void>;
  read(clientKeyId: string): Promise<RateBudgetSnapshot>;
}

export interface RateLimitObservation {
  readonly remaining: number;
  readonly resetAt: string | null;
  readonly observedAt: string;
}

/**
 * Read Reddit's rate-limit headers.
 *
 * Returns null when the headers are absent or unparseable, and the caller
 * treats null as "learned nothing" rather than as "plenty left". That
 * asymmetry is the rule this whole module follows: an unknown or stale header
 * may only ever reduce capacity, never restore it optimistically. Reddit omits
 * these headers on some responses, and a connector that read a missing header
 * as a full budget would speed up precisely when it should slow down.
 */
export function parseRateLimitHeaders(
  headers: { get(name: string): string | null },
  now: Date,
): RateLimitObservation | null {
  const remainingRaw = headers.get("x-ratelimit-remaining");
  if (remainingRaw === null) return null;

  const remaining = Number.parseFloat(remainingRaw);
  if (!Number.isFinite(remaining) || remaining < 0) return null;

  const resetRaw = headers.get("x-ratelimit-reset");
  const resetSeconds = resetRaw === null ? null : Number.parseFloat(resetRaw);
  const resetAt =
    resetSeconds !== null && Number.isFinite(resetSeconds) && resetSeconds >= 0
      ? new Date(now.getTime() + resetSeconds * 1000).toISOString()
      : null;

  return {
    // Reddit reports a float. Floored rather than rounded: rounding 0.4 up to
    // 1 would authorize a request the provider has already said is not there.
    remaining: Math.floor(remaining),
    resetAt,
    observedAt: now.toISOString(),
  };
}

/**
 * Reserve, run, and account for one provider call.
 *
 * The release on failure is what stops a run of network errors from silently
 * draining the budget: a request that never reached Reddit consumed none of
 * it, and leaving the reservation behind would throttle the deployment on the
 * strength of failures that cost nothing.
 */
export async function withRateBudget<T>(
  store: RateBudgetStore,
  clientKeyId: string,
  call: () => Promise<{ result: T; observation: RateLimitObservation | null }>,
): Promise<T> {
  const granted = await store.reserve(clientKeyId, 1);
  if (!granted) throw redditError("rate_limited");

  try {
    const { result, observation } = await call();
    if (observation !== null) {
      await store.observe(clientKeyId, observation);
    }
    // The reservation is always released: `observe` sets the authoritative
    // remaining count from the provider's own header, and leaving the
    // reservation on top of it would double-count this request.
    await store.release(clientKeyId, 1);
    return result;
  } catch (error) {
    await store.release(clientKeyId, 1);
    throw error;
  }
}

/**
 * A deterministic in-memory budget.
 *
 * For mock mode and tests only, and it says so rather than being quietly
 * substitutable: `InMemoryRateBudget` in production would be the multiplying
 * limiter described at the top of this file. The poll service takes a store
 * rather than constructing one, so choosing the wrong implementation is a
 * visible decision at a wiring site.
 */
export class InMemoryRateBudget implements RateBudgetStore {
  private readonly state = new Map<string, { remaining: number; reserved: number; resetAt: string | null; observedAt: string }>();

  constructor(
    private readonly capacity: number,
    private readonly clock: () => Date = () => new Date(0),
  ) {}

  private slot(clientKeyId: string) {
    const existing = this.state.get(clientKeyId);
    if (existing) return existing;
    const created = {
      remaining: this.capacity,
      reserved: 0,
      resetAt: null as string | null,
      observedAt: this.clock().toISOString(),
    };
    this.state.set(clientKeyId, created);
    return created;
  }

  async reserve(clientKeyId: string, count: number): Promise<boolean> {
    const slot = this.slot(clientKeyId);
    // Headroom is remaining *minus what is already promised*. Reading
    // `remaining` alone is what lets concurrent workers overspend.
    if (slot.remaining - slot.reserved < count) return false;
    slot.reserved += count;
    return true;
  }

  async release(clientKeyId: string, count: number): Promise<void> {
    const slot = this.slot(clientKeyId);
    slot.reserved = Math.max(0, slot.reserved - count);
  }

  async observe(clientKeyId: string, observation: RateLimitObservation): Promise<void> {
    const slot = this.slot(clientKeyId);
    // An observation older than what we already hold is discarded. Responses
    // can arrive out of order, and letting a stale header raise the remaining
    // count is exactly the optimistic restore this module refuses.
    if (Date.parse(observation.observedAt) < Date.parse(slot.observedAt)) return;
    slot.remaining = observation.remaining;
    slot.resetAt = observation.resetAt;
    slot.observedAt = observation.observedAt;
  }

  async read(clientKeyId: string): Promise<RateBudgetSnapshot> {
    const slot = this.slot(clientKeyId);
    return { ...slot };
  }
}
