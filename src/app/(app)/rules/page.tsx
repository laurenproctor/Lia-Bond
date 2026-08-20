import type { Metadata } from "next";
import { Plus, Workflow } from "lucide-react";
import { PageBody } from "@/components/shell/app-shell";
import { RuleStatusTabs } from "@/components/rules/rule-status-tabs";
import { RuleToggle } from "@/components/rules/rule-toggle";
import { Button, ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { RulePlatformBadges } from "@/components/rules/rule-platform-badges";
import { RuleTemplatesPanel } from "@/components/rules/rule-templates-panel";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { AutomationRuleStatusBadge } from "@/components/ui/status-badge";
import { formatRelativeShort } from "@/lib/format";
import { AUTOMATION_RULE_STATUS_LABELS } from "@/lib/labels";
import { can } from "@/lib/auth/permissions";
import { getDataSource } from "@/lib/data";
import { parseRuleStatusParam } from "@/lib/rules/search-params";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";
import type { AutomationRule, AutomationRuleStatus } from "@/domain";

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
      // Its own column rather than a third line under the rule name: the
      // question this answers — "which of my rules touch Google?" — is asked
      // down the table, not across one row, and stacking it into the name cell
      // makes it unscannable.
      //
      // Short labels here and full ones on the detail page. A rule scoped to
      // three platforms would otherwise set this column's width for every row.
      id: "platforms",
      header: "Platforms",
      cell: (rule) => <RulePlatformBadges conditions={rule.conditions} short />,
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
      id: "conditionsActions",
      header: "Conditions · actions",
      secondary: true,
      cell: (rule) => {
        const conditionCount = rule.conditions.length;
        const actionCount = rule.actions.length;
        return (
          <span className="tabular-nums">
            {conditionCount} {conditionCount === 1 ? "condition" : "conditions"} ·{" "}
            {actionCount} {actionCount === 1 ? "action" : "actions"}
          </span>
        );
      },
    },
    {
      id: "lastApplied",
      header: "Last applied",
      align: "right",
      secondary: true,
      cell: (rule) =>
        rule.lastAppliedAt ? (
          <span className="text-gray-500">{formatRelativeShort(rule.lastAppliedAt)}</span>
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

interface RulesPageProps {
  searchParams: Promise<{ status?: string }>;
}

export default async function RulesPage({ searchParams }: RulesPageProps) {
  const { status: statusParam } = await searchParams;
  const context = await getOrganizationContext();
  const dataSource = await getDataSource();
  const rules = await dataSource.automationRules.list(context.scope);

  const status = parseRuleStatusParam(statusParam);
  const canToggle = can(context.role, "automation_rule.toggle");
  const canManage = can(context.role, "automation_rule.manage");

  const countOf = (ruleStatus: AutomationRuleStatus) =>
    rules.filter((rule) => rule.status === ruleStatus).length;
  const counts = {
    all: rules.length,
    active: countOf("active"),
    inactive: countOf("inactive"),
    draft: countOf("draft"),
  };

  const visibleRules = status === "all" ? rules : rules.filter((rule) => rule.status === status);

  /**
   * Whether this organization has *no rules at all*, as distinct from having
   * none on the tab currently selected.
   *
   * The two were previously the same branch, so filtering to Draft with no
   * drafts told somebody with ten active rules "No rules yet". They are
   * separated here because they now lead somewhere different: a genuinely empty
   * workspace gets the templates alongside it, and a filtered-empty view must
   * not — those rules exist, they are one tab away, and offering to create more
   * answers a question nobody asked.
   */
  const neverHadRules = rules.length === 0;

  return (
    <PageBody>
      <PageHeader
        title="Rules and automation"
        description="Decide what Lia handles on its own, what needs approval, and what always escalates."
        actions={
          canManage ? (
            <ButtonLink href="/rules/new" variant="primary" icon={Plus}>
              New rule
            </ButtonLink>
          ) : (
            <div className="flex items-center gap-3">
              <Button variant="primary" icon={Plus} disabled>
                New rule
              </Button>
              <span className="text-[12px] text-gray-500">
                Your role can view rules but not change them.
              </span>
            </div>
          )
        }
      >
        {/*
          Four tabs all reading zero are a filter for nothing. Hidden until
          there is something to filter.
        */}
        {neverHadRules ? null : (
          <RuleStatusTabs activeStatus={status} counts={counts} />
        )}
      </PageHeader>

      <p className="rounded-lg border border-purple-600/20 bg-purple-50 px-3 py-2 text-[13px] text-gray-950">
        Rules are recorded, simulated, and audited. Lia does not yet apply rules to
        incoming mentions — enabling a rule prepares it for when automation
        execution launches.
      </p>

      {neverHadRules ? (
        // The 7/5 split the builder already uses for the same pairing, so
        // "templates sit beside the thing they fill" reads the same on both
        // screens. Collapses to one column below xl, which is why the copy
        // below never says "on the right".
        <div className="grid gap-4 xl:grid-cols-12">
          <div className="xl:col-span-7">
            <Card className="h-full">
              <EmptyState
                className="h-full"
                icon={Workflow}
                title="No rules yet"
                description={
                  canManage
                    ? "Start from one of the templates, or build a rule from scratch. Every rule saves as a draft you can simulate before enabling it."
                    : "Nobody has set up a rule for this organization yet."
                }
                action={
                  canManage ? (
                    <ButtonLink href="/rules/new" variant="primary" icon={Plus}>
                      Build from scratch
                    </ButtonLink>
                  ) : undefined
                }
              />
            </Card>
          </div>
          <div className="xl:col-span-5">
            <RuleTemplatesPanel canManage={canManage} />
          </div>
        </div>
      ) : (
        <Card flush>
          <CardHeader
            className="p-5 pb-3"
            title="Rules"
            description="Lower priority numbers run first."
          />
          <DataTable
            caption="Automation rules"
            columns={buildColumns(canToggle)}
            rows={visibleRules}
            rowKey={(rule) => rule.id}
            rowHref={(rule) => `/rules/${rule.id}`}
            rowLabel={(rule) => rule.name}
            // Reached only when a *filter* is empty — the no-rules-at-all case
            // never renders this table. Naming the status is the difference
            // between "you have nothing" and "you have nothing here".
            emptyTitle={
              status === "all"
                ? "No rules to show"
                : `No ${AUTOMATION_RULE_STATUS_LABELS[status].toLowerCase()} rules`
            }
            emptyDescription={
              status === "all"
                ? undefined
                : `You have ${counts.all} ${counts.all === 1 ? "rule" : "rules"} under other statuses.`
            }
          />
        </Card>
      )}
    </PageBody>
  );
}
