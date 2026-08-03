"use server";

import { revalidatePath } from "next/cache";
import { setAutomationRuleEnabledInputSchema, type AutomationRule } from "@/domain";
import { authorize } from "@/lib/actions/guard";
import { runAction, type ActionResult } from "@/lib/actions/result";
import { diff, recordAuditEvent } from "@/lib/audit/record";
import { notFound } from "@/lib/data/errors";

/**
 * Turn an automation rule on or off.
 *
 * Automation changes what the product does without a person in the loop, so
 * both directions are audited — enabling and disabling are equally consequential
 * when something later goes wrong and someone asks what was running.
 */
export async function setAutomationRuleEnabledAction(
  input: unknown,
): Promise<ActionResult<AutomationRule>> {
  return runAction("automation_rule.toggle", async () => {
    const { automationRuleId, enabled } =
      setAutomationRuleEnabledInputSchema.parse(input);

    const context = await authorize("automation_rule.toggle");

    const existing = await context.dataSource.automationRules.get(
      context.scope,
      automationRuleId,
    );
    if (!existing) throw notFound("Automation rule");

    const updated = await context.dataSource.automationRules.setEnabled(
      context.scope,
      automationRuleId,
      enabled,
    );

    const changes = diff(existing, updated, ["status"]);
    await recordAuditEvent(context, {
      eventType: enabled ? "automation_rule.enabled" : "automation_rule.disabled",
      entityType: "automation_rule",
      entityId: automationRuleId,
      previousState: changes.previousState,
      newState: changes.newState,
      metadata: { ruleName: existing.name },
    });

    revalidatePath("/rules");
    return updated;
  });
}
