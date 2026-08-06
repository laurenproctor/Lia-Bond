import { ExternalLink } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { formatPercent, formatRelativeShort } from "@/lib/format";
import {
  GATE_REJECTION_REASON_LABELS,
  SYNC_RUN_STATUS_LABELS,
  SYNC_TRIGGER_LABELS,
} from "@/lib/labels";
import type { NewsPollRun, NewsRejectedCandidate } from "@/domain";

/**
 * What actually happened the last few times Lia polled.
 *
 * "Why did you miss this story" is the first question anyone asks of a
 * monitoring product, and the rejected-candidates table is the honest answer:
 * every article the gate saw and refused, with the reason and the score,
 * rather than a poll count that only shows what got through.
 *
 * A server component throughout — `runs` and `rejections` arrive assembled by
 * the page, already joined to the query name, so this file queries nothing.
 */

const RUN_STATUS_TONES: Record<NewsPollRun["status"], BadgeTone> = {
  running: "blue",
  completed: "green",
  partial: "amber",
  failed: "red",
};

export interface PollRunListItem {
  run: NewsPollRun;
  queryName: string;
}

export interface RejectedCandidateListItem {
  candidate: NewsRejectedCandidate;
  queryName: string;
}

export interface PollRunHistoryProps {
  runs: PollRunListItem[];
  rejections: RejectedCandidateListItem[];
  remainingScheduledRequests: number;
}

const RUN_COLUMNS: DataTableColumn<PollRunListItem>[] = [
  {
    id: "query",
    header: "Query",
    cell: ({ queryName }) => <span className="font-medium text-gray-950">{queryName}</span>,
  },
  {
    id: "trigger",
    header: "Trigger",
    secondary: true,
    cell: ({ run }) => SYNC_TRIGGER_LABELS[run.trigger],
  },
  {
    id: "status",
    header: "Status",
    cell: ({ run }) => (
      <Badge tone={RUN_STATUS_TONES[run.status]}>{SYNC_RUN_STATUS_LABELS[run.status]}</Badge>
    ),
  },
  {
    id: "found",
    header: "Found",
    align: "right",
    cell: ({ run }) => (
      <span className="tabular-nums">
        {run.acceptedCount} accepted · {run.rejectedCount} rejected
      </span>
    ),
  },
  {
    id: "requests",
    header: "Requests spent",
    align: "right",
    secondary: true,
    cell: ({ run }) => <span className="tabular-nums">{run.requestsSpent}</span>,
  },
  {
    id: "when",
    header: "Started",
    align: "right",
    cell: ({ run }) => (
      <span className="text-gray-500">{formatRelativeShort(run.startedAt)}</span>
    ),
  },
];

const REJECTION_COLUMNS: DataTableColumn<RejectedCandidateListItem>[] = [
  {
    id: "title",
    header: "Article",
    cell: ({ candidate }) => (
      <a
        href={candidate.url}
        target="_blank"
        rel="noopener noreferrer"
        className="inline-flex items-start gap-1 font-medium text-gray-950 hover:text-purple-600 hover:underline"
      >
        <span className="line-clamp-2">{candidate.title}</span>
        <ExternalLink className="mt-0.5 size-3 shrink-0" aria-hidden />
      </a>
    ),
  },
  {
    id: "query",
    header: "Query",
    secondary: true,
    cell: ({ queryName }) => queryName,
  },
  {
    id: "publisher",
    header: "Publisher",
    secondary: true,
    cell: ({ candidate }) => candidate.publisherDomain,
  },
  {
    id: "reason",
    header: "Why it was refused",
    cell: ({ candidate }) => (
      <Badge tone="neutral">{GATE_REJECTION_REASON_LABELS[candidate.reason]}</Badge>
    ),
  },
  {
    id: "score",
    header: "Score",
    align: "right",
    secondary: true,
    cell: ({ candidate }) => (
      <span className="tabular-nums">{formatPercent(candidate.score * 100)}</span>
    ),
  },
  {
    id: "when",
    header: "Published",
    align: "right",
    cell: ({ candidate }) => (
      <span className="text-gray-500">{formatRelativeShort(candidate.publishedAt)}</span>
    ),
  },
];

export function PollRunHistory({
  runs,
  rejections,
  remainingScheduledRequests,
}: PollRunHistoryProps) {
  return (
    <div className="flex flex-col gap-4">
      <Card flush>
        <CardHeader
          className="p-5 pb-3"
          title="Recent polls"
          description="The last few times each query ran, whether by schedule or by hand."
          actions={
            <span className="text-[12.5px] text-gray-500 tabular-nums">
              {remainingScheduledRequests} scheduled requests left today
            </span>
          }
        />
        <DataTable
          caption="Recent poll runs"
          columns={RUN_COLUMNS}
          rows={runs}
          rowKey={({ run }) => run.id}
          emptyTitle="No polls yet"
          emptyDescription="A query's history appears here once it has been polled, on its schedule or by hand."
        />
      </Card>

      <Card flush>
        <CardHeader
          className="p-5 pb-3"
          title="Recently rejected candidates"
          description="Articles the relevance gate saw and refused, with its reason. Kept for 30 days so the gate can be checked, not just trusted."
        />
        <DataTable
          caption="Recently rejected candidates"
          columns={REJECTION_COLUMNS}
          rows={rejections}
          rowKey={({ candidate }) => candidate.id}
          emptyTitle="Nothing rejected yet"
          emptyDescription="Candidates the gate refuses appear here, so a missed story can be explained rather than just noticed."
        />
      </Card>
    </div>
  );
}
