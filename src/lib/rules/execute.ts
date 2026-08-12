/**
 * The rules execution sweep (spec §7–§9).
 *
 * One call is one pass of the automation engine over the mentions an analysis
 * run just produced. The transactional work — validate, apply, record, roll
 * back — belongs to `automationRuleExecutions.executeUnit`; this module is the
 * loop around it, and its job is narrower and entirely about honesty:
 *
 * - claim before working, so two schedulers never sweep one organization twice;
 * - stop at the configured caps, and *say* what was left undone rather than
 *   returning counters that quietly describe a shorter sweep than was asked for;
 * - keep dry run a projection. A dry-run sweep writes its `automation_sweeps`
 *   row and its `mode='dry_run'` execution rows and nothing else — no mention
 *   writes, no escalations, no rule timestamps, no audit events (spec §8).
 *
 * Pure by import: it reaches `@/domain` and `@/lib/rules/*` plus the repository
 * *types*, never a concrete adapter. The data source is always injected.
 */

import {
  ruleActionSchema,
  zeroSweepCounters,
  type AutomationExecutionMode,
  type AutomationRule,
  type DryRunExecutionStatus,
  type ExecutionActionOutcome,
  type MentionStatus,
  type RiskLevel,
  type SweepCounters,
} from "@/domain";
import { DataError } from "@/lib/data/errors";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import { rulesExecutionLimits, type RulesExecutionLimits } from "@/lib/env";
import { ACTION_CAPABILITIES } from "@/lib/rules/capabilities";
import { matchesRule, type RuleSubject } from "@/lib/rules/evaluate";
import { decideEscalate, decideSetStatus } from "@/lib/rules/transitions";

export interface ExecuteRulesInput {
  mode: AutomationExecutionMode;
  processed: { mentionId: string; analysisId: string }[];
}

export interface ExecuteRulesResult {
  /** null when the claim was refused, or when there was no work to claim for. */
  sweepId: string | null;
  claimed: boolean;
  counters: SweepCounters;
  /** Mentions the caller handed over that this sweep never reached. */
  mentionsSkipped: number;
  budgetExhausted: boolean;
}

/**
 * Limits and clock, both injectable.
 *
 * Defaulted from `rulesExecutionLimits()` and `Date.now` so production reads
 * its configuration and tests can drive a cap or exhaust a budget without
 * touching the environment or the wall clock.
 */
export interface ExecuteRulesOptions {
  limits?: RulesExecutionLimits;
  now?: () => number;
}

function idleResult(): ExecuteRulesResult {
  return {
    sweepId: null,
    claimed: false,
    counters: zeroSweepCounters(),
    mentionsSkipped: 0,
    budgetExhausted: false,
  };
}

function failureCode(error: unknown): string {
  return error instanceof DataError ? error.code : "unexpected_error";
}

/**
 * The dry-run twin of the demo adapter's `deriveApplyStatus`.
 *
 * Same shape, different vocabulary: a projection that mixes a would-apply with
 * a refusal is `would_partial`, exactly as the apply path calls that case
 * `partial`. Keeping the two derivations parallel is what makes a dry run a
 * usable preview of the apply that follows it.
 */
function deriveProjectedStatus(
  outcomes: readonly ExecutionActionOutcome[],
): DryRunExecutionStatus {
  const applied = outcomes.filter((row) => row.outcome === "would_apply").length;
  const failed = outcomes.filter(
    (row) => row.outcome === "would_fail_validation",
  ).length;
  const blocked = outcomes.filter((row) => row.outcome === "would_block").length;

  if (applied > 0 && failed + blocked > 0) return "would_partial";
  if (applied > 0) return "would_apply";
  if (failed > 0) return "would_fail_validation";
  if (blocked > 0) return "would_block";
  return "would_no_op";
}

interface Projection {
  status: DryRunExecutionStatus;
  outcomes: ExecutionActionOutcome[];
}

/**
 * What a dry run believes the mention has become, part-way through its turn.
 *
 * This is the piece apply mode gets for free: `executeUnit` re-reads the stored
 * mention, so the second rule to touch a mention sees the first rule's effect.
 * A dry run has no store to re-read — nothing is written — so the same
 * continuity has to be carried between rules by hand, or two rules with the
 * same `set_status` target both project `would_apply` where apply would give
 * `applied` then `no_op`, and the preview stops matching the run.
 */
interface ProjectedMention {
  status: MentionStatus;
  /**
   * Any escalation on the mention, open or closed — the same question
   * `escalationFor` asks in the adapter, not an open-only one. Automation
   * refuses to raise a second case for a mention that has ever had one.
   */
  escalationExists: boolean;
}

/**
 * The matrix's verdict in dry-run vocabulary.
 *
 * Spelled out rather than derived from the decision's name: `blocked` projects
 * as `would_block`, not `would_blocked`, and a template would have quietly
 * invented a status no check constraint accepts.
 */
function projectedOutcome(
  kind: "apply" | "no_op" | "blocked",
): "would_apply" | "would_no_op" | "would_block" {
  if (kind === "apply") return "would_apply";
  if (kind === "no_op") return "would_no_op";
  return "would_block";
}

/**
 * What this rule *would* do to this mention, decided by the same matrix the
 * apply path uses, against the mention as this sweep has projected it so far.
 *
 * `workingStatus` mirrors the unit's private view *within* the rule — a rule
 * that escalates and then dismisses projects the sequence the transaction would
 * produce rather than two independent guesses — and the returned `state`
 * carries that view on to the next rule, which is what makes a whole mention's
 * preview match the run.
 */
function projectUnit(
  rule: AutomationRule,
  riskLevel: RiskLevel,
  state: ProjectedMention,
): { projection: Projection; state: ProjectedMention } {
  // Validation precedes projection, as it precedes mutation in apply mode
  // (spec §7): a malformed action list is `would_fail_validation`, never a
  // preview of an effect that could never have been attempted. Nothing was
  // projected, so the mention's projected state is handed on untouched.
  const parsed = ruleActionSchema.array().safeParse(rule.actions);
  if (!parsed.success) {
    return { projection: { status: "would_fail_validation", outcomes: [] }, state };
  }

  const outcomes: ExecutionActionOutcome[] = [];
  let workingStatus = state.status;
  let escalationExists = state.escalationExists;

  parsed.data.forEach((action, index) => {
    if (!ACTION_CAPABILITIES[action.type].executable) {
      outcomes.push({
        index,
        type: action.type,
        outcome: "would_block",
        code: "action_not_executable",
      });
      return;
    }

    if (action.type === "set_status") {
      const decision = decideSetStatus(workingStatus, action.status, riskLevel);
      if (decision.kind === "apply") workingStatus = action.status;
      outcomes.push({
        index,
        type: action.type,
        outcome: projectedOutcome(decision.kind),
        code: decision.kind === "blocked" ? decision.code : null,
      });
      return;
    }

    // escalate: eligibility, then dedupe, then the status change — the order
    // spec §7 fixes, so an ineligible mention is never projected as escalated
    // on the strength of an escalation that already exists.
    const decision = decideEscalate(workingStatus);
    if (decision.kind !== "apply") {
      outcomes.push({
        index,
        type: action.type,
        outcome: projectedOutcome(decision.kind),
        code: decision.kind === "blocked" ? decision.code : null,
      });
      return;
    }

    if (escalationExists) {
      outcomes.push({
        index,
        type: action.type,
        outcome: "would_no_op",
        code: "escalation_exists",
      });
      return;
    }

    escalationExists = true;
    workingStatus = "escalated";
    outcomes.push({ index, type: action.type, outcome: "would_apply", code: null });
  });

  return {
    projection: { status: deriveProjectedStatus(outcomes), outcomes },
    state: { status: workingStatus, escalationExists },
  };
}

/**
 * Fold one unit's action outcomes into the sweep counters.
 *
 * `no_op`/`would_no_op` has no counter of its own in `SweepCounters` — an
 * action that found the world already as it wanted it is normal operation, not
 * something to alarm on — so it is deliberately counted nowhere rather than
 * being folded into a bucket it does not belong in.
 */
function countOutcomes(
  counters: SweepCounters,
  outcomes: readonly ExecutionActionOutcome[],
): void {
  for (const outcome of outcomes) {
    if (outcome.outcome === "applied" || outcome.outcome === "would_apply") {
      counters.actionsApplied += 1;
    } else if (outcome.outcome === "blocked" || outcome.outcome === "would_block") {
      counters.actionsBlocked += 1;
    } else if (
      outcome.outcome === "failed" ||
      outcome.outcome === "would_fail_validation"
    ) {
      counters.actionsFailed += 1;
    }
  }
}

export async function executeRules(
  context: { dataSource: LiaDataSource; scope: OrganizationScope },
  input: ExecuteRulesInput,
  options: ExecuteRulesOptions = {},
): Promise<ExecuteRulesResult> {
  const { dataSource, scope } = context;
  const limits = options.limits ?? rulesExecutionLimits();
  const now = options.now ?? Date.now;

  if (input.processed.length === 0) return idleResult();

  // The rules are read before the claim on purpose: an organization with no
  // active rule should not leave a sweep row behind saying it swept nothing.
  const active = await dataSource.automationRules.listActiveForExecution(scope);
  if (active.length === 0) return idleResult();

  const { sweep, claimed } = await dataSource.automationSweeps.claim(scope, {
    mode: input.mode,
  });
  if (!claimed) return idleResult();

  // The snapshot. Every mention in this sweep is judged against this list at
  // this revision; `executeUnit` re-validates the revision and fails the unit
  // terminally (`rule_changed`) if an edit landed underneath us.
  const rules = active.slice(0, limits.maxRulesPerMention);

  /**
   * Whether any rule in the snapshot could raise an escalation. Dry run needs
   * the mention's escalation state to project the dedupe, and this is what
   * keeps that read off every other sweep.
   */
  const anyRuleEscalates =
    input.mode === "dry_run" &&
    rules.some((rule) => rule.actions.some((action) => action.type === "escalate"));

  const counters = zeroSweepCounters();
  const matchedRuleIds = new Set<string>();
  /** Actions dispatched to a unit, including the no-ops no counter records. */
  let actionsScheduled = 0;
  let budgetExhausted = false;
  let actionCapReached = false;
  let cursor = 0;

  const startedAtMs = now();

  try {
    // `Mention` carries a connection id, not a platform, so the `platform`
    // condition needs the connection map — read once for the sweep rather than
    // once per mention.
    const connections = await dataSource.platformConnections.list(scope);
    const platformByConnectionId = new Map(
      connections.map((connection) => [connection.id, connection.platform]),
    );

    while (cursor < input.processed.length) {
      if (cursor >= limits.maxMentionsPerSweep) break;
      if (now() - startedAtMs >= limits.budgetMs) {
        budgetExhausted = true;
        break;
      }

      const pair = input.processed[cursor]!;
      // Counted as taken before the work starts: a mention whose turn is cut
      // short by the action cap was reached, and calling it "skipped" would
      // overstate what is left to do.
      cursor += 1;

      try {
        const mention = await dataSource.mentions.get(scope, pair.mentionId);
        if (!mention) {
          // The analysis run promised this row and it is gone. Terminal:
          // no retry can bring it back.
          counters.terminalFailures += 1;
          continue;
        }

        const subject: RuleSubject = {
          mentionId: mention.id,
          platform: platformByConnectionId.get(mention.platformConnectionId) ?? null,
          sourceType: mention.sourceType,
          locationId: mention.locationId,
          rating: mention.rating,
          status: mention.status,
          sentiment: mention.sentiment,
          riskLevel: mention.riskLevel,
          relevanceScore: mention.relevanceScore,
        };
        counters.mentionsEvaluated += 1;

        // The dry run's running view of this mention, carried from rule to
        // rule. Apply mode has no equivalent because it does not need one:
        // `executeUnit` re-reads the stored mention, so the next rule already
        // sees the last one's effect.
        //
        // The seed is read with no status filter: a mention that has ever been
        // escalated is not escalated again here, resolved or not.
        //
        // Since the escalation contract landed, apply mode is narrower than
        // that — it refuses on an open case or on a replay of this unit's own
        // occurrence, so a *closed* case raised by a *different* occurrence no
        // longer blocks a re-triaged mention from being escalated again. This
        // projection is therefore conservative in exactly one shape: it can
        // preview `would_no_op` where apply would raise a second case. It is
        // deliberately left conservative rather than half-narrowed here — the
        // projector needs the contract's own answer, which arrives with the
        // service rewiring, and a preview that under-promises is the safer of
        // the two errors while it does.
        let projected: ProjectedMention = {
          status: mention.status,
          escalationExists: anyRuleEscalates
            ? (await dataSource.escalations.list(scope, { mentionId: mention.id }))
                .length > 0
            : false,
        };

        for (const rule of rules) {
          if (!matchesRule(subject, rule.conditions)) continue;

          if (actionsScheduled + rule.actions.length > limits.maxActionsPerSweep) {
            counters.actionsSkipped += rule.actions.length;
            actionCapReached = true;
            break;
          }
          actionsScheduled += rule.actions.length;
          counters.rulesMatched += 1;
          matchedRuleIds.add(rule.id);

          const unit = {
            sweepId: sweep.id,
            automationRuleId: rule.id,
            ruleRevision: rule.revision,
            mentionId: mention.id,
            triggerAnalysisId: pair.analysisId,
            actions: rule.actions,
          };

          if (input.mode === "dry_run") {
            const next = projectUnit(rule, mention.riskLevel, projected);
            // The projection drives the next rule's preview; the *recorded*
            // row drives the counters. They differ only when `recordProjection`
            // replayed an earlier row for this analysis occurrence, and in that
            // case the freshly computed one is the current preview while the
            // stored one belongs to the sweep that first recorded it.
            projected = next.state;

            const recorded = await dataSource.automationRuleExecutions.recordProjection(
              scope,
              { ...unit, status: next.projection.status, outcomes: next.projection.outcomes },
            );
            // Same gate as the apply path below, for the same reason: a replay
            // returns the row an earlier sweep recorded, and folding its
            // outcomes in here would inflate this sweep's counters with work it
            // did not do. Dry run has to be countable against apply, so the two
            // modes cannot disagree about which sweep owns a replayed row.
            if (recorded.sweepId !== sweep.id) continue;

            countOutcomes(counters, recorded.outcomes);
            // A projected validation failure is the preview of a terminal
            // apply-mode failure, and counted the same way so the two modes'
            // sweep rows can be read against each other.
            if (recorded.status === "would_fail_validation") {
              counters.terminalFailures += 1;
            }
            continue;
          }

          const row = await dataSource.automationRuleExecutions.executeUnit(scope, unit);

          // A unit belongs to the sweep that opened it. `executeUnit` keeps the
          // first sweep's id on the row through every replay and retry — the
          // adapter is explicit that rewriting it would erase where the unit
          // began — so a row bearing another sweep's id is not this sweep's
          // work, and folding its outcomes in here would inflate the counters
          // of every sweep a re-delivered analysis batch touches.
          //
          // Known consequence, and the reason this is a sweep-id test rather
          // than a timestamp one: when a *retry* completes a unit an earlier
          // sweep opened, the outcome is attributed to that earlier sweep too.
          // The two cases are not distinguishable from the returned row alone
          // (a successful retry is terminal, exactly like a replay), and clock
          // comparison does not separate them either — sweeps claim inside the
          // same millisecond. Counting by sweep id at least agrees with what
          // the execution row itself says about where the unit lives.
          const ranHere = row.sweepId === sweep.id;

          if (ranHere) {
            countOutcomes(counters, row.outcomes);
            if (row.status === "failed") {
              if (row.errorClass === "retryable") counters.retryableFailures += 1;
              else counters.terminalFailures += 1;
            }
          }

          // Rule activity is an apply-mode fact only (spec §9); a dry run that
          // stamped it would make a preview look like a run. Evaluated and
          // matched are true of a replay — the rule was considered and it did
          // match — but applied is not: nothing was applied this sweep, and
          // "last applied" must keep pointing at the sweep that applied it.
          await dataSource.automationRules.markActivity(scope, rule.id, {
            at: sweep.startedAt,
            matched: true,
            applied: ranHere && (row.status === "applied" || row.status === "partial"),
          });
        }
      } catch {
        // The unit carries its own failure handling, so anything caught here
        // came from building the subject around it. One bad mention must not
        // end the sweep for the rest.
        counters.terminalFailures += 1;
      }

      if (actionCapReached) break;
    }

    // Rules that were considered and matched nothing were still evaluated, and
    // the rules screen saying so is the point. Stamped once per rule, after the
    // loop, and only when something was actually evaluated against them.
    if (input.mode === "apply" && counters.mentionsEvaluated > 0) {
      for (const rule of rules) {
        if (matchedRuleIds.has(rule.id)) continue;
        await dataSource.automationRules.markActivity(scope, rule.id, {
          at: sweep.startedAt,
          matched: false,
          applied: false,
        });
      }
    }
  } catch (error) {
    // The loop itself died — not one mention, the sweep. Close the row with a
    // reason before rethrowing, so the claim is released and the failure is
    // legible without log access.
    await dataSource.automationSweeps.finalize(scope, sweep.id, {
      status: "failed",
      counters,
      errorCode: failureCode(error),
    });
    throw error;
  }

  await dataSource.automationSweeps.finalize(scope, sweep.id, {
    status: "completed",
    counters,
  });

  return {
    sweepId: sweep.id,
    claimed: true,
    counters,
    mentionsSkipped: input.processed.length - cursor,
    budgetExhausted,
  };
}
