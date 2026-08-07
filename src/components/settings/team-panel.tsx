import { Avatar } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { DataTable, type DataTableColumn } from "@/components/ui/data-table";
import { InviteMemberForm } from "@/components/settings/invite-member-form";
import { MemberRowActions } from "@/components/settings/member-row-actions";
import { PendingInvitations } from "@/components/settings/pending-invitations";
import type {
  InvitationWithInviter,
  MembershipRole,
  MembershipWithUser,
} from "@/domain";
import { MEMBERSHIP_ROLE_LABELS, MEMBERSHIP_STATUS_LABELS } from "@/lib/labels";
import { initialsFor } from "@/lib/view-models/mention";

/**
 * The team section of settings.
 *
 * A server component that composes three client islands, rather than one large
 * client component: the roster and the invitation list are data, and only the
 * controls need to be interactive. Keeping the table on the server is also what
 * keeps `/settings` under the page-size limit in `CLAUDE.md`.
 */
export function TeamPanel({
  members,
  invitations,
  actingUserId,
  actingRole,
  canManage,
}: {
  members: MembershipWithUser[];
  invitations: InvitationWithInviter[];
  actingUserId: string;
  actingRole: MembershipRole;
  canManage: boolean;
}) {
  // Computed once and passed down, rather than re-derived per row. The answer
  // is a property of the organization, not of the member being rendered.
  const activeOwners = members.filter(
    (member) => member.role === "owner" && member.status === "active",
  );

  const columns: DataTableColumn<MembershipWithUser>[] = [
    {
      id: "name",
      header: "Member",
      cell: (member) => (
        <span className="flex items-center gap-2.5">
          <Avatar
            initials={initialsFor(member.user.fullName)}
            imageUrl={member.user.avatarUrl}
            name={member.user.fullName}
            size="sm"
          />
          <span className="min-w-0">
            <span className="block truncate font-medium text-gray-950">
              {member.user.fullName}
            </span>
            <span className="block truncate text-[12px] text-gray-500">
              {member.user.email}
            </span>
          </span>
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
      cell: (member) => (
        <Badge tone={member.status === "active" ? "green" : "neutral"}>
          {MEMBERSHIP_STATUS_LABELS[member.status]}
        </Badge>
      ),
    },
  ];

  if (canManage) {
    columns.push({
      id: "actions",
      header: "Manage",
      align: "right",
      cell: (member) => (
        <MemberRowActions
          member={member}
          actingUserId={actingUserId}
          actingRole={actingRole}
          isLastOwner={
            member.role === "owner" &&
            member.status === "active" &&
            activeOwners.length === 1
          }
        />
      ),
    });
  }

  return (
    <>
      <Card flush>
        <CardHeader
          className="p-5 pb-3"
          title="Team"
          description="Roles decide what each person can do. Owners and admins manage membership."
        />
        <DataTable
          caption="Organization members and their roles"
          columns={columns}
          rows={members}
          rowKey={(member) => member.id}
          emptyTitle="No members yet"
        />
      </Card>

      <Card flush>
        <CardHeader
          className="p-5 pb-3"
          title="Invitations"
          description={
            canManage
              ? "Invite by email, then send the person the link. Each link works once."
              : "People who have been invited but have not joined yet."
          }
        />

        {canManage ? (
          <div className="px-5 pb-4">
            <InviteMemberForm />
          </div>
        ) : null}

        <PendingInvitations invitations={invitations} canManage={canManage} />
      </Card>
    </>
  );
}
