import { describe, expect, it } from "vitest";
import {
  InMemoryRateBudget,
  parseRateLimitHeaders,
  withRateBudget,
  type RateLimitObservation,
} from "@/reddit/rate-budget";
import { RedditError } from "@/reddit/errors";

/**
 * Reddit meters per OAuth client, so the budget is consumed by every tenant at
 * once and exceeding it throttles the deployment rather than one customer.
 *
 * The rule every test here defends: an unknown or stale signal may only ever
 * *reduce* capacity, never restore it. A limiter that guesses optimistically
 * speeds up precisely when it should slow down.
 */

const NOW = new Date("2026-08-14T12:00:00.000Z");

function headers(values: Record<string, string>) {
  return { get: (name: string) => values[name.toLowerCase()] ?? null };
}

describe("parseRateLimitHeaders", () => {
  it("reads remaining and reset into an absolute instant", () => {
    const observation = parseRateLimitHeaders(
      headers({ "x-ratelimit-remaining": "42.0", "x-ratelimit-reset": "60" }),
      NOW,
    );
    expect(observation).toEqual<RateLimitObservation>({
      remaining: 42,
      resetAt: new Date(NOW.getTime() + 60_000).toISOString(),
      observedAt: NOW.toISOString(),
    });
  });

  it("floors a fractional remaining rather than rounding it", () => {
    // Rounding 0.4 up to 1 would authorize a request the provider has already
    // said is not there.
    expect(
      parseRateLimitHeaders(headers({ "x-ratelimit-remaining": "0.4" }), NOW)?.remaining,
    ).toBe(0);
  });

  it("returns null when the header is absent, rather than assuming headroom", () => {
    // Reddit omits these on some responses. Reading a missing header as a full
    // budget is the failure this whole module is built to avoid.
    expect(parseRateLimitHeaders(headers({}), NOW)).toBeNull();
  });

  it("returns null on an unparseable or negative value", () => {
    expect(parseRateLimitHeaders(headers({ "x-ratelimit-remaining": "soon" }), NOW)).toBeNull();
    expect(parseRateLimitHeaders(headers({ "x-ratelimit-remaining": "-5" }), NOW)).toBeNull();
  });

  it("keeps a remaining count even when the reset header is missing", () => {
    const observation = parseRateLimitHeaders(
      headers({ "x-ratelimit-remaining": "10" }),
      NOW,
    );
    expect(observation?.remaining).toBe(10);
    expect(observation?.resetAt).toBeNull();
  });
});

describe("InMemoryRateBudget", () => {
  it("counts reservations against headroom, not just spent requests", () => {
    // The failure this prevents: concurrent workers each reading `remaining`,
    // each seeing the same headroom, and all spending it.
    const budget = new InMemoryRateBudget(2, () => NOW);
    return (async () => {
      expect(await budget.reserve("client", 1)).toBe(true);
      expect(await budget.reserve("client", 1)).toBe(true);
      expect(await budget.reserve("client", 1)).toBe(false);

      await budget.release("client", 1);
      expect(await budget.reserve("client", 1)).toBe(true);
    })();
  });

  it("takes the provider's own count as authoritative", async () => {
    const budget = new InMemoryRateBudget(100, () => NOW);
    await budget.observe("client", {
      remaining: 3,
      resetAt: null,
      observedAt: NOW.toISOString(),
    });
    expect((await budget.read("client")).remaining).toBe(3);
  });

  it("discards an observation older than what it already holds", async () => {
    // Responses arrive out of order. Letting a stale header raise the
    // remaining count is exactly the optimistic restore this module refuses.
    const budget = new InMemoryRateBudget(100, () => NOW);
    await budget.observe("client", {
      remaining: 5,
      resetAt: null,
      observedAt: NOW.toISOString(),
    });
    await budget.observe("client", {
      remaining: 90,
      resetAt: null,
      observedAt: new Date(NOW.getTime() - 60_000).toISOString(),
    });
    expect((await budget.read("client")).remaining).toBe(5);
  });

  it("keeps separate budgets per OAuth client", async () => {
    const budget = new InMemoryRateBudget(1, () => NOW);
    expect(await budget.reserve("client-a", 1)).toBe(true);
    expect(await budget.reserve("client-b", 1)).toBe(true);
    expect(await budget.reserve("client-a", 1)).toBe(false);
  });
});

describe("withRateBudget", () => {
  it("refuses the call when the budget is spent, without calling the provider", async () => {
    const budget = new InMemoryRateBudget(0, () => NOW);
    let called = false;

    await expect(
      withRateBudget(budget, "client", async () => {
        called = true;
        return { result: "x", observation: null };
      }),
    ).rejects.toBeInstanceOf(RedditError);
    expect(called).toBe(false);
  });

  it("folds the response's headers back into the budget", async () => {
    const budget = new InMemoryRateBudget(100, () => NOW);
    await withRateBudget(budget, "client", async () => ({
      result: "ok",
      observation: { remaining: 7, resetAt: null, observedAt: NOW.toISOString() },
    }));
    const snapshot = await budget.read("client");
    expect(snapshot.remaining).toBe(7);
    // The reservation is released once the provider's own count lands, or the
    // request would be counted twice.
    expect(snapshot.reserved).toBe(0);
  });

  it("releases the reservation when the call fails", async () => {
    // A request that never reached Reddit consumed none of the budget.
    // Leaving the reservation behind would throttle the deployment on the
    // strength of failures that cost nothing.
    const budget = new InMemoryRateBudget(1, () => NOW);

    await expect(
      withRateBudget(budget, "client", async () => {
        throw new Error("network");
      }),
    ).rejects.toThrow("network");

    expect((await budget.read("client")).reserved).toBe(0);
    expect(await budget.reserve("client", 1)).toBe(true);
  });

  it("does not swallow the provider's error", async () => {
    const budget = new InMemoryRateBudget(5, () => NOW);
    await expect(
      withRateBudget(budget, "client", async () => {
        throw new RedditError("target_unavailable");
      }),
    ).rejects.toMatchObject({ code: "target_unavailable" });
  });
});
