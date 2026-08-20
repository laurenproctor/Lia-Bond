import { afterEach, describe, expect, it, vi } from "vitest";
import {
  clearStaleBuildMarker,
  isStaleBuildError,
  recoverFromStaleBuild,
} from "@/lib/stale-build";

/**
 * Recovery from a deployment that retired the build a tab was loaded from.
 *
 * The suite runs in the node environment like every other one here, so `window`
 * is installed by hand rather than by jsdom. That is not a workaround — it is
 * the point of the two guards being tested: the module has to be inert on the
 * server, because these boundaries render there before they ever reach a
 * browser, and reading `sessionStorage` during that render would throw.
 *
 * What matters most below is the *narrowness* of the detector. A reload is an
 * irreversible answer to an error — it discards whatever the person could have
 * read — so every message that does not describe a failed asset fetch must fall
 * through to the ordinary error screen.
 */

interface FakeWindow {
  sessionStorage: Storage;
  location: { reload: () => void };
}

function installWindow(options: { storageThrows?: boolean } = {}): {
  reloads: () => number;
  store: Map<string, string>;
} {
  const store = new Map<string, string>();
  let reloads = 0;

  const storage = {
    getItem: (key: string) => {
      if (options.storageThrows) throw new Error("denied");
      return store.get(key) ?? null;
    },
    setItem: (key: string, value: string) => {
      if (options.storageThrows) throw new Error("denied");
      store.set(key, value);
    },
    removeItem: (key: string) => {
      if (options.storageThrows) throw new Error("denied");
      store.delete(key);
    },
  } as unknown as Storage;

  const fake: FakeWindow = {
    sessionStorage: storage,
    location: {
      reload: () => {
        reloads += 1;
      },
    },
  };

  // Cast through unknown: the fake carries the two members this module touches
  // and nothing else, which is deliberate — a fuller stub would let the module
  // start depending on browser API it has no business reaching for.
  (globalThis as { window?: unknown }).window = fake;

  return { reloads: () => reloads, store };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
  vi.useRealTimers();
});

describe("isStaleBuildError", () => {
  it("recognises a webpack chunk failure by name", () => {
    const error = new Error("Loading chunk 4821 failed.");
    error.name = "ChunkLoadError";
    expect(isStaleBuildError(error)).toBe(true);
  });

  it("recognises the wording each browser engine uses for a failed module", () => {
    // Chrome and Firefox, then Safari. Same event, three sentences.
    for (const message of [
      "Failed to fetch dynamically imported module: https://lia.bond/_next/static/chunks/page-abc.js",
      "error loading dynamically imported module",
      "Importing a module script failed.",
    ]) {
      expect(isStaleBuildError(new Error(message))).toBe(true);
    }
  });

  it("recognises a failed flight fetch and a missing stylesheet", () => {
    expect(isStaleBuildError(new Error("Failed to fetch RSC payload for /overview"))).toBe(
      true,
    );
    expect(isStaleBuildError(new Error("Loading CSS chunk 12 failed."))).toBe(true);
  });

  it("leaves a real application failure alone", () => {
    // The whole reason the pattern list is narrow. Each of these would be
    // hidden by a reload loop, and the last two are the exact errors this
    // codebase's own guards raise.
    for (const message of [
      "Cannot read properties of undefined (reading 'name')",
      "Your account is not a member of any organization yet.",
      "Sign in to continue.",
      "That provisioning request could not be completed",
      "fetch failed",
    ]) {
      expect(isStaleBuildError(new Error(message))).toBe(false);
    }
  });

  it("says no to nothing at all", () => {
    expect(isStaleBuildError(null)).toBe(false);
    expect(isStaleBuildError(undefined)).toBe(false);
    expect(isStaleBuildError(new Error(""))).toBe(false);
    expect(isStaleBuildError({ message: "Loading chunk 1 failed" })).toBe(false);
  });

  it("reads a thrown string, which is what a bare `throw` produces", () => {
    expect(isStaleBuildError("Loading chunk 9 failed.")).toBe(true);
    expect(isStaleBuildError("something else")).toBe(false);
  });
});

describe("recoverFromStaleBuild", () => {
  it("does nothing on the server", () => {
    // No window installed. The boundaries render here first, so this has to be
    // safe rather than merely unlikely.
    expect(recoverFromStaleBuild()).toBe(false);
  });

  it("reloads once and then refuses, so a bad chunk cannot spin", () => {
    const win = installWindow();

    expect(recoverFromStaleBuild()).toBe(true);
    expect(win.reloads()).toBe(1);

    // The reload happened; the fresh document failed the same way. Reloading
    // again would hide the cause behind a flicker forever.
    expect(recoverFromStaleBuild()).toBe(false);
    expect(win.reloads()).toBe(1);
  });

  it("recovers again once the cooldown has passed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-20T22:00:00.000Z"));
    const win = installWindow();

    expect(recoverFromStaleBuild()).toBe(true);
    vi.setSystemTime(new Date("2026-08-20T22:00:20.000Z"));

    // A later deploy is a new skew event, not a continuation of the last one.
    expect(recoverFromStaleBuild()).toBe(true);
    expect(win.reloads()).toBe(2);
  });

  it("clearing the marker re-arms it, which is what the button does", () => {
    const win = installWindow();

    expect(recoverFromStaleBuild()).toBe(true);
    expect(recoverFromStaleBuild()).toBe(false);

    clearStaleBuildMarker();

    // Somebody pressing "Try again" is an explicit request to retry, and it
    // outranks the automatic loop guard.
    expect(recoverFromStaleBuild()).toBe(true);
    expect(win.reloads()).toBe(2);
  });

  it("still reloads when storage is denied", () => {
    // Private browsing and strict cookie policies both make sessionStorage
    // throw. Recovery matters more than the guard.
    const win = installWindow({ storageThrows: true });

    expect(recoverFromStaleBuild()).toBe(true);
    expect(win.reloads()).toBe(1);
  });

  it("clearing the marker is safe on the server and with storage denied", () => {
    expect(() => clearStaleBuildMarker()).not.toThrow();
    installWindow({ storageThrows: true });
    expect(() => clearStaleBuildMarker()).not.toThrow();
  });
});
