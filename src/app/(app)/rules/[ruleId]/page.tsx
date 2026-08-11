import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { PageBody } from "@/components/shell/app-shell";
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
import { formatRelativeShort, humanize } from "@/lib/format";
import { AUDIT_EVENT_LABELS } from "@/lib/labels";
import { ruleSentence } from "@/lib/rules/sentence";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";

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

  const [locations, auditEvents, members] = await Promise.all([
    dataSource.locations.list(context.scope),
    dataSource.auditEvents.list(context.scope, {
      entityType: "automation_rule",
      entityId: ruleId,
      limit: 20,
    }),
    dataSource.memberships.listMembers(context.scope),
  ]);

  const locationOptions = locations.map((location) => ({ id: location.id, name: location.name }));
  const locationNames = new Map(locationOptions.map((location) => [location.id, location.name]));
  const namesByUserId = new Map(members.map((member) => [member.userId, member.user.fullName]));

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
      />

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
