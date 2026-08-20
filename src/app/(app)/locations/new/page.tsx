import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageBody } from "@/components/shell/app-shell";
import { CreateLocationForm } from "@/components/locations/create-location-form";
import type { LocationMemberOption } from "@/components/locations/location-fields";
import { ButtonLink } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { can, explainDenial } from "@/lib/auth/permissions";
import { getDataSource } from "@/lib/data";
import { MEMBERSHIP_ROLE_LABELS } from "@/lib/labels";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";

export const metadata: Metadata = { title: "Add location" };

/**
 * Add a location by hand.
 *
 * A role without `location.create` gets the explanation and a way back — and
 * **no form at all**, not eleven disabled inputs. Disabling the fields would
 * communicate the same refusal at ten times the visual cost, and a form that
 * cannot be submitted reads as broken rather than as forbidden. The form
 * component is not mounted, so there is nothing to tab into either.
 */
export default async function NewLocationPage() {
  const context = await getOrganizationContext();

  if (!can(context.role, "location.create")) {
    return (
      <PageBody>
        <PageHeader title="Add location">
          <BackLink />
        </PageHeader>

        <Card>
          <CardHeader
            title="You cannot add locations"
            description={explainDenial("location.create", context.role)}
          />
          <p className="mt-3 text-[13px] text-gray-600">
            Owners and admins add and edit locations. Your role is{" "}
            {MEMBERSHIP_ROLE_LABELS[context.role].toLowerCase()}. A communications
            lead can still bring a location into existence by mapping a Google
            listing to it, on the integration setup screen.
          </p>
          <div className="mt-4 flex gap-2">
            <ButtonLink href="/locations" variant="secondary">
              Back to locations
            </ButtonLink>
            <ButtonLink href="/integrations/google-business-profile/setup" variant="ghost">
              Google setup
            </ButtonLink>
          </div>
        </Card>
      </PageBody>
    );
  }

  const dataSource = await getDataSource();
  const members = await dataSource.memberships.listMembers(context.scope);

  const options: LocationMemberOption[] = members.map((member) => ({
    userId: member.userId,
    fullName: member.user.fullName,
    isActive: member.status === "active",
  }));

  return (
    <PageBody>
      <PageHeader
        title="Add location"
        description="A restaurant you run. Connect its profiles afterwards, from the integration screens."
      >
        <BackLink />
      </PageHeader>

      <Card className="max-w-3xl">
        <CreateLocationForm
          members={options}
          defaultTimezone={context.organization.defaultTimezone}
        />
      </Card>
    </PageBody>
  );
}

function BackLink() {
  return (
    <Link
      href="/locations"
      className="inline-flex items-center gap-1.5 text-[13px] font-medium text-gray-500 transition-colors hover:text-gray-950"
    >
      <ArrowLeft className="size-4" aria-hidden />
      Locations
    </Link>
  );
}
