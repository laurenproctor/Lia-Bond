import type { Metadata } from "next";
import { PageBody } from "@/components/shell/app-shell";
import { RuleBuilder } from "@/components/rules/rule-builder";
import { RuleTemplatesPanel } from "@/components/rules/rule-templates-panel";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/auth/permissions";
import { getDataSource } from "@/lib/data";
import { resolveRuleTemplate } from "@/lib/rules/templates";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";

export const metadata: Metadata = { title: "New rule" };

interface NewRulePageProps {
  searchParams: Promise<{ template?: string }>;
}

/**
 * Start a new automation rule, optionally seeded from a template.
 *
 * An unknown or absent `?template=` id is not an error — it just falls back
 * to an empty builder, since the id is a bookmarkable, user-editable URL
 * parameter rather than something the app itself always controls.
 *
 * Non-managers are not redirected: they land on the same route with an
 * explanation instead, matching the read-only treatment the rules list gives
 * them for the same permission gap.
 */
export default async function NewRulePage({ searchParams }: NewRulePageProps) {
  const { template: templateId } = await searchParams;
  const context = await getOrganizationContext();

  if (!can(context.role, "automation_rule.manage")) {
    return (
      <PageBody>
        <PageHeader
          title="New rule"
          description="Saved as a draft until you simulate and enable it."
        />
        <Card>
          <EmptyState title="Your role can view rules but not create them." />
        </Card>
      </PageBody>
    );
  }

  const dataSource = await getDataSource();
  const locations = await dataSource.locations.list(context.scope);
  const locationOptions = locations.map((location) => ({ id: location.id, name: location.name }));

  const template = resolveRuleTemplate(templateId);

  return (
    <PageBody>
      <PageHeader title="New rule" description="Saved as a draft until you simulate and enable it." />

      <div className="grid items-start gap-4 xl:grid-cols-12">
        <div className="xl:col-span-7">
          {/*
            "Use template" navigates from /rules/new to /rules/new?template=id
            — the same route, so React would keep the builder mounted and its
            state initialiser (which reads `initialConfig`) would never re-run,
            leaving the form stubbornly empty. Keying on the resolved template
            forces a remount so the new config is actually seeded in, and
            returning to the blank URL clears it again.
          */}
          <RuleBuilder
            key={template?.id ?? "blank"}
            mode="create"
            locations={locationOptions}
            editable
            initialConfig={template?.config}
            templateName={template?.name ?? null}
          />
        </div>
        <div className="xl:col-span-5">
          <RuleTemplatesPanel appliedTemplateId={template?.id ?? null} />
        </div>
      </div>
    </PageBody>
  );
}
