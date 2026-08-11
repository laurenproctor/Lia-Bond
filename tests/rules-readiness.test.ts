import { describe, expect, it } from "vitest";
import { isAutoPublishSafe } from "@/domain";
import type { RuleAction, RuleCondition } from "@/domain";
import {
  activationProblems,
  admitsHighRisk,
  type ActivationProblem,
} from "@/lib/rules/readiness";

const RISK_LOW: RuleCondition = {
  field: "risk_level",
  operator: "is",
  value: "low",
};
const SENTIMENT_POSITIVE: RuleCondition = {
  field: "sentiment",
  operator: "is",
  value: "positive",
};
const SOURCE_GOOGLE: RuleCondition = {
  field: "source_type",
  operator: "is",
  value: "google_review",
};

const ESCALATE: RuleAction = { type: "escalate", assigneeUserId: null };
const SET_DISMISSED: RuleAction = { type: "set_status", status: "dismissed" };
const SET_NO_ACTION: RuleAction = {
  type: "set_status",
  status: "no_action_recommended",
};
const REQUIRE_APPROVAL: RuleAction = {
  type: "require_approval",
  approverUserId: null,
};
const AUTO_PUBLISH: RuleAction = { type: "auto_publish" };

interface ReadyRule {
  conditions: RuleCondition[];
  actions: RuleAction[];
  revision: number;
  simulatedRevision: number | null;
}

const ready: ReadyRule = {
  conditions: [RISK_LOW],
  actions: [ESCALATE],
  revision: 3,
  simulatedRevision: 3,
};

function codes(rule: ReadyRule): string[] {
  return activationProblems(rule).map((p: ActivationProblem) => p.code);
}

describe("activationProblems", () => {
  it("a complete, simulated, executable rule has no problems", () => {
    expect(activationProblems(ready)).toEqual([]);
  });

  it("refuses zero conditions", () => {
    expect(codes({ ...ready, conditions: [] })).toContain("no_conditions");
  });

  it("refuses zero actions", () => {
    expect(codes({ ...ready, actions: [] })).toContain("no_actions");
  });

  it("no_conditions message explains why", () => {
    const [problem] = activationProblems({ ...ready, conditions: [] });
    expect(problem).toEqual({
      code: "no_conditions",
      message:
        "Add at least one condition. A rule with no conditions would never match anything.",
    });
  });

  it("no_actions message explains why", () => {
    const problems = activationProblems({ ...ready, actions: [] });
    const problem = problems.find((p) => p.code === "no_actions");
    expect(problem).toEqual({
      code: "no_actions",
      message: "Add at least one action.",
    });
  });

  it("refuses unexecutable actions with the action type named", () => {
    expect(
      codes({ ...ready, actions: [{ type: "notify", channel: "email" }] }),
    ).toContain("unexecutable_action:notify");
  });

  it("unexecutable_action message is the label plus the registry's blocked reason", () => {
    const problems = activationProblems({
      ...ready,
      actions: [{ type: "notify", channel: "email" }],
    });
    const problem = problems.find(
      (p) => p.code === "unexecutable_action:notify",
    );
    expect(problem?.message).toBe(
      "Send a notification: Lia has no notification delivery yet. Email exists only for the help form.",
    );
  });

  it("reports one unexecutable_action problem per non-executable action present", () => {
    const problems = codes({
      ...ready,
      actions: [
        { type: "notify", channel: "email" },
        { type: "tag", label: "vip" },
      ],
    });
    expect(problems).toContain("unexecutable_action:notify");
    expect(problems).toContain("unexecutable_action:tag");
  });

  it("executable actions (set_status, escalate) never produce unexecutable_action problems", () => {
    expect(
      codes(ready).some((code) => code.startsWith("unexecutable_action:")),
    ).toBe(false);
  });

  it("refuses stale simulation when simulatedRevision lags", () => {
    expect(codes({ ...ready, simulatedRevision: 2 })).toContain(
      "stale_simulation",
    );
  });

  it("refuses never-simulated rules", () => {
    expect(codes({ ...ready, simulatedRevision: null })).toContain(
      "stale_simulation",
    );
  });

  it("stale_simulation message matches /simulate/i", () => {
    const problems = activationProblems({ ...ready, simulatedRevision: null });
    const problem = problems.find((p) => p.code === "stale_simulation");
    expect(problem?.message).toMatch(/simulate/i);
    expect(problem?.message).toBe("Simulate this rule before enabling it.");
  });

  it("auto_publish_unsafe fires when auto_publish action is present but conditions are unsafe", () => {
    expect(
      codes({
        ...ready,
        conditions: [RISK_LOW],
        actions: [AUTO_PUBLISH],
      }),
    ).toContain("auto_publish_unsafe");
  });

  it("auto_publish_unsafe does not fire when auto_publish is safe", () => {
    expect(
      codes({
        ...ready,
        conditions: [SENTIMENT_POSITIVE, RISK_LOW, SOURCE_GOOGLE],
        actions: [AUTO_PUBLISH],
      }),
    ).not.toContain("auto_publish_unsafe");
  });

  it("approval_conflicts_auto_publish fires when both actions are present", () => {
    const rule = {
      ...ready,
      conditions: [SENTIMENT_POSITIVE, RISK_LOW, SOURCE_GOOGLE],
      actions: [AUTO_PUBLISH, REQUIRE_APPROVAL],
    };
    expect(codes(rule)).toContain("approval_conflicts_auto_publish");
    // Belt-and-braces: an unsafe auto_publish combined with approval reports both codes.
  });

  it("approval + unsafe auto_publish reports both auto_publish_unsafe and approval_conflicts_auto_publish", () => {
    const rule = {
      ...ready,
      conditions: [RISK_LOW],
      actions: [AUTO_PUBLISH, REQUIRE_APPROVAL],
    };
    const result = codes(rule);
    expect(result).toContain("auto_publish_unsafe");
    expect(result).toContain("approval_conflicts_auto_publish");
  });

  it("approval_conflicts_auto_publish does not fire without auto_publish", () => {
    expect(codes({ ...ready, actions: [REQUIRE_APPROVAL] })).not.toContain(
      "approval_conflicts_auto_publish",
    );
  });

  it("conflicting_set_status fires with two or more set_status actions", () => {
    expect(
      codes({ ...ready, actions: [SET_DISMISSED, SET_NO_ACTION] }),
    ).toContain("conflicting_set_status");
  });

  it("conflicting_set_status does not fire with a single set_status action", () => {
    expect(codes({ ...ready, actions: [SET_DISMISSED] })).not.toContain(
      "conflicting_set_status",
    );
  });

  it("refuses terminal statuses that admit high risk", () => {
    expect(
      codes({
        ...ready,
        conditions: [
          { field: "relevance_score", operator: "less_than", value: 0.3 },
        ],
        actions: [SET_DISMISSED],
      }),
    ).toContain("high_risk_terminal_status");
  });

  it("allows terminal statuses when risk is constrained to low/medium", () => {
    expect(
      codes({
        ...ready,
        conditions: [
          RISK_LOW,
          { field: "relevance_score", operator: "less_than", value: 0.3 },
        ],
        actions: [SET_DISMISSED],
      }),
    ).not.toContain("high_risk_terminal_status");
  });

  it("high_risk_terminal_status also fires for no_action_recommended", () => {
    expect(
      codes({
        ...ready,
        conditions: [
          { field: "relevance_score", operator: "less_than", value: 0.3 },
        ],
        actions: [SET_NO_ACTION],
      }),
    ).toContain("high_risk_terminal_status");
  });

  it("high_risk_terminal_status does not fire for non-terminal set_status values", () => {
    expect(
      codes({
        ...ready,
        conditions: [
          { field: "relevance_score", operator: "less_than", value: 0.3 },
        ],
        actions: [{ type: "set_status", status: "escalated" }],
      }),
    ).not.toContain("high_risk_terminal_status");
  });
});

describe("admitsHighRisk", () => {
  it("returns false for risk_level is low", () => {
    expect(
      admitsHighRisk([{ field: "risk_level", operator: "is", value: "low" }]),
    ).toBe(false);
  });

  it("returns false for risk_level is medium", () => {
    expect(
      admitsHighRisk([
        { field: "risk_level", operator: "is", value: "medium" },
      ]),
    ).toBe(false);
  });

  it("returns false for risk_level at_most low", () => {
    expect(
      admitsHighRisk([
        { field: "risk_level", operator: "at_most", value: "low" },
      ]),
    ).toBe(false);
  });

  it("returns false for risk_level at_most medium", () => {
    expect(
      admitsHighRisk([
        { field: "risk_level", operator: "at_most", value: "medium" },
      ]),
    ).toBe(false);
  });

  it("returns true for risk_level is high", () => {
    expect(
      admitsHighRisk([{ field: "risk_level", operator: "is", value: "high" }]),
    ).toBe(true);
  });

  it("returns true for risk_level is critical", () => {
    expect(
      admitsHighRisk([
        { field: "risk_level", operator: "is", value: "critical" },
      ]),
    ).toBe(true);
  });

  it("returns true for risk_level at_most high", () => {
    expect(
      admitsHighRisk([
        { field: "risk_level", operator: "at_most", value: "high" },
      ]),
    ).toBe(true);
  });

  it("returns true for risk_level at_least anything", () => {
    expect(
      admitsHighRisk([
        { field: "risk_level", operator: "at_least", value: "low" },
      ]),
    ).toBe(true);
    expect(
      admitsHighRisk([
        { field: "risk_level", operator: "at_least", value: "high" },
      ]),
    ).toBe(true);
  });

  it("is_not high does not count as excluding high risk (critical still admitted)", () => {
    expect(
      admitsHighRisk([
        { field: "risk_level", operator: "is_not", value: "high" },
      ]),
    ).toBe(true);
  });

  it("returns true for an empty condition list", () => {
    expect(admitsHighRisk([])).toBe(true);
  });

  it("returns true when only unrelated conditions are present", () => {
    expect(
      admitsHighRisk([
        { field: "sentiment", operator: "is", value: "negative" },
      ]),
    ).toBe(true);
  });
});

describe("isAutoPublishSafe", () => {
  it("rejects at_most medium — the current bug", () => {
    expect(
      isAutoPublishSafe({
        conditions: [
          SENTIMENT_POSITIVE,
          { field: "risk_level", operator: "at_most", value: "medium" },
          SOURCE_GOOGLE,
        ],
        actions: [AUTO_PUBLISH],
      }),
    ).toBe(false);
  });

  it("passes with sentiment positive + risk_level is low + routine source", () => {
    expect(
      isAutoPublishSafe({
        conditions: [SENTIMENT_POSITIVE, RISK_LOW, SOURCE_GOOGLE],
        actions: [AUTO_PUBLISH],
      }),
    ).toBe(true);
  });

  it("passes with sentiment positive + risk_level at_most low + routine source", () => {
    expect(
      isAutoPublishSafe({
        conditions: [
          SENTIMENT_POSITIVE,
          { field: "risk_level", operator: "at_most", value: "low" },
          SOURCE_GOOGLE,
        ],
        actions: [AUTO_PUBLISH],
      }),
    ).toBe(true);
  });

  it("fails when sentiment positive leg is missing", () => {
    expect(
      isAutoPublishSafe({
        conditions: [RISK_LOW, SOURCE_GOOGLE],
        actions: [AUTO_PUBLISH],
      }),
    ).toBe(false);
  });

  it("fails when the risk leg is missing", () => {
    expect(
      isAutoPublishSafe({
        conditions: [SENTIMENT_POSITIVE, SOURCE_GOOGLE],
        actions: [AUTO_PUBLISH],
      }),
    ).toBe(false);
  });

  it("fails when the routine review source leg is missing", () => {
    expect(
      isAutoPublishSafe({
        conditions: [SENTIMENT_POSITIVE, RISK_LOW],
        actions: [AUTO_PUBLISH],
      }),
    ).toBe(false);
  });

  it("accepts every routine review source", () => {
    const routineSources = [
      "google_review",
      "yelp_review",
      "trustpilot_review",
      "tripadvisor_review",
    ] as const;
    for (const value of routineSources) {
      expect(
        isAutoPublishSafe({
          conditions: [
            SENTIMENT_POSITIVE,
            RISK_LOW,
            { field: "source_type", operator: "is", value },
          ],
          actions: [AUTO_PUBLISH],
        }),
      ).toBe(true);
    }
  });

  it("rejects a non-routine source such as reddit_post", () => {
    expect(
      isAutoPublishSafe({
        conditions: [
          SENTIMENT_POSITIVE,
          RISK_LOW,
          { field: "source_type", operator: "is", value: "reddit_post" },
        ],
        actions: [AUTO_PUBLISH],
      }),
    ).toBe(false);
  });

  it("fails when escalate is also present on the rule", () => {
    expect(
      isAutoPublishSafe({
        conditions: [SENTIMENT_POSITIVE, RISK_LOW, SOURCE_GOOGLE],
        actions: [AUTO_PUBLISH, ESCALATE],
      }),
    ).toBe(false);
  });

  it("fails when require_approval is also present on the rule", () => {
    expect(
      isAutoPublishSafe({
        conditions: [SENTIMENT_POSITIVE, RISK_LOW, SOURCE_GOOGLE],
        actions: [AUTO_PUBLISH, REQUIRE_APPROVAL],
      }),
    ).toBe(false);
  });

  it("passes when all four legs hold and no conflicting actions", () => {
    expect(
      isAutoPublishSafe({
        conditions: [SENTIMENT_POSITIVE, RISK_LOW, SOURCE_GOOGLE],
        actions: [{ type: "generate_draft", voiceProfile: null }, AUTO_PUBLISH],
      }),
    ).toBe(true);
  });

  it("passes any rule without auto_publish, regardless of conditions", () => {
    expect(isAutoPublishSafe({ conditions: [], actions: [ESCALATE] })).toBe(
      true,
    );
  });
});
