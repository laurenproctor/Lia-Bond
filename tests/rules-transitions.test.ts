import { describe, expect, it } from "vitest";
import { MENTION_STATUSES, RISK_LEVELS } from "@/domain";
import { decideEscalate, decideSetStatus } from "@/lib/rules/transitions";

const LOW_RISK = ["low", "medium"] as const;
const HIGH_RISK = ["high", "critical"] as const;

describe("decideSetStatus", () => {
  it("never permits targeting escalated, from any status, at any risk", () => {
    for (const from of MENTION_STATUSES) for (const risk of RISK_LEVELS) {
      expect(decideSetStatus(from, "escalated", risk)).toEqual({
        kind: "blocked", code: "escalation_reserved",
      });
    }
  });

  it("returns no_op when target equals current (non-escalated statuses)", () => {
    for (const status of MENTION_STATUSES) {
      if (status === "escalated") continue;
      expect(decideSetStatus(status, status, "low").kind).toBe("no_op");
    }
  });

  it("permits analyzed -> monitoring at any risk", () => {
    for (const risk of RISK_LEVELS) {
      expect(decideSetStatus("analyzed", "monitoring", risk).kind).toBe("apply");
    }
  });

  it("permits resting states from analyzed and monitoring at low/medium only", () => {
    for (const from of ["analyzed", "monitoring"] as const)
      for (const to of ["no_action_recommended", "dismissed"] as const) {
        for (const risk of LOW_RISK)
          expect(decideSetStatus(from, to, risk).kind).toBe("apply");
        for (const risk of HIGH_RISK)
          expect(decideSetStatus(from, to, risk)).toEqual({
            kind: "blocked", code: "high_risk_guardrail",
          });
      }
  });

  it("refuses every source the engine may not move", () => {
    for (const from of ["escalated", "responded", "needs_approval",
                        "draft_ready", "new"] as const)
      for (const to of MENTION_STATUSES) {
        if (to === from) continue;
        const decision = decideSetStatus(from, to, "low");
        expect(decision.kind).toBe("blocked");
      }
  });

  it("refuses every unlisted combination (full sweep)", () => {
    // The permitted set, spelled out; everything else must be blocked/no_op.
    const permitted = new Set([
      "analyzed>monitoring",
      "analyzed>no_action_recommended", "analyzed>dismissed",
      "monitoring>no_action_recommended", "monitoring>dismissed",
    ]);
    for (const from of MENTION_STATUSES) for (const to of MENTION_STATUSES) {
      const d = decideSetStatus(from, to, "low");
      if (to === "escalated") expect(d).toEqual({ kind: "blocked", code: "escalation_reserved" });
      else if (from === to) expect(d.kind).toBe("no_op");
      else if (permitted.has(`${from}>${to}`)) expect(d.kind).toBe("apply");
      else expect(d).toEqual({ kind: "blocked", code: "forbidden_transition" });
    }
  });
});

describe("decideEscalate", () => {
  it("permits from analyzed, monitoring, no_action_recommended", () => {
    for (const from of ["analyzed", "monitoring", "no_action_recommended"] as const)
      expect(decideEscalate(from).kind).toBe("apply");
  });
  it("is a no_op on an already escalated mention", () => {
    expect(decideEscalate("escalated").kind).toBe("no_op");
  });
  it("refuses dismissed (a human closed it) and the pipeline states", () => {
    for (const from of ["dismissed", "responded", "needs_approval",
                        "draft_ready", "new"] as const)
      expect(decideEscalate(from)).toEqual({
        kind: "blocked", code: "forbidden_transition",
      });
  });
});
