import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { MapPin, Settings2, Star } from "lucide-react";
import type { MembershipRole } from "@/domain";
import { PageBody } from "@/components/shell/app-shell";
import { ConnectGoogleForm } from "@/components/integrations/connect-google-form";
import { ButtonLink } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { can } from "@/lib/auth/permissions";
import type { ReviewsReadinessState } from "@/lib/integrations/reviews-readiness";
import { getDataSource } from "@/lib/data";
import { isGoogleConnectorAvailable } from "@/integrations/registry";
import { reviewsReadiness } from "@/lib/integrations/reviews-readiness";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";

export const metadata: Metadata = { title: "Google reviews" };

const GOOGLE_INTEGRATION_PATH = "/integrations/google-business-profile";

/**
 * "Reviews" in the sidebar opens the review workspace on the most recent item
 * rather than an extra index screen — the queue lives inside the workspace.
 *
 * When there is no most recent item there is nothing to open, and this used to
 * raise `notFound()`. That put "we couldn't find that page" in front of anyone
 * who had not connected Google yet, which reads as a broken link rather than an
 * unfinished setup step. So the empty case now names the step that is missing
 * and offers it.
 */
export default async function ReviewsIndexPage() {
  const [context, dataSource] = await Promise.all([
    getOrganizationContext(),
    getDataSource(),
  ]);
  const { scope, role } = context;

  const [first] = await dataSource.mentions.list(scope, {
    sourceTypes: ["google_review"],
    limit: 1,
  });

  if (first) redirect(`/reviews/google/${first.id}`);

  const connection = await dataSource.platformConnections.getByPlatform(
    scope,
    "google_business_profile",
  );
  const profiles = connection
    ? await dataSource.platformProfiles.listForConnection(scope, connection.id)
    : [];

  const readiness = reviewsReadiness({
    connectorAvailable: isGoogleConnectorAvailable(),
    connection,
    profiles,
  });

  return (
    <PageBody>
      <PageHeader
        title="Google reviews"
        description="Reviews imported from your connected Business Profile locations."
      />

      <Card>
        <EmptyState
          icon={Star}
          title={readiness.title}
          description={readiness.description}
          action={<ReadinessAction state={readiness.state} role={role} />}
        />
      </Card>
    </PageBody>
  );
}

/**
 * The one thing to do next.
 *
 * Each branch is gated on the permission the action itself requires, so a
 * member who cannot connect Google is not handed a button that would only fail
 * — they get the connection page, which is readable by everyone, and can take
 * it to whoever can act.
 */
function ReadinessAction({
  state,
  role,
}: {
  state: ReviewsReadinessState;
  role: MembershipRole;
}) {
  if (state === "not_connected" && can(role, "integration.connect")) {
    return <ConnectGoogleForm label="Connect Google" size="lg" />;
  }

  if (state === "action_required" && can(role, "integration.reauthorize")) {
    return (
      <ConnectGoogleForm
        reauthorize
        redirectPath={GOOGLE_INTEGRATION_PATH}
        size="lg"
      />
    );
  }

  if (state === "no_locations" && can(role, "integration.manage_profiles")) {
    return (
      <ButtonLink href={`${GOOGLE_INTEGRATION_PATH}/setup`} size="lg" icon={MapPin}>
        Map Google locations
      </ButtonLink>
    );
  }

  if (state === "not_configured") return null;

  return (
    <ButtonLink href={GOOGLE_INTEGRATION_PATH} size="lg" icon={Settings2}>
      Open the Google connection
    </ButtonLink>
  );
}
