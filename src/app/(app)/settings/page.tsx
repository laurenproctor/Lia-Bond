import type { Metadata } from "next";
import { Save } from "lucide-react";
import { PageBody } from "@/components/shell/app-shell";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { DetailField } from "@/components/ui/detail-panel";
import { PageHeader } from "@/components/ui/page-header";
import { SectionPlaceholder } from "@/components/ui/section-placeholder";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import { MEMBERSHIP_ROLE_LABELS, MEMBERSHIP_STATUS_LABELS } from "@/lib/labels";
import { getDataSource } from "@/lib/data";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";
import type { MembershipWithUser } from "@/domain";

export const metadata: Metadata = { title: "Settings" };

const MEMBER_COLUMNS: DataTableColumn<MembershipWithUser>[] = [
  {
    id: "name",
    header: "Member",
    cell: (member) => (
      <span>
        <span className="block font-medium text-gray-950">{member.user.fullName}</span>
        <span className="block text-[12px] text-gray-500">{member.user.email}</span>
      </span>
    ),
  },
  {
    id: "role",
    header: "Role",
    cell: (member) => MEMBERSHIP_ROLE_LABELS[member.role],
  },
  {
    id: "status",
    header: "Status",
    align: "right",
    cell: (member) => (
      <Badge tone={member.status === "active" ? "green" : "neutral"}>
        {MEMBERSHIP_STATUS_LABELS[member.status]}
      </Badge>
    ),
  },
];

export default async function SettingsPage() {
  const context = await getOrganizationContext();
  const dataSource = await getDataSource();
  const members = await dataSource.memberships.listMembers(context.scope);

  const { organization } = context;

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

          <Card flush>
            <CardHeader
              className="p-5 pb-3"
              title="Team"
              description="Roles decide what each person can do. Owners and admins manage membership."
            />
            <DataTable
              caption="Organization members and their roles"
              columns={MEMBER_COLUMNS}
              rows={members}
              rowKey={(member) => member.id}
              emptyTitle="No members yet"
            />
          </Card>

          <SectionPlaceholder
            title="Monitoring aliases"
            description="Names, misspellings, and handles Lia should treat as this brand."
            shape="rows"
          />
        </div>

        <div className="flex flex-col gap-4 xl:col-span-5">
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
