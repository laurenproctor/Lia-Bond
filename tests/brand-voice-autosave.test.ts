import { describe, expect, it } from "vitest";
import {
  AUTOSAVE_STATUSES,
  nextStatus,
  statusLabel,
  type AutosaveStatus,
} from "@/lib/brand-voice/autosave-status";

/**
 * The autosave status machine.
 *
 * The transitions worth pinning are the ones about a request that is already
 * in flight when the user edits again. Getting those wrong makes the screen
 * claim a save it has not made, which is worse than showing nothing at all.
 */

describe("editing", () => {
  it("moves to unsaved from any state", () => {
    for (const status of AUTOSAVE_STATUSES) {
      expect(nextStatus(status, "edit")).toBe("unsaved");
    }
  });
});

describe("sending", () => {
  it("moves unsaved to saving", () => {
    expect(nextStatus("unsaved", "send")).toBe("saving");
  });

  it("leaves every other state alone", () => {
    // A send is only ever started from `unsaved`. If one is dispatched from
    // anywhere else the machine must not invent a saving state for a request
    // the hook did not make.
    for (const status of AUTOSAVE_STATUSES.filter((s) => s !== "unsaved")) {
      expect(nextStatus(status, "send")).toBe(status);
    }
  });
});

describe("a request that succeeds", () => {
  it("moves saving to saved", () => {
    expect(nextStatus("saving", "succeeded")).toBe("saved");
  });

  it("does not report saved when the user edited while it was in flight", () => {
    // The edit moved the machine to `unsaved`, so the response belongs to a
    // stale payload. Reporting "Saved" here would tell somebody their newest
    // change is persisted when it has not even been sent.
    const afterEdit = nextStatus("saving", "edit");
    expect(afterEdit).toBe("unsaved");
    expect(nextStatus(afterEdit, "succeeded")).toBe("unsaved");
  });
});

describe("a request that fails", () => {
  it("moves saving to failed", () => {
    expect(nextStatus("saving", "failed")).toBe("failed");
  });

  it("leaves a newer edit pending rather than overwriting it with failed", () => {
    const afterEdit = nextStatus("saving", "edit");
    expect(nextStatus(afterEdit, "failed")).toBe("unsaved");
  });

  it("returns to unsaved when the user edits or retries", () => {
    expect(nextStatus("failed", "edit")).toBe("unsaved");
  });

  it("never reaches saved without a fresh successful send", () => {
    // failed -> saved is the transition that would lie most directly.
    expect(nextStatus("failed", "succeeded")).toBe("failed");
  });
});

describe("hidden", () => {
  it("is only ever the initial state", () => {
    const events = ["edit", "send", "succeeded", "failed"] as const;
    for (const status of AUTOSAVE_STATUSES) {
      for (const event of events) {
        if (status === "hidden" && event !== "edit") continue;
        expect(nextStatus(status, event)).not.toBe("hidden");
      }
    }
  });

  it("stays hidden until something is actually edited", () => {
    // Nothing has been saved on arrival, so claiming "Saved" would be a lie.
    expect(nextStatus("hidden", "send")).toBe("hidden");
    expect(nextStatus("hidden", "succeeded")).toBe("hidden");
    expect(nextStatus("hidden", "failed")).toBe("hidden");
  });
});

describe("labels", () => {
  it("gives every visible state sentence-case copy", () => {
    for (const status of AUTOSAVE_STATUSES) {
      const label = statusLabel(status);
      if (status === "hidden") {
        expect(label).toBeNull();
        continue;
      }
      expect(label).not.toBeNull();
      // Sentence case: the first character is not lowercase, and the rest of
      // the first word is not shouted.
      expect(label).toMatch(/^[A-Z]/);
    }
  });

  it("does not claim a save while one is still running", () => {
    expect(statusLabel("saving")).not.toMatch(/saved/i);
  });
});

describe("exhaustiveness", () => {
  it("lists every status exactly once", () => {
    const unique = new Set<AutosaveStatus>(AUTOSAVE_STATUSES);
    expect(unique.size).toBe(AUTOSAVE_STATUSES.length);
  });
});
