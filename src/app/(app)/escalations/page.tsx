import type { Metadata } from "next";
import Link from "next/link";
import { Plus } from "lucide-react";
import { PageBody } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { EscalationDetailPane } from "@/components/escalations/escalation-detail-pane";
import { FilterBar } from "@/components/ui/filter-bar";
import { PageHeader } from "@/components/ui/page-header";
import { SearchInput } from "@/components/ui/search-input";
import { SelectFilter } from "@/components/ui/select-filter";
import { EscalationStatusBadge, RiskBadge } from "@/components/ui/status-badge";
import { formatSlaRemaining } from "@/lib/format";
import { ESCALATION_CATEGORY_LABELS } from "@/lib/labels";
import { getDataSource } from "@/lib/data";
import { resolveSelection } from "@/lib/selection";
import { getOrganizationScope } from "@/lib/tenancy/organization-context";
import { escalationTimelineEntries } from "@/lib/view-models/escalation";
import { workspacePathFor } from "@/lib/view-models/mention";
import { ESCALATION_CATEGORIES, type Escalation, type Mention } from "@/domain";

export const metadata: Metadata = { title: "Escalations" };

interface EscalationRow {
  escalation: Escalation;
  mention: Mention | undefined;
  assigneeName: string | null;
}

const COLUMNS: DataTableColumn<EscalationRow>[] = [
  {
    id: "title",
    header: "Case",
    cell: (row) =>
      row.mention ? (
        <Link
          href={workspacePathFor(row.mention)}
          className="relative font-medium text-gray-950 hover:text-purple-600 hover:underline"
        >
          {row.escalation.title}
        </Link>
      ) : (
        <span className="font-medium text-gray-950">{row.escalation.title}</span>
      ),
  },
  {
    id: "category",
    header: "Category",
    cell: (row) => ESCALATION_CATEGORY_LABELS[row.escalation.category],
  },
  {
    id: "severity",
    header: "Severity",
    cell: (row) => <RiskBadge risk={row.escalation.severity} short />,
  },
  {
    id: "status",
    header: "Status",
    cell: (row) => <EscalationStatusBadge status={row.escalation.status} />,
  },
  {
    id: "assignee",
    header: "Owner",
    secondary: true,
    cell: (row) => row.assigneeName ?? <span className="text-gray-400">Unassigned</span>,
  },
  {
    id: "sla",
    header: "SLA",
    align: "right",
    cell: (row) => {
      if (!row.escalation.dueAt) return <span className="text-gray-400">—</span>;
      const { label, overdue } = formatSlaRemaining(row.escalation.dueAt);
      return (
        <span className={overdue ? "font-semibold text-red-600" : "text-gray-700"}>
          {label}
        </span>
      );
    },
  },
];

interface EscalationsPageProps {
  searchParams: Promise<{ selected?: string }>;
}

export default async function EscalationsPage({ searchParams }: EscalationsPageProps) {
  const { selected: selectedParam } = await searchParams;
  const scope = await getOrganizationScope();
  const dataSource = await getDataSource();

  const [escalations, mentions, members] = await Promise.all([
    dataSource.escalations.list(scope),
    dataSource.mentions.list(scope),
    dataSource.memberships.listMembers(scope),
  ]);

  const mentionsById = new Map(mentions.map((mention) => [mention.id, mention]));
  const namesById = new Map(members.map((member) => [member.userId, member.user.fullName]));

  const rows: EscalationRow[] = escalations.map((escalation) => ({
    escalation,
    mention: mentionsById.get(escalation.mentionId),
    assigneeName: escalation.assignedUserId
      ? (namesById.get(escalation.assignedUserId) ?? null)
      : null,
  }));

  const selectedRow = resolveSelection(
    rows,
    selectedParam,
    (row) => row.escalation.id,
  );

  const auditEvents = selectedRow
    ? await dataSource.auditEvents.list(scope, {
        entityType: "escalation",
        entityId: selectedRow.escalation.id,
      })
    : [];

  const open = escalations.filter(
    (escalation) => escalation.status !== "resolved" && escalation.status !== "dismissed",
  );

  return (
    <PageBody>
      <PageHeader
        title="Escalations"
        description="Sensitive issues that need an owner, a decision, and a record."
        actions={
          <Button variant="primary" icon={Plus}>
            New escalation
          </Button>
        }
      >
        <FilterBar>
          <SearchInput
            label="Search escalations"
            placeholder="Search by title or summary…"
            className="w-full max-w-64"
          />
          <SelectFilter
            label="Severity"
            options={[
              { value: "all", label: "All severities" },
              { value: "critical", label: "Critical" },
              { value: "high", label: "High" },
              { value: "medium", label: "Medium" },
              { value: "low", label: "Low" },
            ]}
          />
          <SelectFilter
            label="Category"
            options={[
              { value: "all", label: "All categories" },
              ...ESCALATION_CATEGORIES.map((category) => ({
                value: category,
                label: ESCALATION_CATEGORY_LABELS[category],
              })),
            ]}
          />
          <SelectFilter
            label="Status"
            options={[
              { value: "open", label: "Open cases" },
              { value: "all", label: "All cases" },
              { value: "resolved", label: "Resolved" },
            ]}
          />
        </FilterBar>
      </PageHeader>

      <Card flush>
        <CardHeader
          className="p-5 pb-3"
          title="Escalation queue"
          description={`${open.length} open of ${escalations.length} total, worst severity first.`}
        />
        <DataTable
          caption="Escalations by severity and due date"
          columns={COLUMNS}
          rows={rows}
          rowKey={(row) => row.escalation.id}
          rowHref={(row) => `/escalations?selected=${row.escalation.id}`}
          rowLabel={(row) => row.escalation.title}
          selectedKey={selectedRow?.escalation.id ?? null}
          emptyTitle="No escalations"
          emptyDescription="Nothing has been escalated. High-risk mentions arrive here automatically."
        />
      </Card>

      {selectedRow ? (
        <EscalationDetailPane
          escalation={selectedRow.escalation}
          mention={selectedRow.mention}
          ownerName={selectedRow.assigneeName}
          timelineEntries={escalationTimelineEntries(auditEvents, namesById)}
        />
      ) : null}
    </PageBody>
  );
}
