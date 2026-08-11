import { z } from "zod";
import {
  automationRuleStatusSchema,
  mentionSourceTypeSchema,
  mentionStatusSchema,
  platformSchema,
  riskLevelSchema,
  sentimentSchema,
} from "@/domain/enums";
import {
  organizationOwnedSchema,
  timestampSchema,
  timestampsSchema,
  uuidSchema,
} from "@/domain/primitives";

/**
 * Rule conditions.
 *
 * Stored as `jsonb`, but typed as a discriminated union so a malformed rule is
 * caught on write rather than at execution time in a background job. Adding a
 * condition type means adding a variant here and a migration comment — nothing
 * else changes.
 */
export const ruleConditionSchema = z.discriminatedUnion("field", [
  z.object({
    field: z.literal("platform"),
    operator: z.enum(["is", "is_not"]),
    value: platformSchema,
  }),
  z.object({
    field: z.literal("source_type"),
    operator: z.enum(["is", "is_not"]),
    value: mentionSourceTypeSchema,
  }),
  z.object({
    field: z.literal("sentiment"),
    operator: z.enum(["is", "is_not"]),
    value: sentimentSchema,
  }),
  z.object({
    field: z.literal("risk_level"),
    operator: z.enum(["is", "is_not", "at_least", "at_most"]),
    value: riskLevelSchema,
  }),
  z.object({
    field: z.literal("rating"),
    operator: z.enum(["is", "greater_than", "less_than"]),
    value: z.number().min(0).max(5),
  }),
  z.object({
    field: z.literal("relevance_score"),
    operator: z.enum(["greater_than", "less_than"]),
    value: z.number().min(0).max(1),
  }),
  z.object({
    field: z.literal("location"),
    operator: z.enum(["is", "is_not"]),
    value: uuidSchema,
  }),
  z.object({
    field: z.literal("mention_status"),
    operator: z.enum(["is", "is_not"]),
    value: mentionStatusSchema,
  }),
]);

export type RuleCondition = z.infer<typeof ruleConditionSchema>;

/**
 * The rule-action vocabulary.
 *
 * Kept in lockstep with `ruleActionSchema`'s discriminated-union `type`
 * literals below — this list exists so execution code (which needs the plain
 * literal set, not a union schema) has one source of truth to import instead
 * of re-deriving it.
 */
export const RULE_ACTION_TYPES = [
  "generate_draft",
  "auto_publish",
  "require_approval",
  "assign",
  "escalate",
  "notify",
  "tag",
  "set_status",
] as const;
export type RuleActionType = (typeof RULE_ACTION_TYPES)[number];

/**
 * Rule actions.
 *
 * `auto_publish` exists but is only reachable for low-risk content — the guard
 * lives in `isAutoPublishSafe` below and is enforced wherever rules execute.
 */
export const ruleActionSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("generate_draft"),
    voiceProfile: z.string().max(80).nullable(),
  }),
  z.object({ type: z.literal("auto_publish") }),
  z.object({
    type: z.literal("require_approval"),
    approverUserId: uuidSchema.nullable(),
  }),
  z.object({
    type: z.literal("assign"),
    assigneeUserId: uuidSchema.nullable(),
  }),
  z.object({
    type: z.literal("escalate"),
    assigneeUserId: uuidSchema.nullable(),
  }),
  z.object({
    type: z.literal("notify"),
    channel: z.enum(["email", "in_app", "both"]),
  }),
  z.object({ type: z.literal("tag"), label: z.string().min(1).max(80) }),
  z.object({ type: z.literal("set_status"), status: mentionStatusSchema }),
]);

export type RuleAction = z.infer<typeof ruleActionSchema>;

export const automationRuleSchema = z
  .object({
    name: z.string().min(1).max(160),
    description: z.string().max(1000).nullable(),
    status: automationRuleStatusSchema,
    /** Lower runs first. Ties break on `createdAt`. */
    priority: z.number().int().min(0).max(1000),
    conditions: z.array(ruleConditionSchema),
    // A rule with no actions yet is a legitimate draft-in-progress, not a
    // malformed record — the evaluator simply has nothing to do with it.
    actions: z.array(ruleActionSchema),
    /**
     * Rule-lifetime activity facts, written only by apply-mode sweeps
     * (spec §9). Monotonic: an older sweep finishing late can never move
     * one backwards. Dry run touches none of them. Revision changes reset
     * nothing — per-revision truth lives in the execution rows.
     */
    lastEvaluatedAt: timestampSchema.nullable(),
    lastMatchedAt: timestampSchema.nullable(),
    lastAppliedAt: timestampSchema.nullable(),
    /**
     * Optimistic-concurrency counter. Starts at 1, increments on every save;
     * `updateAutomationRuleInputSchema` carries an `expectedRevision` so a
     * save against a stale copy fails loudly instead of clobbering a
     * concurrent edit.
     */
    revision: z.number().int().min(1),
    /**
     * When this revision was last run through the simulator, and which
     * revision that was. `simulatedRevision` lagging behind `revision` means
     * the rule has been edited since its last simulation and authoring UI
     * should say so rather than imply the simulation still reflects reality.
     */
    lastSimulatedAt: timestampSchema.nullable(),
    simulatedRevision: z.number().int().min(1).nullable(),
    /** Soft-deleted rules are hidden by default; see `includeArchived` below. */
    archivedAt: timestampSchema.nullable(),
  })
  .extend(organizationOwnedSchema.shape)
  .extend(timestampsSchema.shape);

export type AutomationRule = z.infer<typeof automationRuleSchema>;

export const automationRuleFilterSchema = z.object({
  statuses: z.array(automationRuleStatusSchema).optional(),
  search: z.string().max(200).optional(),
  /** Defaults to excluding archived rules wherever this filter is consumed. */
  includeArchived: z.boolean().optional(),
});

export type AutomationRuleFilter = z.infer<typeof automationRuleFilterSchema>;

export const setAutomationRuleEnabledInputSchema = z.object({
  automationRuleId: uuidSchema,
  enabled: z.boolean(),
});

export type SetAutomationRuleEnabledInput = z.infer<
  typeof setAutomationRuleEnabledInputSchema
>;

/**
 * The authorable shape of a rule — everything a person sets when creating or
 * editing one, as distinct from `AutomationRule`'s server-owned fields
 * (id, status, revision, timestamps, ...). `create`, `update`, and
 * `duplicate` all read a rule's editable surface through this one schema so
 * the three inputs can't drift from each other.
 */
export const automationRuleConfigSchema = z.object({
  name: z.string().trim().min(1).max(160),
  description: z.string().max(1000).nullable().default(null),
  priority: z.number().int().min(0).max(1000).default(100),
  conditions: z.array(ruleConditionSchema).max(20).default([]),
  actions: z.array(ruleActionSchema).max(10).default([]),
});

export type AutomationRuleConfig = z.infer<typeof automationRuleConfigSchema>;

export const createAutomationRuleInputSchema = automationRuleConfigSchema;

/**
 * `expectedRevision` is the optimistic-concurrency check: the caller must
 * name the revision it read before editing, so a save against a rule someone
 * else has since changed fails instead of silently overwriting their edit.
 */
export const updateAutomationRuleInputSchema = z.object({
  automationRuleId: uuidSchema,
  expectedRevision: z.number().int().min(1),
  config: automationRuleConfigSchema,
});

export type UpdateAutomationRuleInput = z.infer<
  typeof updateAutomationRuleInputSchema
>;

export const duplicateAutomationRuleInputSchema = z.object({
  automationRuleId: uuidSchema,
});

export type DuplicateAutomationRuleInput = z.infer<
  typeof duplicateAutomationRuleInputSchema
>;

export const archiveAutomationRuleInputSchema = z.object({
  automationRuleId: uuidSchema,
});

export type ArchiveAutomationRuleInput = z.infer<
  typeof archiveAutomationRuleInputSchema
>;

export const simulateAutomationRuleInputSchema = z.object({
  automationRuleId: uuidSchema,
});

export type SimulateAutomationRuleInput = z.infer<
  typeof simulateAutomationRuleInputSchema
>;

/**
 * Review source types routine enough — high review volume, low ambiguity —
 * to be candidates for an unattended reply. Reddit, news, and social comment
 * threads are deliberately excluded even though they're reviewable sources:
 * they need judgement a rule condition can't encode.
 */
export const ROUTINE_REVIEW_SOURCES = [
  "google_review",
  "yelp_review",
  "trustpilot_review",
  "tripadvisor_review",
] as const;

/**
 * A rule may only publish without a human when every leg of the guardrail
 * holds, not just "risk is capped somewhere."
 *
 * `docs/product-spec.md`: "Positive, low-risk, routine review responses may
 * become auto-publishable... High-risk content must always be escalated."
 * This function is the single place that judgement is encoded for rule
 * *authoring* — a rule with `auto_publish` passes only if all of:
 *
 * 1. Some condition is `sentiment is positive`.
 * 2. Some risk condition is restricted to low only — `risk_level is low` or
 *    `at_most low`. `at_most medium` does not qualify: it still admits
 *    medium-risk content through, which is the bug this replaces.
 * 3. Some condition is `source_type is <routine review source>`
 *    (`ROUTINE_REVIEW_SOURCES` above).
 * 4. The rule has no `escalate` and no `require_approval` action — those
 *    exist precisely to route a mention to a person, which auto-publish
 *    would short-circuit.
 *
 * Rules without an `auto_publish` action always pass; this function has
 * nothing to say about them.
 *
 * This is necessary but not sufficient for a rule to actually auto-publish
 * at runtime: it only checks the conditions/actions an author can write.
 * Whether the action is *executable at all* — a connected platform, a
 * publishing capability that doesn't exist yet — lives in the capability
 * registry (`src/lib/rules/capabilities.ts`) and is a Phase 2 concern.
 */
export function isAutoPublishSafe(rule: {
  conditions: RuleCondition[];
  actions: RuleAction[];
}): boolean {
  const publishes = rule.actions.some(
    (action) => action.type === "auto_publish",
  );
  if (!publishes) return true;

  const hasPositiveSentiment = rule.conditions.some(
    (condition) =>
      condition.field === "sentiment" &&
      condition.operator === "is" &&
      condition.value === "positive",
  );

  const hasLowOnlyRisk = rule.conditions.some(
    (condition) =>
      condition.field === "risk_level" &&
      condition.value === "low" &&
      (condition.operator === "is" || condition.operator === "at_most"),
  );

  const hasRoutineReviewSource = rule.conditions.some(
    (condition) =>
      condition.field === "source_type" &&
      condition.operator === "is" &&
      (ROUTINE_REVIEW_SOURCES as readonly string[]).includes(condition.value),
  );

  const hasConflictingAction = rule.actions.some(
    (action) =>
      action.type === "escalate" || action.type === "require_approval",
  );

  return (
    hasPositiveSentiment &&
    hasLowOnlyRisk &&
    hasRoutineReviewSource &&
    !hasConflictingAction
  );
}
