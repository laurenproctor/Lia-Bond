import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageBody } from "@/components/shell/app-shell";
import { ExecutionHistory, type ExecutionHistoryRow } from "@/components/rules/execution-history";
import { ReadinessChecklist } from "@/components/rules/readiness-checklist";
import { RuleBuilder } from "@/components/rules/rule-builder";
import { RuleRowActions } from "@/components/rules/rule-row-actions";
import { RuleToggle } from "@/components/rules/rule-toggle";
import { SimulationPanel } from "@/components/rules/simulation-panel";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { Timeline } from "@/components/ui/timeline";
import { can } from "@/lib/auth/permissions";
import { getDataSource } from "@/lib/data";
import { resolveRulesExecutionMode } from "@/lib/env";
import { formatRelativeShort, humanize } from "@/lib/format";
import { AUDIT_EVENT_LABELS } from "@/lib/labels";
import { RulePlatformBadges } from "@/components/rules/rule-platform-badges";
import { ruleSentence } from "@/lib/rules/sentence";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";
import { excerptFrom, workspacePathFor } from "@/lib/view-models/mention";
import type { Mention } from "@/domain";

const EXECUTION_HISTORY_LIMIT = 20;

interface RuleDetailPageProps {
  params: Promise<{ ruleId: string }>;
}

export async function generateMetadata({ params }: RuleDetailPageProps): Promise<Metadata> {
  const { ruleId } = await params;
  const context = await getOrganizationContext();
  const dataSource = await getDataSource();
  const rule = await dataSource.automationRules.get(context.scope, ruleId);
  return { title: rule?.name ?? "Rule" };
}

/**
 * A single automation rule: the builder, its saved readiness state, a
 * simulation panel, and its audit trail.
 *
 * `editable` is the one flag every read-only decision on this page follows
 * from — a manage-holder can edit a draft or inactive rule, but never an
 * active one (disable it first) or an archived one (restore it first).
 */
export default async function RuleDetailPage({ params }: RuleDetailPageProps) {
  const { ruleId } = await params;
  const context = await getOrganizationContext();
  const dataSource = await getDataSource();

  const rule = await dataSource.automationRules.get(context.scope, ruleId);
  if (!rule) notFound();

  const executionMode = resolveRulesExecutionMode();

  const [locations, auditEvents, members, executions] = await Promise.all([
    dataSource.locations.list(context.scope),
    dataSource.auditEvents.list(context.scope, {
      entityType: "automation_rule",
      entityId: ruleId,
      limit: 20,
    }),
    dataSource.memberships.listMembers(context.scope),
    dataSource.automationRuleExecutions.listForRule(context.scope, ruleId, EXECUTION_HISTORY_LIMIT),
  ]);

  const locationOptions = locations.map((location) => ({ id: location.id, name: location.name }));
  const locationNames = new Map(locationOptions.map((location) => [location.id, location.name]));
  const namesByUserId = new Map(members.map((member) => [member.userId, member.user.fullName]));

  // One `get` per distinct mention: `listForRule` returns execution rows, not
  // mentions, and `workspacePathFor` needs each mention's source type to route
  // correctly (a review, a Reddit thread, and an article each land somewhere
  // different — see `mention.ts`). Deduplicated because a rule commonly fires
  // more than once against the same mention across sweeps.
  const mentionIds = [...new Set(executions.map((execution) => execution.mentionId))];
  const mentionsById = new Map<string, Mention>(
    (await Promise.all(mentionIds.map((id) => dataSource.mentions.get(context.scope, id))))
      .filter((mention): mention is Mention => mention !== null)
      .map((mention) => [mention.id, mention]),
  );

  const executionRows: ExecutionHistoryRow[] = executions.map((execution) => {
    const mention = mentionsById.get(execution.mentionId) ?? null;
    return {
      execution,
      mentionHref: mention ? workspacePathFor(mention) : `/mentions?mention=${execution.mentionId}`,
      mentionLabel: mention
        ? (mention.title ?? excerptFrom(mention.content, 60))
        : "Mention no longer available",
    };
  });

  const canManage = can(context.role, "automation_rule.manage");
  const canToggle = can(context.role, "automation_rule.toggle");
  const archived = rule.archivedAt !== null;
  const editable = canManage && rule.status !== "active" && !archived;

  const sentence = ruleSentence(rule, { locationNames });

  return (
    <PageBody>
      <PageHeader
        title={rule.name}
        description={sentence}
        actions={
          <div className="flex items-center gap-3">
            {archived ? null : <RuleToggle rule={rule} disabled={!canToggle} />}
            <RuleRowActions rule={rule} canManage={canManage} />
          </div>
        }
      >
        {/*
          Above the activity facts, not among them: which platforms a rule
          reaches is part of what the rule *is*, alongside the sentence, rather
          than a record of what it has done.
        */}
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[12.5px] text-gray-500">Affects</span>
          <RulePlatformBadges conditions={rule.conditions} />
        </div>

        <dl className="flex flex-wrap gap-x-6 gap-y-1 text-[12.5px]">
          <div className="flex items-baseline gap-1.5">
            <dt className="text-gray-500">Last evaluated</dt>
            <dd className="font-medium text-gray-950">
              {rule.lastEvaluatedAt ? (
                formatRelativeShort(rule.lastEvaluatedAt)
              ) : (
                <span className="font-normal text-gray-400">Never</span>
              )}
            </dd>
          </div>
          <div className="flex items-baseline gap-1.5">
            <dt className="text-gray-500">Last matched</dt>
            <dd className="font-medium text-gray-950">
              {rule.lastMatchedAt ? (
                formatRelativeShort(rule.lastMatchedAt)
              ) : (
                <span className="font-normal text-gray-400">Never</span>
              )}
            </dd>
          </div>
          <div className="flex items-baseline gap-1.5">
            <dt className="text-gray-500">Last applied</dt>
            <dd className="font-medium text-gray-950">
              {rule.lastAppliedAt ? (
                formatRelativeShort(rule.lastAppliedAt)
              ) : (
                <span className="font-normal text-gray-400">Never</span>
              )}
            </dd>
          </div>
        </dl>
      </PageHeader>

      {archived ? (
        <Badge tone="amber">Archived</Badge>
      ) : rule.status === "active" ? (
        <p className="text-[12.5px] text-gray-500">Disable this rule to edit it.</p>
      ) : null}

      <div className="grid items-start gap-4 xl:grid-cols-12">
        <div className="xl:col-span-7">
          <RuleBuilder mode="edit" rule={rule} locations={locationOptions} editable={editable} />
        </div>

        <div className="flex flex-col gap-4 xl:col-span-5">
          <ReadinessChecklist rule={rule} />
          <SimulationPanel rule={rule} canManage={canManage} />
          <ExecutionHistory rows={executionRows} mode={executionMode} />

          <Card>
            <CardHeader title="History" />
            {auditEvents.length === 0 ? (
              <EmptyState
                size="sm"
                title="No history yet"
                description="Changes to this rule will appear here."
              />
            ) : (
              <Timeline
                className="mt-3"
                entries={auditEvents.map((event) => ({
                  id: event.id,
                  title: AUDIT_EVENT_LABELS[event.eventType],
                  meta: event.actorUserId
                    ? (namesByUserId.get(event.actorUserId) ?? humanize(event.actorType))
                    : humanize(event.actorType),
                  timestamp: formatRelativeShort(event.occurredAt),
                }))}
              />
            )}
          </Card>
        </div>
      </div>
    </PageBody>
  );
}
