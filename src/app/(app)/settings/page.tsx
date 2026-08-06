import type { Metadata } from "next";
import { Save } from "lucide-react";
import { PageBody } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { DetailField } from "@/components/ui/detail-panel";
import { PageHeader } from "@/components/ui/page-header";
import { SectionPlaceholder } from "@/components/ui/section-placeholder";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { ProfilePanel } from "@/components/settings/profile-panel";
import { TeamPanel } from "@/components/settings/team-panel";
import { can } from "@/lib/auth/permissions";
import { MEMBERSHIP_ROLE_LABELS } from "@/lib/labels";
import { getDataSource } from "@/lib/data";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";

export const metadata: Metadata = { title: "Settings" };

export default async function SettingsPage() {
  const context = await getOrganizationContext();
  const dataSource = await getDataSource();
  const canManage = can(context.role, "organization.manage_members");

  // Invitations are readable by any member but only listed for people who can
  // act on them, so a viewer is not shown a roster of addresses they have no
  // reason to see.
  const [members, invitations] = await Promise.all([
    dataSource.memberships.listMembers(context.scope),
    canManage
      ? dataSource.invitations.listPending(context.scope)
      : Promise.resolve([]),
  ]);

  const { organization } = context;

  // The caller's own profile row, for the editable name card. Taken from the
  // member list already loaded above rather than a second query — the acting
  // user is always a member here, or the page could not have resolved a scope.
  const self = members.find(
    (member) => member.userId === context.scope.userId,
  )?.user;

  return (
    <PageBody>
      <PageHeader
        title="Settings"
        description="Organization details, defaults, monitoring, and account administration."
        actions={
          <Button variant="primary" icon={Save}>
            Save changes
          </Button>
        }
      >
        <SegmentedTabs
          label="Settings section"
          tabs={[
            { id: "organization", label: "Organization" },
            { id: "team", label: "Team", count: members.length },
            { id: "security", label: "Security" },
            { id: "billing", label: "Billing" },
            { id: "notifications", label: "Notifications" },
          ]}
        />
      </PageHeader>

      <div className="grid gap-4 xl:grid-cols-12">
        <div className="flex flex-col gap-4 xl:col-span-7">
          <Card>
            <CardHeader
              title="Organization details"
              description="Used as the default for every location."
            />
            <dl className="mt-4 grid gap-4 sm:grid-cols-2">
              <DetailField label="Name">{organization.name}</DetailField>
              <DetailField label="Slug">{organization.slug}</DetailField>
              <DetailField label="Industry">{organization.industry}</DetailField>
              <DetailField label="Website">
                {organization.websiteUrl ?? "—"}
              </DetailField>
              <DetailField label="Default timezone">
                {organization.defaultTimezone}
              </DetailField>
              <DetailField label="Default language">
                {organization.defaultLanguage}
              </DetailField>
            </dl>
          </Card>

          <TeamPanel
            members={members}
            invitations={invitations}
            actingUserId={context.scope.userId}
            actingRole={context.role}
            canManage={canManage}
          />

          <SectionPlaceholder
            title="Monitoring aliases"
            description="Names, misspellings, and handles Lia should treat as this brand."
            shape="rows"
          />
        </div>

        <div className="flex flex-col gap-4 xl:col-span-5">
          {self ? (
            <ProfilePanel
              firstName={self.firstName}
              lastName={self.lastName}
              email={self.email}
            />
          ) : null}

          <Card>
            <CardHeader
              title="Your access"
              description="What your role allows in this organization."
            />
            <dl className="mt-4 grid gap-4">
              <DetailField label="Role">
                {MEMBERSHIP_ROLE_LABELS[context.role]}
              </DetailField>
              <DetailField label="Organizations">
                {context.available.length}
              </DetailField>
            </dl>
          </Card>

          <SectionPlaceholder
            title="Global defaults"
            description="Default voice profile, response targets, and escalation owner."
            shape="lines"
          />
          <SectionPlaceholder
            title="Data and privacy"
            description="Retention windows, export, and deletion requests."
            shape="lines"
          />
          <SectionPlaceholder
            title="Security, billing, and notifications"
            description="Single sign-on, plan and invoices, and alert routing."
            shape="rows"
          />
        </div>
      </div>
    </PageBody>
  );
}
