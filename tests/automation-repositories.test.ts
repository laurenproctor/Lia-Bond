import { beforeEach, describe, expect, it } from "vitest";
import { freshDataSource, harbor, ushg } from "./helpers/scope";
import type { LiaDataSource } from "@/lib/data/types";
import type { AutomationRuleConfig } from "@/domain";
import { daysAgo } from "@/lib/seed/clock";

/**
 * Repository contract for automation rule authoring (Task 8).
 *
 * `list`/`get`/`setEnabled` are covered by tests/repositories.test.ts already;
 * this file exercises the five methods this workflow adds — `create`,
 * `update`, `archive`, `recordSimulation`, and `listSimulationCandidates` on
 * `mentions` — plus the readiness backstop `setEnabled` now enforces.
 */

let data: LiaDataSource;

beforeEach(() => {
  data = freshDataSource();
});

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

async function findRuleByName(scope: ReturnType<typeof ushg.admin>, name: string) {
  const rules = await data.automationRules.list(scope, { includeArchived: true });
  const rule = rules.find((row) => row.name === name);
  if (!rule) throw new Error(`Seeded rule "${name}" not found`);
  return rule;
}

describe("automationRules.create", () => {
  it("returns a draft at revision 1 with no simulation, and lists it", async () => {
    const created = await data.automationRules.create(
      ushg.admin(),
      executableConfig("Newly authored rule"),
    );

    expect(created.status).toBe("draft");
    expect(created.revision).toBe(1);
    expect(created.simulatedRevision).toBeNull();
    expect(created.lastSimulatedAt).toBeNull();
    expect(created.archivedAt).toBeNull();
    expect(created.lastRunAt).toBeNull();

    const rules = await data.automationRules.list(ushg.admin());
    expect(rules.some((row) => row.id === created.id)).toBe(true);
  });

  it("refuses a duplicate name, case-insensitively", async () => {
    await expect(
      data.automationRules.create(
        ushg.admin(),
        executableConfig("ESCALATE HIGH-RISK MENTIONS"),
      ),
    ).rejects.toThrow(/already exists/i);
  });

  it("does not let one organization's name collide with another's", async () => {
    // Harbor's "Escalate allergen mentions" name is distinct from anything in
    // USHG, so this must succeed — a global unique-name rule would be wrong.
    const created = await data.automationRules.create(
      harbor.owner(),
      executableConfig("Escalate high-risk mentions"),
    );
    expect(created.name).toBe("Escalate high-risk mentions");
  });
});

describe("automationRules.update", () => {
  it("bumps revision and replaces the config fields", async () => {
    const created = await data.automationRules.create(
      ushg.admin(),
      executableConfig("Rule to edit"),
    );

    const updated = await data.automationRules.update(
      ushg.admin(),
      created.id,
      {
        name: "Rule to edit (renamed)",
        description: "Now with a description.",
        priority: 5,
        conditions: [{ field: "sentiment", operator: "is", value: "negative" }],
        actions: [{ type: "set_status", status: "dismissed" }],
      },
      created.revision,
    );

    expect(updated.revision).toBe(created.revision + 1);
    expect(updated.name).toBe("Rule to edit (renamed)");
    expect(updated.description).toBe("Now with a description.");
    expect(updated.priority).toBe(5);
    expect(updated.conditions).toEqual([
      { field: "sentiment", operator: "is", value: "negative" },
    ]);
    expect(updated.actions).toEqual([{ type: "set_status", status: "dismissed" }]);
  });

  it("does not reset simulatedRevision — staleness falls out of revision vs simulatedRevision", async () => {
    const created = await data.automationRules.create(
      ushg.admin(),
      executableConfig("Rule kept simulated"),
    );
    const simulated = await data.automationRules.recordSimulation(
      ushg.admin(),
      created.id,
      created.revision,
    );
    expect(simulated.simulatedRevision).toBe(1);

    const updated = await data.automationRules.update(
      ushg.admin(),
      created.id,
      executableConfig("Rule kept simulated"),
      simulated.revision,
    );

    // simulatedRevision (1) now lags the new revision (2) — that gap is what
    // marks it stale, rather than the field being cleared outright.
    expect(updated.simulatedRevision).toBe(1);
    expect(updated.revision).toBe(2);
  });

  it("optimistic concurrency: a second update against a stale revision is refused and the row is untouched", async () => {
    const created = await data.automationRules.create(
      ushg.admin(),
      executableConfig("Contested rule"),
    );

    // Two "administrators" both read the rule at revision 1.
    const readByFirst = await data.automationRules.get(ushg.admin(), created.id);
    const readBySecond = await data.automationRules.get(ushg.admin(), created.id);
    expect(readByFirst!.revision).toBe(1);
    expect(readBySecond!.revision).toBe(1);

    const firstUpdate = await data.automationRules.update(
      ushg.admin(),
      created.id,
      executableConfig("Contested rule (first editor)"),
      readByFirst!.revision,
    );
    expect(firstUpdate.revision).toBe(2);

    await expect(
      data.automationRules.update(
        ushg.admin(),
        created.id,
        executableConfig("Contested rule (second editor)"),
        readBySecond!.revision,
      ),
    ).rejects.toThrow(/changed .* reload/i);

    const unchanged = await data.automationRules.get(ushg.admin(), created.id);
    expect(unchanged!.name).toBe("Contested rule (first editor)");
    expect(unchanged!.revision).toBe(2);
  });

  it("refuses to edit an active rule", async () => {
    const active = await findRuleByName(ushg.admin(), "Escalate high-risk mentions");

    await expect(
      data.automationRules.update(
        ushg.admin(),
        active.id,
        executableConfig("Escalate high-risk mentions"),
        active.revision,
      ),
    ).rejects.toThrow(/disable/i);
  });

  it("refuses to edit an archived rule", async () => {
    const created = await data.automationRules.create(
      ushg.admin(),
      executableConfig("Rule that will be archived"),
    );
    const archived = await data.automationRules.archive(ushg.admin(), created.id);

    await expect(
      data.automationRules.update(
        ushg.admin(),
        created.id,
        executableConfig("Rule that will be archived"),
        archived.revision,
      ),
    ).rejects.toThrow(/conflict|archiv/i);
  });
});

describe("automationRules.archive", () => {
  it("sets archivedAt, removes it from the default list, keeps it in includeArchived and get", async () => {
    const created = await data.automationRules.create(
      ushg.admin(),
      executableConfig("Rule to archive"),
    );

    const archived = await data.automationRules.archive(ushg.admin(), created.id);
    expect(archived.archivedAt).not.toBeNull();

    const defaultList = await data.automationRules.list(ushg.admin());
    expect(defaultList.some((row) => row.id === created.id)).toBe(false);

    const fullList = await data.automationRules.list(ushg.admin(), { includeArchived: true });
    expect(fullList.some((row) => row.id === created.id)).toBe(true);

    const fetched = await data.automationRules.get(ushg.admin(), created.id);
    expect(fetched?.archivedAt).not.toBeNull();
  });

  it("refuses to archive an active rule", async () => {
    const active = await findRuleByName(ushg.admin(), "Escalate high-risk mentions");

    await expect(data.automationRules.archive(ushg.admin(), active.id)).rejects.toThrow(
      /disable/i,
    );
  });
});

describe("automationRules.recordSimulation", () => {
  it("marks the current revision simulated", async () => {
    const created = await data.automationRules.create(
      ushg.admin(),
      executableConfig("Rule to simulate"),
    );

    const simulated = await data.automationRules.recordSimulation(
      ushg.admin(),
      created.id,
      created.revision,
    );

    expect(simulated.simulatedRevision).toBe(created.revision);
    expect(simulated.lastSimulatedAt).not.toBeNull();
  });

  it("refuses a stale revision", async () => {
    const created = await data.automationRules.create(
      ushg.admin(),
      executableConfig("Rule with stale simulation attempt"),
    );

    await expect(
      data.automationRules.recordSimulation(ushg.admin(), created.id, created.revision + 1),
    ).rejects.toThrow(/simulate/i);
  });
});

describe("automationRules.setEnabled readiness backstop", () => {
  it("enables a freshly created, freshly simulated, executable rule", async () => {
    const created = await data.automationRules.create(
      ushg.admin(),
      executableConfig("Ready to enable"),
    );
    await data.automationRules.recordSimulation(ushg.admin(), created.id, created.revision);

    const enabled = await data.automationRules.setEnabled(ushg.admin(), created.id, true);
    expect(enabled.status).toBe("active");
  });

  it("refuses a rule whose only action is unexecutable, naming the gap", async () => {
    const mediaWatch = await findRuleByName(ushg.admin(), "Flag high-authority media coverage");

    await expect(
      data.automationRules.setEnabled(ushg.admin(), mediaWatch.id, true),
    ).rejects.toThrow(/notification/i);
  });

  it("refuses a never-simulated draft", async () => {
    const draft = await findRuleByName(ushg.admin(), "Dismiss low-relevance chatter");
    expect(draft.simulatedRevision).toBeNull();

    await expect(
      data.automationRules.setEnabled(ushg.admin(), draft.id, true),
    ).rejects.toThrow(/simulate/i);
  });
});

describe("tenant isolation on the new automation methods", () => {
  it("get returns null across tenants", async () => {
    const [theirRule] = await data.automationRules.list(harbor.owner());
    expect(await data.automationRules.get(ushg.admin(), theirRule!.id)).toBeNull();
  });

  it("update on a foreign rule id is refused", async () => {
    const [theirRule] = await data.automationRules.list(harbor.owner());

    await expect(
      data.automationRules.update(
        ushg.admin(),
        theirRule!.id,
        executableConfig("Hijacked"),
        theirRule!.revision,
      ),
    ).rejects.toThrow(/not found/i);
  });

  it("archive on a foreign rule id is refused", async () => {
    const [theirDraft] = await data.automationRules.list(harbor.owner(), {
      statuses: ["draft"],
    });
    // Harbor seeds no draft rule today; fall back to any rule if that changes.
    const [fallback] = await data.automationRules.list(harbor.owner());
    const target = theirDraft ?? fallback;

    await expect(
      data.automationRules.archive(ushg.admin(), target!.id),
    ).rejects.toThrow(/not found/i);
  });

  it("recordSimulation on a foreign rule id is refused", async () => {
    const [theirRule] = await data.automationRules.list(harbor.owner());

    await expect(
      data.automationRules.recordSimulation(ushg.admin(), theirRule!.id, theirRule!.revision),
    ).rejects.toThrow(/not found/i);
  });

  it("setEnabled on a foreign rule id is refused", async () => {
    const [theirRule] = await data.automationRules.list(harbor.owner());

    await expect(
      data.automationRules.setEnabled(ushg.admin(), theirRule!.id, false),
    ).rejects.toThrow(/not found/i);
  });

  it("listSimulationCandidates never crosses the tenant boundary", async () => {
    const mine = await data.mentions.listSimulationCandidates(ushg.admin(), {
      publishedAfter: daysAgo(3650),
      limit: 500,
    });
    const theirs = await data.mentions.listSimulationCandidates(harbor.owner(), {
      publishedAfter: daysAgo(3650),
      limit: 500,
    });

    expect(mine.length).toBeGreaterThan(0);
    expect(theirs.length).toBeGreaterThan(0);
    const overlap = mine.filter((row) => theirs.some((other) => other.id === row.id));
    expect(overlap).toEqual([]);
  });
});

describe("mentions.listSimulationCandidates", () => {
  // REFERENCE_NOW is 2026-08-01T18:00:00.000Z; two days back splits the
  // seeded USHG mentions into 15 within the window and 7 outside it.
  const cutoff = daysAgo(2);

  it("respects publishedAfter", async () => {
    const candidates = await data.mentions.listSimulationCandidates(ushg.admin(), {
      publishedAfter: cutoff,
      limit: 500,
    });

    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.publishedAt >= cutoff).toBe(true);
    }

    const everything = await data.mentions.listSimulationCandidates(ushg.admin(), {
      publishedAfter: daysAgo(3650),
      limit: 500,
    });
    expect(everything.length).toBeGreaterThan(candidates.length);
  });

  it("respects limit", async () => {
    const candidates = await data.mentions.listSimulationCandidates(ushg.admin(), {
      publishedAfter: cutoff,
      limit: 5,
    });
    expect(candidates).toHaveLength(5);
  });

  it("sorts newest published first", async () => {
    const candidates = await data.mentions.listSimulationCandidates(ushg.admin(), {
      publishedAfter: cutoff,
      limit: 500,
    });
    const timestamps = candidates.map((row) => Date.parse(row.publishedAt));
    expect([...timestamps].sort((a, b) => b - a)).toEqual(timestamps);
  });

  it("carries a short excerpt only, never the full mention body", async () => {
    const candidates = await data.mentions.listSimulationCandidates(ushg.admin(), {
      publishedAfter: cutoff,
      limit: 500,
    });

    expect(candidates.length).toBeGreaterThan(0);
    for (const candidate of candidates) {
      expect(candidate.excerpt.length).toBeLessThanOrEqual(140);
      expect(candidate).not.toHaveProperty("content");
    }
  });
});
