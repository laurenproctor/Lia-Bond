import { describe, expect, it } from "vitest";
import {
  ACTION_CAPABILITIES,
  isActionExecutable,
} from "@/lib/rules/capabilities";
import { ruleActionSchema } from "@/domain/entities/automation";

describe("ACTION_CAPABILITIES", () => {
  it("covers every action type in the schema", () => {
    const schemaTypes = ruleActionSchema.options
      .map((o) => o.shape.type.value)
      .sort();
    expect(Object.keys(ACTION_CAPABILITIES).sort()).toEqual(schemaTypes);
  });

  it("only set_status and escalate are executable today", () => {
    const executable = Object.values(ACTION_CAPABILITIES)
      .filter((c) => c.executable)
      .map((c) => c.type)
      .sort();
    expect(executable).toEqual(["escalate", "set_status"]);
  });

  it("assign and tag are hidden; every blocked action explains itself", () => {
    expect(ACTION_CAPABILITIES.assign.showInBuilder).toBe(false);
    expect(ACTION_CAPABILITIES.tag.showInBuilder).toBe(false);
    for (const c of Object.values(ACTION_CAPABILITIES)) {
      if (!c.executable)
        expect((c.blockedReason ?? "").length).toBeGreaterThan(10);
      else expect(c.blockedReason).toBeNull();
    }
  });

  it("every capability has a sentence-case label", () => {
    for (const c of Object.values(ACTION_CAPABILITIES)) {
      expect(c.label.length).toBeGreaterThan(0);
      // sentence case: first char uppercase, not ALL CAPS.
      expect(c.label.charAt(0)).toBe(c.label.charAt(0).toUpperCase());
    }
  });

  it("labels match the spec exactly", () => {
    expect(ACTION_CAPABILITIES.set_status.label).toBe(
      "Set the mention's status",
    );
    expect(ACTION_CAPABILITIES.escalate.label).toBe(
      "Escalate for a person to handle",
    );
    expect(ACTION_CAPABILITIES.generate_draft.label).toBe(
      "Generate a draft reply",
    );
    expect(ACTION_CAPABILITIES.require_approval.label).toBe(
      "Hold for approval",
    );
    expect(ACTION_CAPABILITIES.notify.label).toBe("Send a notification");
    expect(ACTION_CAPABILITIES.auto_publish.label).toBe(
      "Publish automatically",
    );
    expect(ACTION_CAPABILITIES.assign.label).toBe("Assign to a teammate");
    expect(ACTION_CAPABILITIES.tag.label).toBe("Apply a tag");
  });

  it("auto_publish is not executable until a publishing connector exists", () => {
    expect(isActionExecutable("auto_publish")).toBe(false);
  });

  it("isActionExecutable agrees with the registry for every action", () => {
    for (const c of Object.values(ACTION_CAPABILITIES)) {
      expect(isActionExecutable(c.type)).toBe(c.executable);
    }
  });

  it("blocked reasons match Section 7 exactly", () => {
    expect(ACTION_CAPABILITIES.generate_draft.blockedReason).toBe(
      "Response generation is a manual step today. Lia cannot draft replies automatically yet.",
    );
    expect(ACTION_CAPABILITIES.require_approval.blockedReason).toBe(
      "Lia cannot raise an approval request yet — approvals are decided on drafts a person routes.",
    );
    expect(ACTION_CAPABILITIES.notify.blockedReason).toBe(
      "Lia has no notification delivery yet. Email exists only for the help form.",
    );
    expect(ACTION_CAPABILITIES.auto_publish.blockedReason).toBe(
      "Lia cannot publish replies to any platform yet. When publishing ships, auto-publish will also require positive, low-risk, routine review conditions.",
    );
    expect(ACTION_CAPABILITIES.assign.blockedReason).toBe(
      "Mentions have no assignee. Assignment applies to escalations and drafts, which rules do not target yet.",
    );
    expect(ACTION_CAPABILITIES.tag.blockedReason).toBe(
      "Lia has no tags — nothing in the product carries a tag.",
    );
  });
});
