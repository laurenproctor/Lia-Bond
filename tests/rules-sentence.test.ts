import { describe, expect, it } from "vitest";
import { ruleSentence } from "@/lib/rules/sentence";
import { CONDITION_FIELDS } from "@/lib/rules/fields";
import { ruleConditionSchema } from "@/domain/entities/automation";
import type { RuleAction, RuleCondition } from "@/domain";

const names = new Map([["loc-1", "Maison Laurent"]]);

describe("ruleSentence", () => {
  // Pinned tests — brief Step 1, verbatim.
  it("renders conditions and actions as one sentence", () => {
    expect(
      ruleSentence(
        {
          conditions: [
            { field: "source_type", operator: "is", value: "google_review" },
            { field: "rating", operator: "greater_than", value: 3 },
            { field: "risk_level", operator: "is", value: "low" },
          ],
          actions: [
            { type: "escalate", assigneeUserId: null },
            { type: "set_status", status: "monitoring" },
          ],
        },
        { locationNames: names },
      ),
    ).toBe(
      "When the source is a Google review, the rating is above 3, and the risk is low — escalate it and set its status to Monitoring.",
    );
  });

  it("names locations and survives unknown ids", () => {
    expect(
      ruleSentence(
        {
          conditions: [{ field: "location", operator: "is", value: "loc-1" }],
          actions: [{ type: "escalate", assigneeUserId: null }],
        },
        { locationNames: names },
      ),
    ).toBe("When the location is Maison Laurent — escalate it.");

    expect(
      ruleSentence(
        {
          conditions: [
            { field: "location", operator: "is", value: "loc-unknown" },
          ],
          actions: [{ type: "escalate", assigneeUserId: null }],
        },
        { locationNames: names },
      ),
    ).toBe("When the location is a specific location — escalate it.");
  });

  it("describes incompleteness honestly", () => {
    expect(
      ruleSentence({ conditions: [], actions: [] }, { locationNames: names }),
    ).toBe("This rule has no conditions yet, so it would never match anything.");
  });

  it("renders generate_draft with a null voice as the brand voice", () => {
    expect(
      ruleSentence(
        {
          conditions: [{ field: "sentiment", operator: "is", value: "positive" }],
          actions: [{ type: "generate_draft", voiceProfile: null }],
        },
        { locationNames: names },
      ),
    ).toBe(
      "When the sentiment is positive — draft a reply in your brand voice.",
    );
  });

  // Additional sentence-shape tests not in the brief's pinned set.
  it("says a rule with no conditions never matches even when it has actions", () => {
    expect(
      ruleSentence(
        { conditions: [], actions: [{ type: "escalate", assigneeUserId: null }] },
        { locationNames: names },
      ),
    ).toBe("This rule has no conditions yet, so it would never match anything.");
  });

  it("says a rule with conditions but no actions would do nothing yet", () => {
    expect(
      ruleSentence(
        {
          conditions: [{ field: "sentiment", operator: "is", value: "positive" }],
          actions: [],
        },
        { locationNames: names },
      ),
    ).toBe("When the sentiment is positive — it would do nothing yet. Add an action.");
  });

  it("joins three conditions with an Oxford comma and two with a bare 'and'", () => {
    const twoConditions: RuleCondition[] = [
      { field: "sentiment", operator: "is", value: "positive" },
      { field: "risk_level", operator: "is", value: "low" },
    ];
    expect(
      ruleSentence(
        { conditions: twoConditions, actions: [{ type: "escalate", assigneeUserId: null }] },
        { locationNames: names },
      ),
    ).toBe(
      "When the sentiment is positive and the risk is low — escalate it.",
    );
  });

  it("joins three or more actions with an Oxford comma", () => {
    const actions: RuleAction[] = [
      { type: "escalate", assigneeUserId: null },
      { type: "notify", channel: "email" },
      { type: "require_approval", approverUserId: null },
    ];
    expect(
      ruleSentence(
        {
          conditions: [{ field: "sentiment", operator: "is", value: "positive" }],
          actions,
        },
        { locationNames: names },
      ),
    ).toBe(
      "When the sentiment is positive — escalate it, send a notification, and hold it for approval.",
    );
  });

  // Per-condition phrase table.
  const conditionCases: { condition: RuleCondition; phrase: string }[] = [
    { condition: { field: "platform", operator: "is", value: "reddit" }, phrase: "the platform is Reddit" },
    { condition: { field: "platform", operator: "is_not", value: "reddit" }, phrase: "the platform is not Reddit" },
    { condition: { field: "source_type", operator: "is", value: "google_review" }, phrase: "the source is a Google review" },
    { condition: { field: "source_type", operator: "is_not", value: "google_review" }, phrase: "the source is not a Google review" },
    { condition: { field: "sentiment", operator: "is", value: "positive" }, phrase: "the sentiment is positive" },
    { condition: { field: "sentiment", operator: "is_not", value: "positive" }, phrase: "the sentiment is not positive" },
    { condition: { field: "risk_level", operator: "is", value: "low" }, phrase: "the risk is low" },
    { condition: { field: "risk_level", operator: "is_not", value: "low" }, phrase: "the risk is not low" },
    { condition: { field: "risk_level", operator: "at_least", value: "medium" }, phrase: "the risk is medium or worse" },
    { condition: { field: "risk_level", operator: "at_most", value: "medium" }, phrase: "the risk is medium or better" },
    { condition: { field: "rating", operator: "is", value: 4 }, phrase: "the rating is exactly 4" },
    { condition: { field: "rating", operator: "greater_than", value: 3 }, phrase: "the rating is above 3" },
    { condition: { field: "rating", operator: "less_than", value: 2 }, phrase: "the rating is below 2" },
    { condition: { field: "relevance_score", operator: "greater_than", value: 0.5 }, phrase: "relevance is above 0.5" },
    { condition: { field: "relevance_score", operator: "less_than", value: 0.5 }, phrase: "relevance is below 0.5" },
    { condition: { field: "location", operator: "is", value: "loc-1" }, phrase: "the location is Maison Laurent" },
    { condition: { field: "location", operator: "is_not", value: "loc-1" }, phrase: "the location is not Maison Laurent" },
    { condition: { field: "location", operator: "is_not", value: "loc-unknown" }, phrase: "the location is not a specific location" },
    { condition: { field: "mention_status", operator: "is", value: "monitoring" }, phrase: "its status is Monitoring" },
    { condition: { field: "mention_status", operator: "is_not", value: "monitoring" }, phrase: "its status is not Monitoring" },
  ];

  it.each(conditionCases)("renders $condition.field $condition.operator as expected phrase", ({ condition, phrase }) => {
    const sentence = ruleSentence(
      { conditions: [condition], actions: [{ type: "escalate", assigneeUserId: null }] },
      { locationNames: names },
    );
    expect(sentence).toBe(`When ${phrase} — escalate it.`);
  });

  // Per-action phrase table, covering all 8 action types.
  const actionCases: { action: RuleAction; phrase: string }[] = [
    { action: { type: "escalate", assigneeUserId: null }, phrase: "escalate it" },
    { action: { type: "set_status", status: "monitoring" }, phrase: "set its status to Monitoring" },
    { action: { type: "require_approval", approverUserId: null }, phrase: "hold it for approval" },
    { action: { type: "generate_draft", voiceProfile: null }, phrase: "draft a reply in your brand voice" },
    { action: { type: "generate_draft", voiceProfile: "friendly" }, phrase: "draft a reply in your brand voice" },
    { action: { type: "auto_publish" }, phrase: "publish the reply automatically" },
    { action: { type: "notify", channel: "email" }, phrase: "send a notification" },
    { action: { type: "assign", assigneeUserId: null }, phrase: "apply an unsupported action (assign)" },
    { action: { type: "tag", label: "vip" }, phrase: "apply an unsupported action (tag)" },
  ];

  it.each(actionCases)("renders $action.type as expected phrase", ({ action, phrase }) => {
    const sentence = ruleSentence(
      {
        conditions: [{ field: "sentiment", operator: "is", value: "positive" }],
        actions: [action],
      },
      { locationNames: names },
    );
    expect(sentence).toBe(`When the sentiment is positive — ${phrase}.`);
  });
});

describe("CONDITION_FIELDS", () => {
  it("mirrors ruleConditionSchema field/operator options exactly", () => {
    const schemaShape = ruleConditionSchema.options
      .map((option) => ({
        field: option.shape.field.value as string,
        operators: [...option.shape.operator.options].sort(),
      }))
      .sort((a, b) => a.field.localeCompare(b.field));

    const metaShape = CONDITION_FIELDS.map((meta) => ({
      field: meta.field as string,
      operators: meta.operators.map((op) => op.value).sort(),
    })).sort((a, b) => a.field.localeCompare(b.field));

    expect(metaShape).toEqual(schemaShape);
  });

  it("covers every condition field exactly once", () => {
    const fields = CONDITION_FIELDS.map((meta) => meta.field).sort();
    const schemaFields = ruleConditionSchema.options
      .map((option) => option.shape.field.value as string)
      .sort();
    expect(fields).toEqual(schemaFields);
  });

  it("has a sentence-case label and an input kind for every field", () => {
    for (const meta of CONDITION_FIELDS) {
      expect(meta.label.length).toBeGreaterThan(0);
      expect(meta.label.charAt(0)).toBe(meta.label.charAt(0).toUpperCase());
      expect(meta.input.length).toBeGreaterThan(0);
    }
  });

  it("has correct operator labels", () => {
    const operatorLabels: Record<string, string> = {
      is: "is",
      is_not: "is not",
      at_least: "is at least",
      at_most: "is at most",
      greater_than: "is above",
      less_than: "is below",
    };
    for (const meta of CONDITION_FIELDS) {
      for (const op of meta.operators) {
        expect(op.label).toBe(operatorLabels[op.value]);
      }
    }
  });
});
