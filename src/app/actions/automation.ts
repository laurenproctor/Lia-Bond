"use server";

import { revalidatePath } from "next/cache";
import {
  archiveAutomationRuleInputSchema,
  createAutomationRuleInputSchema,
  duplicateAutomationRuleInputSchema,
  setAutomationRuleEnabledInputSchema,
  simulateAutomationRuleInputSchema,
  updateAutomationRuleInputSchema,
  type AutomationRule,
} from "@/domain";
import { authorize, type MutationContext } from "@/lib/actions/guard";
import { runAction, type ActionResult } from "@/lib/actions/result";
import { diff, recordAuditEvent } from "@/lib/audit/record";
import { conflict, notFound } from "@/lib/data/errors";
import { activationProblems } from "@/lib/rules/readiness";
import { simulateRule, type SimulationResult } from "@/lib/rules/simulate";

/**
 * The most copies `duplicateAutomationRuleAction` will try to name before
 * giving up and asking a person to clean up first.
 */
const MAX_DUPLICATE_ATTEMPTS = 5;

/**
 * Find a free "<name> (copy)", "<name> (copy 2)", ... name for a duplicate,
 * checked case-insensitively against every rule in the organization
 * (including archived ones — an archived rule still owns its name until it
 * is renamed or permanently removed).
 */
async function deriveDuplicateName(
  context: MutationContext,
  sourceName: string,
): Promise<string> {
  const existing = await context.dataSource.automationRules.list(context.scope, {
    includeArchived: true,
  });
  const taken = new Set(existing.map((rule) => rule.name.trim().toLowerCase()));

  for (let attempt = 1; attempt <= MAX_DUPLICATE_ATTEMPTS; attempt += 1) {
    const candidate = attempt === 1 ? `${sourceName} (copy)` : `${sourceName} (copy ${attempt})`;
    if (!taken.has(candidate.trim().toLowerCase())) return candidate;
  }

  throw conflict("Too many copies of this rule already exist. Rename one first.");
}

/**
 * Author a new rule as a draft.
 *
 * Drafts start disabled and unsimulated — `activationProblems` will refuse to
 * enable one until it has been simulated at its current revision, so there is
 * no path from "created" straight to "running" without a person looking at
 * what it would have done.
 */
export async function createAutomationRuleAction(
  input: unknown,
): Promise<ActionResult<AutomationRule>> {
  return runAction("automation_rule.create", async () => {
    const config = createAutomationRuleInputSchema.parse(input);

    const context = await authorize("automation_rule.manage");

    const rule = await context.dataSource.automationRules.create(context.scope, config);

    await recordAuditEvent(context, {
      eventType: "automation_rule.created",
      entityType: "automation_rule",
      entityId: rule.id,
      previousState: null,
      newState: {
        name: config.name,
        priority: config.priority,
        conditions: config.conditions,
        actions: config.actions,
      },
      metadata: { ruleName: rule.name },
    });

    revalidatePath("/rules");
    return rule;
  });
}

/**
 * Structural edit to an existing rule.
 *
 * Refused up front — before the repository is even asked — for the two
 * states where a structural edit does not make sense: a rule currently
 * armed (disable it first, so nobody edits logic that is live) or a rule
 * that has been soft-deleted (restore it first). The repository enforces
 * the same two rules as a backstop for any caller that reaches it directly;
 * the messages here match those exactly so the refusal reads the same
 * everywhere it can be hit.
 */
export async function updateAutomationRuleAction(
  input: unknown,
): Promise<ActionResult<AutomationRule>> {
  return runAction("automation_rule.update", async () => {
    const { automationRuleId, expectedRevision, config } =
      updateAutomationRuleInputSchema.parse(input);

    const context = await authorize("automation_rule.manage");

    const existing = await context.dataSource.automationRules.get(
      context.scope,
      automationRuleId,
    );
    if (!existing) throw notFound("Automation rule");

    if (existing.status === "active") {
      throw conflict("Disable this rule to edit it.");
    }
    if (existing.archivedAt !== null) {
      throw conflict("This rule is archived. Restore it before editing it.");
    }

    const updated = await context.dataSource.automationRules.update(
      context.scope,
      automationRuleId,
      config,
      expectedRevision,
    );

    const changes = diff(existing, updated, [
      "name",
      "description",
      "priority",
      "conditions",
      "actions",
    ]);
    await recordAuditEvent(context, {
      eventType: "automation_rule.updated",
      entityType: "automation_rule",
      entityId: automationRuleId,
      previousState: changes.previousState,
      newState: changes.newState,
      metadata: { ruleName: updated.name },
    });

    revalidatePath("/rules");
    revalidatePath(`/rules/${automationRuleId}`);
    return updated;
  });
}

/**
 * Copy a rule as a fresh, never-simulated draft.
 *
 * The copy always starts from scratch — draft status, revision 1, no
 * simulation — even when the source is active, because a duplicate is a
 * starting point for editing, not a second instance of something already
 * running.
 */
export async function duplicateAutomationRuleAction(
  input: unknown,
): Promise<ActionResult<AutomationRule>> {
  return runAction("automation_rule.duplicate", async () => {
    const { automationRuleId } = duplicateAutomationRuleInputSchema.parse(input);

    const context = await authorize("automation_rule.manage");

    const source = await context.dataSource.automationRules.get(
      context.scope,
      automationRuleId,
    );
    if (!source) throw notFound("Automation rule");

    const name = await deriveDuplicateName(context, source.name);

    const newRule = await context.dataSource.automationRules.create(context.scope, {
      name,
      description: source.description,
      priority: source.priority,
      conditions: source.conditions,
      actions: source.actions,
    });

    await recordAuditEvent(context, {
      eventType: "automation_rule.duplicated",
      entityType: "automation_rule",
      entityId: newRule.id,
      previousState: null,
      newState: {
        name: newRule.name,
        priority: newRule.priority,
        conditions: newRule.conditions,
        actions: newRule.actions,
      },
      metadata: {
        ruleName: newRule.name,
        sourceRuleId: source.id,
        sourceRuleName: source.name,
      },
    });

    revalidatePath("/rules");
    return newRule;
  });
}

/**
 * Soft-delete a rule. The repository itself refuses to archive an active
 * rule (disable it first); that guard is not duplicated here so there is
 * exactly one place it can drift.
 */
export async function archiveAutomationRuleAction(
  input: unknown,
): Promise<ActionResult<AutomationRule>> {
  return runAction("automation_rule.archive", async () => {
    const { automationRuleId } = archiveAutomationRuleInputSchema.parse(input);

    const context = await authorize("automation_rule.manage");

    const existing = await context.dataSource.automationRules.get(
      context.scope,
      automationRuleId,
    );
    if (!existing) throw notFound("Automation rule");

    const archived = await context.dataSource.automationRules.archive(
      context.scope,
      automationRuleId,
    );

    await recordAuditEvent(context, {
      eventType: "automation_rule.archived",
      entityType: "automation_rule",
      entityId: automationRuleId,
      previousState: { archivedAt: existing.archivedAt },
      newState: { archivedAt: archived.archivedAt },
      metadata: { ruleName: existing.name },
    });

    revalidatePath("/rules");
    revalidatePath(`/rules/${automationRuleId}`);
    return archived;
  });
}

/**
 * Replay a rule against the last 30 days of activity without arming it.
 *
 * Only counts are ever audited — `evaluated`, `matched`, `truncated` — never
 * the sample content `simulateRule` returns for the UI. The sample can
 * include an excerpt of a real mention; the audit trail is not the place for
 * that.
 */
export async function simulateAutomationRuleAction(
  input: unknown,
): Promise<ActionResult<SimulationResult>> {
  return runAction("automation_rule.simulate", async () => {
    const { automationRuleId } = simulateAutomationRuleInputSchema.parse(input);

    const context = await authorize("automation_rule.manage");

    const rule = await context.dataSource.automationRules.get(
      context.scope,
      automationRuleId,
    );
    if (!rule) throw notFound("Automation rule");

    if (rule.archivedAt !== null) {
      throw conflict("This rule is archived. Restore it before simulating it.");
    }

    const result = await simulateRule(
      { dataSource: context.dataSource, scope: context.scope },
      rule,
      new Date(),
    );

    await context.dataSource.automationRules.recordSimulation(
      context.scope,
      automationRuleId,
      rule.revision,
    );

    await recordAuditEvent(context, {
      eventType: "automation_rule.simulated",
      entityType: "automation_rule",
      entityId: automationRuleId,
      previousState: null,
      newState: null,
      metadata: {
        ruleName: rule.name,
        evaluated: result.evaluated,
        matched: result.matched,
        truncated: result.truncated,
      },
    });

    revalidatePath(`/rules/${automationRuleId}`);
    return result;
  });
}

/**
 * Turn an automation rule on or off.
 *
 * Automation changes what the product does without a person in the loop, so
 * both directions are audited — enabling and disabling are equally consequential
 * when something later goes wrong and someone asks what was running.
 *
 * Enabling a rule that is not ready is refused here, before the repository
 * is ever asked, with every reason spelled out and its own audit trail
 * (`automation_rule.activation_refused`) — a refused attempt is itself worth
 * recording, not just a silent no-op. The repository's own `setEnabled`
 * check (`activationProblems`) stays in place as a backstop for any caller
 * that reaches it directly.
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

    if (enabled) {
      const problems = activationProblems(existing);
      if (problems.length > 0) {
        // Best-effort only: this write changes no state, it just records that
        // a refusal happened. The reason a person needs to see — which
        // conditions to fix — must reach them even if the audit layer itself
        // is unavailable, so a failure here is logged and swallowed rather
        // than allowed to replace the specific message below with
        // runAction's generic fallback.
        try {
          await recordAuditEvent(context, {
            eventType: "automation_rule.activation_refused",
            entityType: "automation_rule",
            entityId: automationRuleId,
            previousState: null,
            newState: null,
            metadata: {
              ruleName: existing.name,
              reasons: problems.map((problem) => problem.code),
            },
          });
        } catch (error) {
          console.error(
            "[action:automation_rule.toggle] failed to record activation refusal:",
            error,
          );
        }
        throw conflict(
          "This rule can't be enabled yet: " +
            problems.map((problem) => problem.message).join(" "),
        );
      }
    }

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
