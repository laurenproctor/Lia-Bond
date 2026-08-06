import type { Metadata } from "next";
import Link from "next/link";
import { Download } from "lucide-react";
import { PageBody } from "@/components/shell/app-shell";
import { ResponseDetailPane } from "@/components/responses/response-detail-pane";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { FilterBar } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { SearchInput } from "@/components/ui/search-input";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { SelectFilter } from "@/components/ui/select-filter";
import { ResponseStatusBadge } from "@/components/ui/status-badge";
import { can } from "@/lib/auth/permissions";
import { formatRelativeShort } from "@/lib/format";
import { GENERATED_BY_LABELS, RESPONSE_TYPE_LABELS } from "@/lib/labels";
import { getDataSource } from "@/lib/data";
import { resolveSelection } from "@/lib/selection";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";
import { approvalTimelineEntries } from "@/lib/view-models/response";
import { excerptFrom, workspacePathFor } from "@/lib/view-models/mention";
import { resolvePublishingMode } from "@/domain";
import type { Mention, ResponseDraft } from "@/domain";

export const metadata: Metadata = { title: "Responses" };

interface ResponseRow {
  draft: ResponseDraft;
  mention: Mention | undefined;
  assigneeName: string | null;
}

const COLUMNS: DataTableColumn<ResponseRow>[] = [
  {
    id: "mention",
    header: "Mention",
    cell: (row) =>
      row.mention ? (
        <Link
          href={workspacePathFor(row.mention)}
          className="relative font-medium text-gray-950 hover:text-purple-600 hover:underline"
        >
          {row.mention.title ?? excerptFrom(row.mention.content, 60)}
        </Link>
      ) : (
        <span className="text-gray-400">Mention unavailable</span>
      ),
  },
  {
    id: "type",
    header: "Type",
    cell: (row) => RESPONSE_TYPE_LABELS[row.draft.responseType],
  },
  {
    id: "author",
    header: "Author",
    secondary: true,
    cell: (row) => GENERATED_BY_LABELS[row.draft.generatedBy],
  },
  {
    id: "assignee",
    header: "Assigned to",
    secondary: true,
    cell: (row) => row.assigneeName ?? <span className="text-gray-400">Unassigned</span>,
  },
  {
    id: "status",
    header: "Status",
    cell: (row) => <ResponseStatusBadge status={row.draft.status} />,
  },
  {
    id: "updated",
    header: "Updated",
    align: "right",
    cell: (row) => (
      <span className="text-gray-500">{formatRelativeShort(row.draft.updatedAt)}</span>
    ),
  },
];

interface ResponsesPageProps {
  searchParams: Promise<{ selected?: string }>;
}

export default async function ResponsesPage({ searchParams }: ResponsesPageProps) {
  const { selected: selectedParam } = await searchParams;
  const { scope, role } = await getOrganizationContext();
  const dataSource = await getDataSource();

  const [drafts, mentions, members] = await Promise.all([
    dataSource.responseDrafts.list(scope),
    dataSource.mentions.list(scope),
    dataSource.memberships.listMembers(scope),
  ]);

  const mentionsById = new Map(mentions.map((mention) => [mention.id, mention]));
  const namesById = new Map(members.map((member) => [member.userId, member.user.fullName]));

  const rows: ResponseRow[] = drafts.map((draft) => ({
    draft,
    mention: mentionsById.get(draft.mentionId),
    assigneeName: draft.assignedUserId
      ? (namesById.get(draft.assignedUserId) ?? null)
      : null,
  }));

  const selectedRow = resolveSelection(rows, selectedParam, (row) => row.draft.id);

  const [approvals, selectedDetail] = selectedRow
    ? await Promise.all([
        dataSource.responseDrafts.listApprovals(scope, selectedRow.draft.id),
        dataSource.mentions.getDetail(scope, selectedRow.draft.mentionId),
      ])
    : [[], null];

  const publishing = selectedDetail?.connection
    ? resolvePublishingMode(selectedDetail.connection.capabilities)
    : "unavailable";

  const countOf = (status: ResponseDraft["status"]) =>
    drafts.filter((draft) => draft.status === status).length;

  const published = countOf("published");
  const humanEdited = drafts.filter(
    (draft) => draft.finalText !== null && draft.finalText !== draft.draftText,
  ).length;

  const metrics = [
    { id: "total", label: "Responses", value: String(drafts.length), detail: "All statuses" },
    { id: "published", label: "Published", value: String(published), detail: "Live on source" },
    {
      id: "awaiting",
      label: "Awaiting approval",
      value: String(countOf("awaiting_approval")),
      detail: "Held for a decision",
    },
    {
      id: "edited",
      label: "Human-edited",
      value: String(humanEdited),
      detail: "Final text differs from the draft",
    },
  ];

  return (
    <PageBody>
      <PageHeader
        title="Responses"
        description="Every draft, approval, and published response, with the full edit trail."
        actions={<Button icon={Download}>Export</Button>}
      >
        <FilterBar>
          <SearchInput
            label="Search responses"
            placeholder="Search responses…"
            className="w-full max-w-64"
          />
          <SelectFilter
            label="Type"
            options={[
              { value: "all", label: "All types" },
              { value: "public_reply", label: "Public reply" },
              { value: "private_reply", label: "Private reply" },
              { value: "journalist_email", label: "Journalist email" },
            ]}
          />
          <SelectFilter
            label="Author"
            options={[
              { value: "all", label: "Anyone" },
              { value: "ai", label: "Written by Lia" },
              { value: "user", label: "Written by a person" },
            ]}
          />
        </FilterBar>

        <SegmentedTabs
          label="Response status"
          tabs={[
            { id: "all", label: "All", count: drafts.length },
            { id: "draft", label: "Draft", count: countOf("draft") },
            {
              id: "awaiting_approval",
              label: "Needs approval",
              count: countOf("awaiting_approval"),
            },
            { id: "approved", label: "Approved", count: countOf("approved") },
            { id: "published", label: "Published", count: published },
            { id: "failed", label: "Failed", count: countOf("failed") },
          ]}
        />
      </PageHeader>

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        {metrics.map((metric) => (
          <article key={metric.id} className="lia-card p-4">
            <h2 className="text-[13px] font-medium text-gray-700">{metric.label}</h2>
            <p className="mt-1.5 text-[26px] leading-8 font-semibold tracking-tight text-gray-950">
              {metric.value}
            </p>
            <p className="mt-0.5 text-[12px] text-gray-500">{metric.detail}</p>
          </article>
        ))}
      </div>

      <Card flush>
        <CardHeader className="p-5 pb-3" title="Response library" />
        <DataTable
          caption="Response drafts and published responses"
          columns={COLUMNS}
          rows={rows}
          rowKey={(row) => row.draft.id}
          rowHref={(row) => `/responses?selected=${row.draft.id}`}
          rowLabel={(row) =>
            row.mention
              ? (row.mention.title ?? excerptFrom(row.mention.content, 60))
              : "Response draft"
          }
          selectedKey={selectedRow?.draft.id ?? null}
          emptyTitle="No responses yet"
          emptyDescription="Drafts appear here as soon as anyone writes one."
        />
      </Card>

      {selectedRow ? (
        <ResponseDetailPane
          draft={selectedRow.draft}
          mention={selectedRow.mention}
          publishing={publishing}
          canDecide={can(role, "response.decide")}
          assigneeName={selectedRow.assigneeName}
          approvalEntries={approvalTimelineEntries(approvals, namesById)}
        />
      ) : null}
    </PageBody>
  );
}
