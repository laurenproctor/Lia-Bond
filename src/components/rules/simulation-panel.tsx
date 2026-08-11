"use client";

import { useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { PlayCircle } from "lucide-react";
import { simulateAutomationRuleAction } from "@/app/actions/automation";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { RiskBadge } from "@/components/ui/status-badge";
import { formatRelativeShort } from "@/lib/format";
import { RISK_LEVEL_SHORT_LABELS, SENTIMENT_LABELS, SOURCE_TYPE_LABELS } from "@/lib/labels";
import { ACTION_CAPABILITIES } from "@/lib/rules/capabilities";
import type { SimulationResult } from "@/lib/rules/simulate";
import type { AutomationRule, MentionSourceType, RiskLevel } from "@/domain";

export interface SimulationPanelProps {
  rule: AutomationRule;
  /** True when the caller's role can run a simulation. */
  canManage: boolean;
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-gray-200 px-2.5 py-2">
      <p className="text-[11px] font-medium text-gray-500">{label}</p>
      <p className="mt-0.5 text-[18px] font-semibold tabular-nums text-gray-950">{value}</p>
    </div>
  );
}

function BreakdownList({
  title,
  counts,
  labels,
}: {
  title: string;
  counts: Record<string, number>;
  labels: Record<string, string>;
}) {
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (entries.length === 0) return null;

  return (
    <div>
      <p className="text-[12px] font-medium text-gray-700">{title}</p>
      <ul className="mt-1 flex flex-wrap gap-1.5">
        {entries.map(([key, count]) => (
          <li
            key={key}
            className="rounded-md bg-gray-100 px-1.5 py-0.5 text-[11.5px] text-gray-700"
          >
            {labels[key] ?? key} · {count}
          </li>
        ))}
      </ul>
    </div>
  );
}

function SimulationResultView({ result }: { result: SimulationResult }): ReactNode {
  return (
    <div className="mt-4 flex flex-col gap-4">
      <div className="grid grid-cols-3 gap-3">
        <Stat label="Evaluated" value={result.evaluated.toLocaleString()} />
        <Stat label="Matched" value={result.matched.toLocaleString()} />
        <Stat label="Match rate" value={`${(result.matchRate * 100).toFixed(1)}%`} />
      </div>

      {result.truncated ? (
        <p className="text-[12px] text-gray-500">Evaluated the most recent 500 mentions.</p>
      ) : null}

      {/* Breakdowns cover source type, sentiment, and risk only. The
          simulator also buckets by location and rating, but those are keyed
          by raw ids (location) or a rounded-star bucket (rating) that would
          need extra props to render meaningfully — left out of this first
          pass rather than showing an id or a half-explained bucket. */}
      <div className="flex flex-col gap-3">
        <BreakdownList
          title="Source"
          counts={result.breakdowns.sourceType}
          labels={SOURCE_TYPE_LABELS as Record<string, string>}
        />
        <BreakdownList
          title="Sentiment"
          counts={result.breakdowns.sentiment}
          labels={SENTIMENT_LABELS as Record<string, string>}
        />
        <BreakdownList
          title="Risk"
          counts={result.breakdowns.riskLevel}
          labels={RISK_LEVEL_SHORT_LABELS as Record<string, string>}
        />
      </div>

      <div>
        <p className="text-[12px] font-medium text-gray-700">Projected actions</p>
        <ul className="mt-1.5 flex flex-col gap-1.5">
          {result.projectedActions.map((action) => (
            <li key={action.type} className="text-[13px]">
              <span className={action.blocked ? "text-amber-600" : "text-gray-950"}>
                {ACTION_CAPABILITIES[action.type].label} — {action.count}{" "}
                {action.count === 1 ? "mention" : "mentions"}
              </span>
              {action.blocked && action.blockedReason ? (
                <span className="block text-[12px] text-amber-600">{action.blockedReason}</span>
              ) : null}
            </li>
          ))}
        </ul>
      </div>

      {result.sample.length > 0 ? (
        <div>
          <p className="text-[12px] font-medium text-gray-700">Sample matches</p>
          <ul className="mt-1.5 flex flex-col gap-2">
            {result.sample.map((row) => (
              <li key={row.mentionId} className="rounded-lg border border-gray-200 p-2.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12px] text-gray-500">
                    {SOURCE_TYPE_LABELS[row.sourceType as MentionSourceType]}
                  </span>
                  <RiskBadge risk={row.riskLevel as RiskLevel} short />
                </div>
                <p className="mt-1 text-[12.5px] text-gray-700">{row.excerpt}</p>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="text-[12px] text-gray-500">
        This is a preview. No drafts, escalations, or notifications were created.
      </p>
    </div>
  );
}

/**
 * Replay a rule against the last 30 days of real activity, with zero side
 * effects. The freshly-run result renders in place; `router.refresh()` on
 * success re-renders the server-side readiness checklist too, so a rule
 * that just became ready shows that immediately without a manual reload.
 */
export function SimulationPanel({ rule, canManage }: SimulationPanelProps) {
  const router = useRouter();
  const [result, setResult] = useState<SimulationResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  function runSimulation() {
    setError(null);
    startTransition(async () => {
      const response = await simulateAutomationRuleAction({ automationRuleId: rule.id });
      if (!response.ok) {
        setError(response.error);
        return;
      }
      setResult(response.data);
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader
        title="Simulation"
        description="Replay this rule against real recent activity without changing anything."
        actions={
          canManage ? (
            <Button
              variant="secondary"
              size="sm"
              icon={PlayCircle}
              onClick={runSimulation}
              disabled={pending}
            >
              {pending ? "Simulating…" : "Simulate against the last 30 days"}
            </Button>
          ) : undefined
        }
      />

      {error ? (
        <p role="alert" className="mt-3 text-[13px] text-red-600">
          {error}
        </p>
      ) : null}

      {result ? (
        <SimulationResultView result={result} />
      ) : rule.lastSimulatedAt ? (
        <p className="mt-3 text-[12.5px] text-gray-500">
          Last simulated {formatRelativeShort(rule.lastSimulatedAt)} ago.
        </p>
      ) : (
        <p className="mt-3 text-[12.5px] text-gray-500">This rule has never been simulated.</p>
      )}
    </Card>
  );
}
