import type { Metadata } from "next";
import { Plus } from "lucide-react";
import { PageBody } from "@/components/shell/app-shell";
import { RuleToggle } from "@/components/rules/rule-toggle";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { PageHeader } from "@/components/ui/page-header";
import { SectionPlaceholder } from "@/components/ui/section-placeholder";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { AutomationRuleStatusBadge } from "@/components/ui/status-badge";
import { formatRelativeShort } from "@/lib/format";
import { can } from "@/lib/auth/permissions";
import { getDataSource } from "@/lib/data";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";
import type { AutomationRule } from "@/domain";

export const metadata: Metadata = { title: "Rules and automation" };

function buildColumns(canToggle: boolean): DataTableColumn<AutomationRule>[] {
  return [
    {
      id: "name",
      header: "Rule",
      cell: (rule) => (
        <span>
          <span className="block font-medium text-gray-950">{rule.name}</span>
          {rule.description ? (
            <span className="block max-w-md text-[12px] text-gray-500">
              {rule.description}
            </span>
          ) : null}
        </span>
      ),
    },
    {
      id: "status",
      header: "Status",
      cell: (rule) => <AutomationRuleStatusBadge status={rule.status} />,
    },
    {
      id: "priority",
      header: "Priority",
      align: "right",
      secondary: true,
      cell: (rule) => <span className="tabular-nums">{rule.priority}</span>,
    },
    {
      id: "conditions",
      header: "Conditions",
      align: "right",
      secondary: true,
      cell: (rule) => (
        <span className="tabular-nums">
          {rule.conditions.length} / {rule.actions.length} actions
        </span>
      ),
    },
    {
      id: "lastRun",
      header: "Last run",
      align: "right",
      secondary: true,
      cell: (rule) =>
        rule.lastRunAt ? (
          <span className="text-gray-500">{formatRelativeShort(rule.lastRunAt)}</span>
        ) : (
          <span className="text-gray-400">Never</span>
        ),
    },
    {
      id: "toggle",
      header: "Enabled",
      align: "right",
      cell: (rule) => <RuleToggle rule={rule} disabled={!canToggle} />,
    },
  ];
}

export default async function RulesPage() {
  const context = await getOrganizationContext();
  const dataSource = await getDataSource();
  const rules = await dataSource.automationRules.list(context.scope);

  const canToggle = can(context.role, "automation_rule.toggle");
  const countOf = (status: AutomationRule["status"]) =>
    rules.filter((rule) => rule.status === status).length;

  return (
    <PageBody>
      <PageHeader
        title="Rules and automation"
        description="Decide what Lia handles on its own, what needs approval, and what always escalates."
        actions={
          <Button variant="primary" icon={Plus}>
            New rule
          </Button>
        }
      >
        <SegmentedTabs
          label="Rules view"
          tabs={[
            { id: "all", label: "All rules", count: rules.length },
            { id: "active", label: "Active", count: countOf("active") },
            { id: "inactive", label: "Inactive", count: countOf("inactive") },
            { id: "draft", label: "Draft", count: countOf("draft") },
          ]}
        />
      </PageHeader>

      <p className="rounded-lg border border-purple-600/20 bg-purple-50 px-3 py-2 text-[13px] text-gray-950">
        Automation is reversible and auditable. Enabling or disabling a rule is
        recorded in the audit trail with the actor and the time.
      </p>

      <Card flush>
        <CardHeader
          className="p-5 pb-3"
          title="Rules"
          description="Lower priority numbers run first."
        />
        <DataTable
          caption="Automation rules"
          columns={buildColumns(canToggle)}
          rows={rules}
          rowKey={(rule) => rule.id}
          emptyTitle="No rules yet"
          emptyDescription="Create a rule to route, draft, or escalate automatically."
        />
      </Card>

      <div className="grid gap-4 xl:grid-cols-12">
        <SectionPlaceholder
          className="xl:col-span-7"
          title="When, and, then builder"
          description="Conditions and actions in plain language, with a live match count."
          shape="lines"
        />
        <div className="flex flex-col gap-4 xl:col-span-5">
          <SectionPlaceholder
            title="Rule templates"
            description="Starting points for common restaurant policies."
            shape="rows"
          />
          <SectionPlaceholder
            title="Simulation"
            description="Replay a rule over the last 30 days before enabling it."
            shape="chart"
          />
        </div>
      </div>
    </PageBody>
  );
}
