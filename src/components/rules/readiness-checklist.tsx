import { AlertTriangle, CheckCircle2 } from "lucide-react";
import { Card, CardHeader } from "@/components/ui/card";
import { activationProblems } from "@/lib/rules/readiness";
import type { AutomationRule } from "@/domain";

export interface ReadinessChecklistProps {
  rule: AutomationRule;
}

/**
 * The saved, server-computed answer to "can this rule be enabled right now?"
 *
 * Unlike the builder's live preview (which never has a real simulation to
 * check against), this reads the rule exactly as it exists on the server —
 * including `simulatedRevision` — so a stale-simulation warning here is
 * always accurate.
 */
export function ReadinessChecklist({ rule }: ReadinessChecklistProps) {
  const problems = activationProblems(rule);

  return (
    <Card>
      <CardHeader title="Activation readiness" />
      <div className="mt-3">
        {problems.length === 0 ? (
          <p className="flex items-center gap-2 text-[13px] text-green-600">
            <CheckCircle2 className="size-4 shrink-0" aria-hidden />
            Ready to enable.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {problems.map((problem) => (
              <li key={problem.code} className="flex items-start gap-2 text-[13px] text-amber-600">
                <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
                <span>{problem.message}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </Card>
  );
}
