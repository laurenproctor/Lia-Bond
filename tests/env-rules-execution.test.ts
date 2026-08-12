import { afterEach, describe, expect, it, vi } from "vitest";

async function loadEnv(vars: Record<string, string | undefined>) {
  vi.resetModules();
  for (const [key, value] of Object.entries(vars)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return import("@/lib/env");
}

afterEach(() => {
  delete process.env.RULES_EXECUTION_MODE;
  delete process.env.RULES_EXECUTION_ORG_ALLOWLIST;
  delete process.env.RULES_MAX_MENTIONS_PER_SWEEP;
});

describe("rules execution env", () => {
  it("defaults to off when unset", async () => {
    const env = await loadEnv({ RULES_EXECUTION_MODE: undefined });
    expect(env.resolveRulesExecutionMode()).toBe("off");
  });

  it("round-trips dry_run and apply", async () => {
    expect((await loadEnv({ RULES_EXECUTION_MODE: "dry_run" }))
      .resolveRulesExecutionMode()).toBe("dry_run");
    expect((await loadEnv({ RULES_EXECUTION_MODE: "apply" }))
      .resolveRulesExecutionMode()).toBe("apply");
  });

  it("rejects an invalid mode at import, like every other mode enum", async () => {
    // Consistent with the other mode enums in src/lib/env.ts (see
    // news-mock-mode.test.ts): an unrecognized value fails the startup Zod
    // parse, so the module import itself rejects before
    // resolveRulesExecutionMode is ever reached.
    await expect(loadEnv({ RULES_EXECUTION_MODE: "on" })).rejects.toThrow();
  });

  it("parses the allowlist, dropping empties and whitespace", async () => {
    const env = await loadEnv({ RULES_EXECUTION_ORG_ALLOWLIST: "a, b,,c" });
    expect(env.rulesExecutionAllowlist()).toEqual(["a", "b", "c"]);
    const empty = await loadEnv({ RULES_EXECUTION_ORG_ALLOWLIST: undefined });
    expect(empty.rulesExecutionAllowlist()).toEqual([]);
  });

  it("serves limit defaults and env overrides", async () => {
    const env = await loadEnv({});
    expect(env.rulesExecutionLimits()).toEqual({
      maxMentionsPerSweep: 200, maxActionsPerSweep: 500,
      maxRulesPerMention: 50, budgetMs: 60_000,
    });
    const tuned = await loadEnv({ RULES_MAX_MENTIONS_PER_SWEEP: "25" });
    expect(tuned.rulesExecutionLimits().maxMentionsPerSweep).toBe(25);
  });
});
