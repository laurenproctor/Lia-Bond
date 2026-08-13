import { describe, it, expect } from "vitest";
import {
  RULE_TEMPLATES,
  resolveRuleTemplate,
} from "@/lib/rules/templates";
import {
  automationRuleConfigSchema,
  isAutoPublishSafe,
} from "@/domain";
import {
  isActionExecutable,
} from "@/lib/rules/capabilities";

describe("Rule Templates", () => {
  it("has exactly five templates with the correct ids", () => {
    expect(RULE_TEMPLATES).toHaveLength(5);
    const ids = RULE_TEMPLATES.map((t) => t.id);
    expect(ids).toEqual([
      "quiet-low-relevance",
      "escalate-negative-news",
      "escalate-one-star",
      "approval-first-reddit",
      "auto-publish-glowing",
    ]);
  });

  it("each template's config parses against automationRuleConfigSchema", () => {
    for (const template of RULE_TEMPLATES) {
      const result = automationRuleConfigSchema.safeParse(template.config);
      expect(result.success).toBe(true);
      if (!result.success) {
        console.error(`Template ${template.id} config validation failed:`, result.error);
      }
    }
  });

  it("no serialized template contains a uuid", () => {
    const serialized = JSON.stringify(RULE_TEMPLATES);
    // UUID pattern: 8-4-4-4-12 hex digits
    const uuidPattern = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
    expect(serialized).not.toMatch(uuidPattern);
  });

  it("available is true exactly when every requiredActionTypes is executable", () => {
    for (const template of RULE_TEMPLATES) {
      const expectedAvailable = template.requiredActionTypes.every(
        isActionExecutable
      );
      expect(template.available).toBe(expectedAvailable);
    }
  });

  it("unavailable templates carry a non-null reason; available ones null", () => {
    for (const template of RULE_TEMPLATES) {
      if (template.available) {
        expect(template.unavailableReason).toBeNull();
      } else {
        expect(template.unavailableReason).not.toBeNull();
        expect(typeof template.unavailableReason).toBe("string");
      }
    }
  });

  it("template 5 (auto-publish-glowing) config passes isAutoPublishSafe", () => {
    const template = RULE_TEMPLATES.find(
      (t) => t.id === "auto-publish-glowing"
    );
    expect(template).toBeDefined();
    if (template) {
      expect(isAutoPublishSafe(template.config)).toBe(true);
    }
  });

  it("requiredActionTypes matches distinct action types in config", () => {
    for (const template of RULE_TEMPLATES) {
      const actionTypesInConfig = Array.from(
        new Set(template.config.actions.map((a) => a.type))
      );
      expect(template.requiredActionTypes.sort()).toEqual(
        actionTypesInConfig.sort()
      );
    }
  });

  describe("resolveRuleTemplate", () => {
    it("resolves a known id to the template the builder is seeded from", () => {
      const template = resolveRuleTemplate("escalate-one-star");
      expect(template?.id).toBe("escalate-one-star");
      expect(template?.config.name).toBe("Escalate one-star reviews");
      expect(template?.config.conditions).toHaveLength(2);
      expect(template?.config.actions).toHaveLength(1);
    });

    it("falls back to null for an absent, empty, or unknown id", () => {
      expect(resolveRuleTemplate(undefined)).toBeNull();
      expect(resolveRuleTemplate("")).toBeNull();
      expect(resolveRuleTemplate("not-a-template")).toBeNull();
      expect(resolveRuleTemplate("ESCALATE-ONE-STAR")).toBeNull();
    });

    it("resolves every template the panel links to", () => {
      // The panel's "Use template" href is `/rules/new?template=<id>`, so
      // every available template's id must round-trip back to itself.
      for (const template of RULE_TEMPLATES.filter((entry) => entry.available)) {
        expect(resolveRuleTemplate(template.id)).toBe(template);
      }
    });
  });

  describe("template properties", () => {
    it("template 1: quiet-low-relevance", () => {
      const template = RULE_TEMPLATES.find(
        (t) => t.id === "quiet-low-relevance"
      );
      expect(template).toBeDefined();
      expect(template?.name).toBe("Quiet low-relevance chatter");
      expect(template?.available).toBe(true);
      expect(template?.unavailableReason).toBeNull();
      expect(template?.requiredActionTypes).toContain("set_status");
    });

    it("template 2: escalate-negative-news", () => {
      const template = RULE_TEMPLATES.find(
        (t) => t.id === "escalate-negative-news"
      );
      expect(template).toBeDefined();
      expect(template?.name).toBe("Escalate negative news coverage");
      expect(template?.available).toBe(true);
      expect(template?.unavailableReason).toBeNull();
      expect(template?.requiredActionTypes).toContain("escalate");
    });

    it("template 3: escalate-one-star", () => {
      const template = RULE_TEMPLATES.find(
        (t) => t.id === "escalate-one-star"
      );
      expect(template).toBeDefined();
      expect(template?.name).toBe("Escalate one-star reviews");
      expect(template?.available).toBe(true);
      expect(template?.unavailableReason).toBeNull();
      expect(template?.requiredActionTypes).toContain("escalate");
    });

    it("template 4: approval-first-reddit is unavailable with correct reason", () => {
      const template = RULE_TEMPLATES.find(
        (t) => t.id === "approval-first-reddit"
      );
      expect(template).toBeDefined();
      expect(template?.name).toBe("Approval-first Reddit replies");
      expect(template?.available).toBe(false);
      expect(template?.unavailableReason).toBe(
        "Needs automated drafting and approval routing, which are manual steps today."
      );
      expect(template?.requiredActionTypes).toContain("generate_draft");
      expect(template?.requiredActionTypes).toContain("require_approval");
    });

    it("template 5: auto-publish-glowing is unavailable with correct reason", () => {
      const template = RULE_TEMPLATES.find(
        (t) => t.id === "auto-publish-glowing"
      );
      expect(template).toBeDefined();
      expect(template?.name).toBe("Auto-publish glowing Google replies");
      expect(template?.available).toBe(false);
      expect(template?.unavailableReason).toBe(
        "Needs publishing support Lia does not have yet."
      );
      expect(template?.requiredActionTypes).toContain("generate_draft");
      expect(template?.requiredActionTypes).toContain("auto_publish");
    });
  });
});
