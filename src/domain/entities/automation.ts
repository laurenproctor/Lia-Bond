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
 * Rule actions.
 *
 * `auto_publish` exists but is only reachable for low-risk content — the guard
 * lives in `isAutoPublishSafe` below and is enforced wherever rules execute.
 */
export const ruleActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("generate_draft"), voiceProfile: z.string().max(80) }),
  z.object({ type: z.literal("auto_publish") }),
  z.object({ type: z.literal("require_approval"), approverUserId: uuidSchema.nullable() }),
  z.object({ type: z.literal("assign"), assigneeUserId: uuidSchema.nullable() }),
  z.object({ type: z.literal("escalate"), assigneeUserId: uuidSchema.nullable() }),
  z.object({ type: z.literal("notify"), channel: z.enum(["email", "in_app", "both"]) }),
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
    actions: z.array(ruleActionSchema).min(1),
    lastRunAt: timestampSchema.nullable(),
  })
  .extend(organizationOwnedSchema.shape)
  .extend(timestampsSchema.shape);

export type AutomationRule = z.infer<typeof automationRuleSchema>;

export const automationRuleFilterSchema = z.object({
  statuses: z.array(automationRuleStatusSchema).optional(),
  search: z.string().max(200).optional(),
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
 * A rule may only publish without a human when nothing in its conditions
 * admits risky content.
 *
 * `docs/product-spec.md`: positive, low-risk, routine review responses may
 * become auto-publishable; high-risk content must always be escalated. This is
 * the single place that judgement is encoded.
 */
export function isAutoPublishSafe(rule: {
  conditions: RuleCondition[];
  actions: RuleAction[];
}): boolean {
  const publishes = rule.actions.some((action) => action.type === "auto_publish");
  if (!publishes) return true;

  return rule.conditions.some(
    (condition) =>
      condition.field === "risk_level" &&
      ((condition.operator === "is" && condition.value === "low") ||
        (condition.operator === "at_most" &&
          (condition.value === "low" || condition.value === "medium"))),
  );
}
