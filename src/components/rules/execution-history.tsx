import Link from "next/link";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EmptyState } from "@/components/ui/empty-state";
import { formatRelativeShort } from "@/lib/format";
import type { RulesExecutionMode } from "@/lib/env";
import {
  describeRowOutcomes,
  EXECUTION_MODE_LABELS,
  executionHistoryFraming,
  executionStatusLabel,
  NO_EXECUTIONS_MESSAGE,
  RULES_EXECUTION_OFF_MESSAGE,
} from "@/lib/rules/execution-history";
import type { AutomationRuleExecution } from "@/domain";

/**
 * One execution row, already joined to the mention it ran against.
 *
 * `mentionHref`/`mentionLabel` arrive pre-resolved from the page: this
 * component is presentational and does no data fetching of its own — the
 * page owns the lookup because it needs the mention's source type to build
 * the right workspace route (`workspacePathFor`), and a component with no
 * `async` has no way to do that itself.
 */
export interface ExecutionHistoryRow {
  execution: AutomationRuleExecution;
  mentionHref: string;
  mentionLabel: string;
}

export interface ExecutionHistoryProps {
  rows: ExecutionHistoryRow[];
  mode: RulesExecutionMode;
}

const MODE_TONES: Record<AutomationRuleExecution["mode"], BadgeTone> = {
  dry_run: "blue",
  apply: "purple",
};

const STATUS_TONES: Record<AutomationRuleExecution["status"], BadgeTone> = {
  applied: "green",
  partial: "amber",
  blocked: "red",
  failed: "red",
  no_op: "neutral",
  would_apply: "green",
  would_partial: "amber",
  would_block: "red",
  would_no_op: "neutral",
  would_fail_validation: "red",
};

const COLUMNS: DataTableColumn<ExecutionHistoryRow>[] = [
  {
    id: "mention",
    header: "Mention",
    cell: ({ mentionHref, mentionLabel }) => (
      <Link
        href={mentionHref}
        className="line-clamp-2 font-medium text-gray-950 hover:text-purple-600 hover:underline"
      >
        {mentionLabel}
      </Link>
    ),
  },
  {
    id: "mode",
    header: "Mode",
    cell: ({ execution }) => (
      <Badge tone={MODE_TONES[execution.mode]}>{EXECUTION_MODE_LABELS[execution.mode]}</Badge>
    ),
  },
  {
    id: "status",
    header: "Status",
    cell: ({ execution }) => (
      <Badge tone={STATUS_TONES[execution.status]}>{executionStatusLabel(execution.status)}</Badge>
    ),
  },
  {
    id: "outcomes",
    header: "Actions",
    cell: ({ execution }) => (
      <ul className="flex flex-col gap-0.5">
        {describeRowOutcomes(execution).map((line) => (
          <li key={line.key} className="text-[12.5px] text-gray-600">
            {line.text}
          </li>
        ))}
      </ul>
    ),
  },
  {
    id: "when",
    header: "When",
    align: "right",
    cell: ({ execution }) => (
      <span className="text-gray-500">{formatRelativeShort(execution.startedAt)}</span>
    ),
  },
];

/**
 * What actually happened when this rule ran, or a mode-aware statement of why
 * there is nothing to show yet.
 *
 * Three states, and they are mutually exclusive by design: `off` always wins
 * (rows from before execution was disabled are not shown as if they still
 * mean something), then an active mode with no rows, then the table. A dry
 * run's rows read "Projection" rather than a real action's mode word, and
 * their own outcome text never says "applied" either — see
 * `execution-history.ts`'s `describeActionOutcome` — because a preview must
 * never be mistaken for something that actually happened.
 */
export function ExecutionHistory({ rows, mode }: ExecutionHistoryProps) {
  const framing = executionHistoryFraming(mode);

  return (
    <Card flush>
      <CardHeader
        className="p-5 pb-3"
        title="Execution history"
        description={framing ?? undefined}
      />
      {mode === "off" ? (
        <EmptyState size="sm" title={RULES_EXECUTION_OFF_MESSAGE} />
      ) : rows.length === 0 ? (
        <EmptyState size="sm" title={NO_EXECUTIONS_MESSAGE} />
      ) : (
        <DataTable
          caption="Rule execution history"
          columns={COLUMNS}
          rows={rows}
          rowKey={({ execution }) => execution.id}
        />
      )}
    </Card>
  );
}
