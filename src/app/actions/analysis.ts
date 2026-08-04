"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { AnalysisCounts } from "@/domain";
import { authorize } from "@/lib/actions/guard";
import { runAction, type ActionResult } from "@/lib/actions/result";
import {
  analyzeMentions,
  type AnalyzeMentionsResult,
} from "@/lib/analysis/analyze";

/**
 * Analysis server actions.
 *
 * Thin, like the integration actions: authorise, call the service, revalidate.
 * All the ordering that matters — lock, batch, classify, escalate, persist,
 * audit — lives in `analyzeMentions`, so a future scheduled job gets identical
 * behaviour rather than a second implementation of the same sequence.
 */

const analyzeSchema = z.object({
  /**
   * Optional override for the batch size.
   *
   * Bounded here as well as in the environment, because this value arrives
   * from a browser: an unbounded limit would let a client turn one click into
   * an unbounded number of model calls.
   */
  limit: z.number().int().min(1).max(500).optional(),
});

export interface AnalysisOutcome {
  analysisRunId: string;
  status: string;
  counts: AnalysisCounts;
  /** What to tell the user. Never claims analysis that did not happen. */
  message: string;
  /** True when the outcome needs the amber treatment rather than the green. */
  degraded: boolean;
}

export async function analyzeMentionsAction(
  input: unknown = {},
): Promise<ActionResult<AnalysisOutcome>> {
  return runAction("mention.analyze", async () => {
    const { limit } = analyzeSchema.parse(input ?? {});
    const context = await authorize("mention.analyze");

    const result = await analyzeMentions(
      context,
      limit === undefined ? {} : { limit },
    );

    // Analysis writes risk, sentiment, and relevance onto mentions, and may
    // raise escalations — so every screen that reads those changes, not just
    // the inbox the button lives on.
    for (const path of [
      "/mentions",
      "/overview",
      "/insights",
      "/escalations",
      "/reviews",
    ]) {
      revalidatePath(path);
    }

    return {
      analysisRunId: result.analysisRunId,
      status: result.status,
      counts: result.counts,
      message: describeAnalysisOutcome(result),
      degraded: result.status !== "completed",
    };
  });
}

/**
 * One sentence about what the run did.
 *
 * Written here rather than in the component so the screen and any future
 * caller describe the same run identically — and phrased around counts rather
 * than status words, because "partial" means nothing to somebody who just
 * wanted their inbox triaged.
 */
function describeAnalysisOutcome(result: AnalyzeMentionsResult): string {
  if (result.status === "failed") {
    return (
      result.errorMessage ??
      "Lia could not analyze the mention backlog. Try again shortly."
    );
  }

  const { analyzed, heuristic, escalated, failed, remaining } = result.counts;
  const total = analyzed + heuristic;

  if (total === 0 && failed === 0) {
    return "Everything is already analyzed. Nothing new to look at.";
  }

  const parts: string[] = [`Analyzed ${total}`];
  // Named rather than folded into the total: an escalation is the one outcome
  // that puts work on somebody's desk today.
  if (escalated > 0) {
    parts.push(`${escalated} escalated`);
  }
  if (remaining > 0) parts.push(`${remaining} still waiting`);

  const summary = `${parts.join(", ")}.`;

  if (failed > 0) {
    return `${summary} ${failed} could not be analyzed — the rest were saved.`;
  }

  return summary;
}
