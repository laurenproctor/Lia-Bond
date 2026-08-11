/**
 * Action capability registry for automation rules.
 *
 * This is the single source of truth for what a rule action can actually do
 * today. Every action type in `ruleActionSchema` is representable in the rule
 * builder (people can author rules that anticipate capabilities Lia doesn't
 * have yet), but only some of them are *executable* — wired to a real effect
 * when a rule runs. The gap between "can be authored" and "can run" is
 * deliberate: it lets rules be drafted ahead of the product catching up, and
 * `activationProblems` (see `readiness.ts`) is what stops a rule with
 * non-executable actions from being turned on.
 *
 * `showInBuilder` is a stricter cut than `executable`: `assign` and `tag` are
 * hidden from the builder entirely because nothing in the product today has
 * an assignee or a tag to set — there is no future capability to preview,
 * just a dead end. Everything else stays visible so people can see the roadmap
 * shape of what a rule could eventually do.
 */

import type { RuleAction } from "@/domain/entities/automation";

export type RuleActionType = RuleAction["type"];

export interface ActionCapability {
  type: RuleActionType;
  /** Sentence-case label shown in the rule builder. */
  label: string;
  /** Whether this action currently produces a real effect when a rule runs. */
  executable: boolean;
  /** false hides the action from the builder entirely (assign, tag). */
  showInBuilder: boolean;
  /** Why this action is not executable yet. null when executable is true. */
  blockedReason: string | null;
}

export const ACTION_CAPABILITIES: Record<RuleActionType, ActionCapability> = {
  set_status: {
    type: "set_status",
    label: "Set the mention's status",
    executable: true,
    showInBuilder: true,
    blockedReason: null,
  },
  escalate: {
    type: "escalate",
    label: "Escalate for a person to handle",
    executable: true,
    showInBuilder: true,
    blockedReason: null,
  },
  generate_draft: {
    type: "generate_draft",
    label: "Generate a draft reply",
    executable: false,
    showInBuilder: true,
    blockedReason:
      "Response generation is a manual step today. Lia cannot draft replies automatically yet.",
  },
  require_approval: {
    type: "require_approval",
    label: "Hold for approval",
    executable: false,
    showInBuilder: true,
    blockedReason:
      "Lia cannot raise an approval request yet — approvals are decided on drafts a person routes.",
  },
  notify: {
    type: "notify",
    label: "Send a notification",
    executable: false,
    showInBuilder: true,
    blockedReason:
      "Lia has no notification delivery yet. Email exists only for the help form.",
  },
  auto_publish: {
    type: "auto_publish",
    label: "Publish automatically",
    executable: false,
    showInBuilder: true,
    blockedReason:
      "Lia cannot publish replies to any platform yet. When publishing ships, auto-publish will also require positive, low-risk, routine review conditions.",
  },
  assign: {
    type: "assign",
    label: "Assign to a teammate",
    executable: false,
    showInBuilder: false,
    blockedReason:
      "Mentions have no assignee. Assignment applies to escalations and drafts, which rules do not target yet.",
  },
  tag: {
    type: "tag",
    label: "Apply a tag",
    executable: false,
    showInBuilder: false,
    blockedReason: "Lia has no tags — nothing in the product carries a tag.",
  },
};

export function isActionExecutable(type: RuleActionType): boolean {
  return ACTION_CAPABILITIES[type].executable;
}
