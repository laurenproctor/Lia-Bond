import { beforeEach, describe, expect, it } from "vitest";
import { vi } from "vitest";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import { freshDataSource, scopeFor, ushg, ORG_USHG } from "./helpers/scope";
import { USER_JORDAN } from "@/lib/seed/dataset";
import { can, explainDenial, type Permission } from "@/lib/auth/permissions";
import { DataError } from "@/lib/data/errors";
import type { AutomationRuleConfig } from "@/domain";
import {
  archiveAutomationRuleAction,
  createAutomationRuleAction,
  duplicateAutomationRuleAction,
  setAutomationRuleEnabledAction,
  simulateAutomationRuleAction,
  updateAutomationRuleAction,
} from "@/app/actions/automation";

/**
 * Server-action contract for rule authoring (Task 11).
 *
 * `@/lib/actions/guard`'s `authorize` is mocked so this runs with no
 * `next/headers` session machinery, the same pattern `monitoring-actions.test.ts`
 * uses — but `mockAuthorizeAs` reimplements the real `can()`/`explainDenial()`
 * check rather than always granting access, so the permission-refusal tests
 * below exercise the genuine role matrix instead of a test-only shortcut.
 */

const authorizeMock = vi.fn();

vi.mock("@/lib/actions/guard", () => ({
  authorize: (permission: string) => authorizeMock(permission),
}));

// `revalidatePath` requires a live Next.js request scope that does not exist
// under Vitest; every action under test calls it on the success path, so it
// is stubbed to a no-op the same way a route or component test would get it
// for free from the Next test runtime.
vi.mock("next/cache", () => ({
  revalidatePath: () => {},
}));

let dataSource: LiaDataSource;

function contextFor(scope: OrganizationScope) {
  return {
    // Only `scope`, `userId`, `role`, and `dataSource` are read by the code
    // under test; the rest of `MutationContext` is unused here.
    organization: { id: scope.organizationId },
    role: scope.role,
    userId: scope.userId,
    scope,
    available: [],
    dataSource,
  };
}

/** Grants access exactly like the real `authorize()` would for this scope. */
function mockAuthorizeAs(scope: OrganizationScope) {
  authorizeMock.mockImplementation(async (permission: Permission) => {
    if (!can(scope.role, permission)) {
      throw new DataError("forbidden", explainDenial(permission, scope.role));
    }
    return contextFor(scope);
  });
}

/** A viewer role has no seeded USHG member; the scope is manufactured directly
 * since these tests mock `authorize` and never touch the memberships table. */
const ushgViewer = () => scopeFor(ORG_USHG, USER_JORDAN, "viewer");

/** The roles `automation_rule.manage` and `automation_rule.toggle` both deny. */
const DENIED_SCOPES: [string, () => OrganizationScope][] = [
  ["analyst", ushg.analyst],
  ["viewer", ushgViewer],
  ["approver", ushg.approver],
  ["location_manager", ushg.locationManager],
];

/** A config that passes `activationProblems` once simulated: one condition, one executable action. */
function executableConfig(name: string): AutomationRuleConfig {
  return {
    name,
    description: null,
    priority: 100,
    conditions: [{ field: "risk_level", operator: "at_least", value: "high" }],
    actions: [{ type: "escalate", assigneeUserId: null }],
  };
}

async function findRuleByName(scope: OrganizationScope, name: string) {
  const rules = await dataSource.automationRules.list(scope, { includeArchived: true });
  const rule = rules.find((row) => row.name === name);
  if (!rule) throw new Error(`Rule "${name}" not found`);
  return rule;
}

async function ruleAuditEvents(scope: OrganizationScope, entityId: string) {
  return dataSource.auditEvents.list(scope, {
    entityType: "automation_rule",
    entityId,
  });
}

beforeEach(() => {
  dataSource = freshDataSource();
  authorizeMock.mockReset();
});

describe("createAutomationRuleAction", () => {
  it("creates a draft rule and records a created event with structured arrays", async () => {
    const scope = ushg.admin();
    mockAuthorizeAs(scope);

    const result = await createAutomationRuleAction(executableConfig("Newly authored rule"));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.status).toBe("draft");
    expect(result.data.revision).toBe(1);
    expect(result.data.simulatedRevision).toBeNull();

    const events = await ruleAuditEvents(scope, result.data.id);
    const created = events.find((event) => event.eventType === "automation_rule.created");
    expect(created).toBeDefined();
    expect(created?.previousState).toBeNull();
    expect(created?.metadata.ruleName).toBe("Newly authored rule");
    expect(Array.isArray(created?.newState?.conditions)).toBe(true);
    expect(Array.isArray(created?.newState?.actions)).toBe(true);
  });

  it("rejects invalid input with field errors", async () => {
    const scope = ushg.admin();
    mockAuthorizeAs(scope);

    const result = await createAutomationRuleAction({ name: "" });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.fieldErrors).toBeDefined();
    expect(result.fieldErrors?.name).toBeDefined();
  });

  it.each(DENIED_SCOPES)("refuses %s and creates nothing", async (_label, scopeFactory) => {
    const scope = scopeFactory();
    mockAuthorizeAs(scope);

    const before = await dataSource.automationRules.list(ushg.admin(), { includeArchived: true });
    const result = await createAutomationRuleAction(executableConfig("Should not exist"));

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/role/i);

    const after = await dataSource.automationRules.list(ushg.admin(), { includeArchived: true });
    expect(after.length).toBe(before.length);
  });
});

describe("updateAutomationRuleAction", () => {
  it("bumps the revision and records an updated event with a structured diff", async () => {
    const scope = ushg.admin();
    mockAuthorizeAs(scope);

    const created = await createAutomationRuleAction(executableConfig("Editable rule"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await updateAutomationRuleAction({
      automationRuleId: created.data.id,
      expectedRevision: created.data.revision,
      config: {
        ...executableConfig("Editable rule"),
        priority: 5,
        conditions: [
          { field: "risk_level", operator: "at_least", value: "high" },
          { field: "sentiment", operator: "is", value: "negative" },
        ],
      },
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.revision).toBe(created.data.revision + 1);
    expect(result.data.priority).toBe(5);

    const events = await ruleAuditEvents(scope, created.data.id);
    const updated = events.find((event) => event.eventType === "automation_rule.updated");
    expect(updated).toBeDefined();
    expect(Array.isArray(updated?.newState?.conditions)).toBe(true);
    expect(updated?.newState?.priority).toBe(5);
    expect(updated?.previousState?.priority).toBe(100);
  });

  it("refuses to edit an active rule", async () => {
    const scope = ushg.admin();
    mockAuthorizeAs(scope);

    const created = await createAutomationRuleAction(executableConfig("Active rule"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const simulated = await simulateAutomationRuleAction({ automationRuleId: created.data.id });
    expect(simulated.ok).toBe(true);

    const enabled = await setAutomationRuleEnabledAction({
      automationRuleId: created.data.id,
      enabled: true,
    });
    expect(enabled.ok).toBe(true);

    const result = await updateAutomationRuleAction({
      automationRuleId: created.data.id,
      expectedRevision: created.data.revision,
      config: executableConfig("Active rule"),
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/disable/i);
  });

  it("refuses a stale revision with the reload message, leaving the winning edit intact", async () => {
    const scope = ushg.admin();
    mockAuthorizeAs(scope);

    const created = await createAutomationRuleAction(executableConfig("Contested rule"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const first = await updateAutomationRuleAction({
      automationRuleId: created.data.id,
      expectedRevision: created.data.revision,
      config: { ...executableConfig("Contested rule"), priority: 10 },
    });
    expect(first.ok).toBe(true);

    const second = await updateAutomationRuleAction({
      automationRuleId: created.data.id,
      expectedRevision: created.data.revision, // stale — the first update already bumped it
      config: { ...executableConfig("Contested rule"), priority: 20 },
    });

    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second.error).toMatch(/reload/i);

    const current = await dataSource.automationRules.get(scope, created.data.id);
    expect(current?.priority).toBe(10);
  });

  it.each(DENIED_SCOPES)("refuses %s and changes nothing", async (_label, scopeFactory) => {
    const adminScope = ushg.admin();
    mockAuthorizeAs(adminScope);
    const created = await createAutomationRuleAction(executableConfig("Guarded rule"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const scope = scopeFactory();
    mockAuthorizeAs(scope);
    const result = await updateAutomationRuleAction({
      automationRuleId: created.data.id,
      expectedRevision: created.data.revision,
      config: { ...executableConfig("Guarded rule"), priority: 999 },
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/role/i);

    const unchanged = await dataSource.automationRules.get(adminScope, created.data.id);
    expect(unchanged?.priority).toBe(100);
  });
});

describe("duplicateAutomationRuleAction", () => {
  it("copies a rule as a fresh, never-simulated draft named '<name> (copy)'", async () => {
    const scope = ushg.admin();
    mockAuthorizeAs(scope);

    const source = await findRuleByName(scope, "Escalate high-risk mentions");

    const result = await duplicateAutomationRuleAction({ automationRuleId: source.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.name).toBe("Escalate high-risk mentions (copy)");
    expect(result.data.status).toBe("draft");
    expect(result.data.simulatedRevision).toBeNull();
    expect(result.data.revision).toBe(1);
    expect(result.data.conditions).toEqual(source.conditions);
    expect(result.data.actions).toEqual(source.actions);

    const events = await ruleAuditEvents(scope, result.data.id);
    const duplicated = events.find((event) => event.eventType === "automation_rule.duplicated");
    expect(duplicated).toBeDefined();
    expect(duplicated?.previousState).toBeNull();
    expect(duplicated?.metadata.sourceRuleId).toBe(source.id);
    expect(duplicated?.metadata.sourceRuleName).toBe(source.name);
    expect(duplicated?.metadata.ruleName).toBe("Escalate high-risk mentions (copy)");
  });

  it.each(DENIED_SCOPES)("refuses %s and creates nothing", async (_label, scopeFactory) => {
    const adminScope = ushg.admin();
    const source = await findRuleByName(adminScope, "Escalate high-risk mentions");

    const scope = scopeFactory();
    mockAuthorizeAs(scope);

    const before = await dataSource.automationRules.list(adminScope, { includeArchived: true });
    const result = await duplicateAutomationRuleAction({ automationRuleId: source.id });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/role/i);

    const after = await dataSource.automationRules.list(adminScope, { includeArchived: true });
    expect(after.length).toBe(before.length);
  });
});

describe("archiveAutomationRuleAction", () => {
  it("sets archivedAt and records an archived event", async () => {
    const scope = ushg.admin();
    mockAuthorizeAs(scope);

    const created = await createAutomationRuleAction(executableConfig("Rule to archive"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(created.data.archivedAt).toBeNull();

    const result = await archiveAutomationRuleAction({ automationRuleId: created.data.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.archivedAt).not.toBeNull();

    const events = await ruleAuditEvents(scope, created.data.id);
    const archived = events.find((event) => event.eventType === "automation_rule.archived");
    expect(archived).toBeDefined();
    expect(archived?.previousState).toEqual({ archivedAt: null });
    expect(archived?.newState?.archivedAt).toBe(result.data.archivedAt);
    expect(archived?.metadata.ruleName).toBe("Rule to archive");
  });

  it.each(DENIED_SCOPES)("refuses %s and archives nothing", async (_label, scopeFactory) => {
    const adminScope = ushg.admin();
    mockAuthorizeAs(adminScope);
    const created = await createAutomationRuleAction(executableConfig("Guarded rule to archive"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const scope = scopeFactory();
    mockAuthorizeAs(scope);
    const result = await archiveAutomationRuleAction({ automationRuleId: created.data.id });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/role/i);

    const unchanged = await dataSource.automationRules.get(adminScope, created.data.id);
    expect(unchanged?.archivedAt).toBeNull();
  });
});

describe("simulateAutomationRuleAction", () => {
  it("returns a simulation result and records the simulation on the rule row", async () => {
    const scope = ushg.admin();
    mockAuthorizeAs(scope);

    const created = await createAutomationRuleAction(executableConfig("Simulated rule"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const result = await simulateAutomationRuleAction({ automationRuleId: created.data.id });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.data.ruleId).toBe(created.data.id);
    expect(typeof result.data.evaluated).toBe("number");
    expect(typeof result.data.matched).toBe("number");

    const stored = await dataSource.automationRules.get(scope, created.data.id);
    expect(stored?.simulatedRevision).toBe(created.data.revision);
    expect(stored?.lastSimulatedAt).not.toBeNull();

    const events = await ruleAuditEvents(scope, created.data.id);
    const simulated = events.find((event) => event.eventType === "automation_rule.simulated");
    expect(simulated).toBeDefined();
    expect(simulated?.previousState).toBeNull();
    expect(simulated?.newState).toBeNull();
    expect(typeof simulated?.metadata.evaluated).toBe("number");
    expect(typeof simulated?.metadata.matched).toBe("number");
    expect(Object.keys(simulated?.metadata ?? {}).sort()).toEqual(
      ["evaluated", "matched", "ruleName", "truncated"].sort(),
    );
  });

  it.each(DENIED_SCOPES)("refuses %s and records no simulation", async (_label, scopeFactory) => {
    const adminScope = ushg.admin();
    mockAuthorizeAs(adminScope);
    const created = await createAutomationRuleAction(executableConfig("Guarded simulation rule"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const scope = scopeFactory();
    mockAuthorizeAs(scope);
    const result = await simulateAutomationRuleAction({ automationRuleId: created.data.id });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/role/i);

    const unchanged = await dataSource.automationRules.get(adminScope, created.data.id);
    expect(unchanged?.simulatedRevision).toBeNull();
  });
});

describe("setAutomationRuleEnabledAction", () => {
  it("enables a fully ready rule and disables it again", async () => {
    const scope = ushg.admin();
    mockAuthorizeAs(scope);

    const created = await createAutomationRuleAction(executableConfig("Toggleable rule"));
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const simulated = await simulateAutomationRuleAction({ automationRuleId: created.data.id });
    expect(simulated.ok).toBe(true);

    const enabled = await setAutomationRuleEnabledAction({
      automationRuleId: created.data.id,
      enabled: true,
    });
    expect(enabled.ok).toBe(true);
    if (!enabled.ok) return;
    expect(enabled.data.status).toBe("active");

    const disabled = await setAutomationRuleEnabledAction({
      automationRuleId: created.data.id,
      enabled: false,
    });
    expect(disabled.ok).toBe(true);
    if (!disabled.ok) return;
    expect(disabled.data.status).toBe("inactive");
  });

  it("refuses to enable an unready rule (media-watch), audits the refusal, and leaves it inactive", async () => {
    const scope = ushg.admin();
    mockAuthorizeAs(scope);

    const mediaWatch = await findRuleByName(scope, "Flag high-authority media coverage");
    expect(mediaWatch.status).toBe("inactive");

    const result = await setAutomationRuleEnabledAction({
      automationRuleId: mediaWatch.id,
      enabled: true,
    });

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/can't be enabled/i);

    const events = await ruleAuditEvents(scope, mediaWatch.id);
    const refused = events.find(
      (event) => event.eventType === "automation_rule.activation_refused",
    );
    expect(refused).toBeDefined();
    expect(refused?.previousState).toBeNull();
    expect(refused?.newState).toBeNull();
    const reasons = refused?.metadata.reasons as string[];
    expect(reasons).toContain("unexecutable_action:notify");

    const unchanged = await dataSource.automationRules.get(scope, mediaWatch.id);
    expect(unchanged?.status).toBe("inactive");

    // No enable/disable event was written — only the refusal.
    const enabledEvents = events.filter((event) => event.eventType === "automation_rule.enabled");
    expect(enabledEvents.length).toBe(0);
  });

  it("still returns the specific refusal message when the audit write itself fails", async () => {
    const scope = ushg.admin();
    mockAuthorizeAs(scope);

    const mediaWatch = await findRuleByName(scope, "Flag high-authority media coverage");

    const original = dataSource.auditEvents.record.bind(dataSource.auditEvents);
    dataSource.auditEvents.record = () => {
      throw new Error("audit down");
    };

    try {
      const result = await setAutomationRuleEnabledAction({
        automationRuleId: mediaWatch.id,
        enabled: true,
      });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error).toMatch(/can't be enabled yet/i);
      expect(result.error).toMatch(/notification/i);
      expect(result.error).not.toMatch(/something went wrong/i);
    } finally {
      dataSource.auditEvents.record = original;
    }
  });
});
