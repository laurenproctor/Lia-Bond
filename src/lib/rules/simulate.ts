/**
 * Side-effect-free 30-day simulation service for automation rules.
 *
 * `simulateRule` answers "if this rule were active, what would it have done to
 * the last 30 days of activity?" by replaying `matchesRule` (the same
 * evaluator the future execution engine will use) against a recent sample of
 * mentions. It performs exactly two reads — `mentions.listSimulationCandidates`
 * and `platformConnections.list` — and nothing else: no writes, no AI calls,
 * no `recordSimulation`. Marking a rule as simulated is the server action's
 * job, one layer up, once it has this result in hand; that keeps "compute a
 * preview" and "persist that a preview happened" as separate, independently
 * testable steps.
 *
 * Pure by import as well as by behavior: this module reaches into
 * `@/domain` and `@/lib/rules/*` only, plus the repository *types* from
 * `@/lib/data/types`. It never imports `@/ai` or a concrete adapter
 * (`@/lib/data/demo`, `@/lib/data/supabase`) — the `dataSource` it runs
 * against is always injected by the caller.
 */

import type {
  AutomationRule,
  MentionSourceType,
  RiskLevel,
} from "@/domain";
import { ACTION_CAPABILITIES, type RuleActionType } from "@/lib/rules/capabilities";
import { matchesRule, type RuleSubject } from "@/lib/rules/evaluate";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";

/** How far back the simulator looks for candidate mentions. */
export const SIMULATION_WINDOW_DAYS = 30;

/** The most candidates a single simulation run will evaluate. */
export const SIMULATION_CANDIDATE_LIMIT = 500;

export interface SimulationResult {
  ruleId: string;
  revision: number;
  windowDays: number;
  evaluated: number;
  matched: number;
  /** matched / evaluated, in [0, 1]. 0 when evaluated is 0. */
  matchRate: number;
  /** True when the candidate read hit `SIMULATION_CANDIDATE_LIMIT` — the window may hold more than was evaluated. */
  truncated: boolean;
  breakdowns: {
    sourceType: Record<string, number>;
    locationId: Record<string, number>;
    sentiment: Record<string, number>;
    riskLevel: Record<string, number>;
    /** Keyed by `String(Math.round(rating))` clamped to 1..5, or "unrated" for a null rating. */
    rating: Record<string, number>;
  };
  projectedActions: {
    type: RuleActionType;
    count: number;
    blocked: boolean;
    blockedReason: string | null;
  }[];
  sample: {
    mentionId: string;
    sourceType: MentionSourceType;
    riskLevel: RiskLevel;
    excerpt: string;
  }[];
}

/** Increment one bucket in a `Record<string, number>` count map. */
function bump(counts: Record<string, number>, key: string): void {
  counts[key] = (counts[key] ?? 0) + 1;
}

/**
 * Bucket a rating for the breakdown: the nearest whole star, clamped to the
 * 1..5 range the UI displays, or the literal `"unrated"` when the candidate
 * carries no rating at all (a source, like Reddit, that has none).
 */
function ratingBucket(rating: number | null): string {
  if (rating === null) return "unrated";
  const rounded = Math.min(5, Math.max(1, Math.round(rating)));
  return String(rounded);
}

/**
 * Simulate a rule against the last `SIMULATION_WINDOW_DAYS` of activity.
 *
 * Read-only: fetches candidates and connections, evaluates `matchesRule` over
 * them, and returns aggregate counts — it writes nothing and never calls
 * `automationRules.recordSimulation`. `now` is injected so tests (and any
 * future "simulate as of" tooling) do not depend on the wall clock.
 */
export async function simulateRule(
  deps: { dataSource: LiaDataSource; scope: OrganizationScope },
  rule: AutomationRule,
  now: Date,
): Promise<SimulationResult> {
  const { dataSource, scope } = deps;

  const publishedAfter = new Date(
    now.getTime() - SIMULATION_WINDOW_DAYS * 24 * 60 * 60 * 1000,
  ).toISOString();

  const [candidates, connections] = await Promise.all([
    dataSource.mentions.listSimulationCandidates(scope, {
      publishedAfter,
      limit: SIMULATION_CANDIDATE_LIMIT,
    }),
    dataSource.platformConnections.list(scope),
  ]);

  const truncated = candidates.length === SIMULATION_CANDIDATE_LIMIT;

  const platformByConnectionId = new Map(
    connections.map((connection) => [connection.id, connection.platform]),
  );

  const breakdowns: SimulationResult["breakdowns"] = {
    sourceType: {},
    locationId: {},
    sentiment: {},
    riskLevel: {},
    rating: {},
  };

  const sample: SimulationResult["sample"] = [];
  let matched = 0;

  for (const candidate of candidates) {
    const subject: RuleSubject = {
      mentionId: candidate.id,
      platform: platformByConnectionId.get(candidate.platformConnectionId) ?? null,
      sourceType: candidate.sourceType,
      locationId: candidate.locationId,
      rating: candidate.rating,
      status: candidate.status,
      sentiment: candidate.sentiment,
      riskLevel: candidate.riskLevel,
      relevanceScore: candidate.relevanceScore,
    };

    if (!matchesRule(subject, rule.conditions)) continue;

    matched += 1;
    bump(breakdowns.sourceType, candidate.sourceType);
    bump(breakdowns.locationId, candidate.locationId ?? "none");
    bump(breakdowns.sentiment, candidate.sentiment);
    bump(breakdowns.riskLevel, candidate.riskLevel);
    bump(breakdowns.rating, ratingBucket(candidate.rating));

    if (sample.length < 5) {
      sample.push({
        mentionId: candidate.id,
        sourceType: candidate.sourceType,
        riskLevel: candidate.riskLevel,
        excerpt: candidate.excerpt,
      });
    }
  }

  const evaluated = candidates.length;

  const projectedActions = rule.actions.map((action) => {
    const capability = ACTION_CAPABILITIES[action.type];
    return {
      type: action.type,
      count: matched,
      blocked: !capability.executable,
      blockedReason: capability.blockedReason,
    };
  });

  return {
    ruleId: rule.id,
    revision: rule.revision,
    windowDays: SIMULATION_WINDOW_DAYS,
    evaluated,
    matched,
    matchRate: evaluated === 0 ? 0 : matched / evaluated,
    truncated,
    breakdowns,
    projectedActions,
    sample,
  };
}
