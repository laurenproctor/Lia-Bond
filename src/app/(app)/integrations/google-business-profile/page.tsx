import type { Metadata } from "next";
import Link from "next/link";
import { AlertTriangle, ArrowLeft, MapPin } from "lucide-react";
import { PageBody } from "@/components/shell/app-shell";
import { CapabilityTable } from "@/components/integrations/capability-table";
import { ConnectGoogleForm } from "@/components/integrations/connect-google-form";
import { ConnectionActions } from "@/components/integrations/connection-actions";
import { ConnectionSummary } from "@/components/integrations/connection-summary";
import {
  LocationSyncList,
  type ConnectedLocationRow,
} from "@/components/integrations/location-sync-list";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { PlatformGlyph } from "@/components/ui/source-badge";
import { ConnectionStatusBadge } from "@/components/ui/status-badge";
import { CONNECTION_HEALTH_LABELS } from "@/lib/labels";
import { can } from "@/lib/auth/permissions";
import { getDataSource } from "@/lib/data";
import { isGoogleConnectorAvailable } from "@/integrations/registry";
import {
  connectionWarnings,
  googleCapabilities,
} from "@/lib/integrations/capabilities";
import { listConnectedLocationStatus } from "@/lib/integrations/google-reviews";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";

export const metadata: Metadata = { title: "Google Business Profile" };

/**
 * The Google connection, in full.
 *
 * Reads real repository data throughout — there is no fixture behind any number
 * on this page. The capability table is the part that matters most: OAuth
 * succeeding proves authentication and discovery work and nothing else, and the
 * table says so in as many words rather than letting a green badge imply that
 * reviews are being monitored.
 */
export default async function GoogleIntegrationPage() {
  const [context, dataSource] = await Promise.all([
    getOrganizationContext(),
    getDataSource(),
  ]);
  const { scope, role, organization } = context;

  const connection = await dataSource.platformConnections.getByPlatform(
    scope,
    "google_business_profile",
  );

  const [profiles, members, locationStatus] = await Promise.all([
    connection
      ? dataSource.platformProfiles.listForConnection(scope, connection.id)
      : Promise.resolve([]),
    dataSource.memberships.listMembers(scope),
    connection
      ? listConnectedLocationStatus({ dataSource, scope }, connection.id)
      : Promise.resolve([]),
  ]);

  const activeProfiles = profiles.filter((profile) => profile.status !== "disconnected");
  const mappedProfiles = activeProfiles.filter((profile) => profile.locationId !== null);
  const unmappedProfiles = activeProfiles.filter((profile) => profile.locationId === null);

  const syncRows: ConnectedLocationRow[] = locationStatus.map((entry) => ({
    platformProfileId: entry.profile.id,
    externalProfileName: entry.profile.externalProfileName,
    locationName: entry.locationName,
    importedReviewCount: entry.importedReviewCount,
    lastSuccessfulSyncAt: entry.sync.lastSuccessful?.completedAt ?? null,
    lastStatus: entry.sync.latest?.status ?? null,
    lastErrorMessage: entry.sync.latest?.errorMessage ?? null,
    syncing: entry.syncing,
  }));

  const importedReviewCount = syncRows.reduce(
    (total, row) => total + row.importedReviewCount,
    0,
  );

  const connectedBy = connection?.connectedByUserId
    ? (members.find((member) => member.userId === connection.connectedByUserId)?.user
        .fullName ?? null)
    : null;

  const warnings = connectionWarnings(connection);
  const capabilities = googleCapabilities(connection);
  const connectorAvailable = isGoogleConnectorAvailable();

  const mayConnect = can(role, "integration.connect");
  const mayReauthorize = can(role, "integration.reauthorize");
  const mayManageProfiles = can(role, "integration.manage_profiles");

  const live = connection !== null && connection.status !== "disconnected";

  return (
    <PageBody>
      <PageHeader
        title="Google Business Profile"
        description={
          connection?.externalAccountName
            ? `Connected to ${connection.externalAccountName} for ${organization.name}.`
            : `Not connected for ${organization.name}.`
        }
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <Link
              href="/integrations"
              className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 text-[13px] font-medium whitespace-nowrap text-gray-700 transition-colors hover:bg-gray-50 hover:text-gray-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-600"
            >
              <ArrowLeft className="size-4 shrink-0" aria-hidden />
              Back to integrations
            </Link>

            {live && mayManageProfiles ? (
              <Link
                href="/integrations/google-business-profile/setup"
                className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 text-[13px] font-medium whitespace-nowrap text-gray-700 transition-colors hover:bg-gray-50 hover:text-gray-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-600"
              >
                <MapPin className="size-4 shrink-0" aria-hidden />
                Manage locations
              </Link>
            ) : null}

            {connectorAvailable && live && mayReauthorize ? (
              <ConnectGoogleForm reauthorize redirectPath="/integrations/google-business-profile" />
            ) : null}

            {connectorAvailable && !live && mayConnect ? <ConnectGoogleForm /> : null}
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <PlatformGlyph platform="google_business_profile" size="md" />
          <ConnectionStatusBadge status={connection?.status ?? "disconnected"} />
          {connection?.lastHealthStatus ? (
            <Badge
              tone={connection.lastHealthStatus === "healthy" ? "green" : "amber"}
            >
              {CONNECTION_HEALTH_LABELS[connection.lastHealthStatus]}
            </Badge>
          ) : null}
        </div>
      </PageHeader>

      {!connectorAvailable ? (
        <p className="rounded-lg border border-gray-200 bg-white px-3 py-2.5 text-[13px] text-gray-700">
          Google Business Profile is not configured on this server. Your
          administrator needs to set the Google OAuth client and the credential
          encryption key before this integration can be connected.
        </p>
      ) : null}

      {warnings.map((warning) => (
        <p
          key={warning}
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-amber-600/20 bg-amber-100 px-3 py-2.5 text-[13px] text-gray-950"
        >
          <AlertTriangle className="mt-px size-4 shrink-0 text-amber-600" aria-hidden />
          {warning}
        </p>
      ))}

      {connection === null ? (
        <Card>
          <EmptyState
            title="Google is not connected"
            description="Connect a Google account that administers your Business Profile listings. Lia will read which accounts and locations it manages, then import reviews for the locations you map. It never posts a reply."
            action={
              connectorAvailable && mayConnect ? <ConnectGoogleForm /> : undefined
            }
          />
        </Card>
      ) : (
        <div className="grid gap-4 xl:grid-cols-3">
          <ConnectionSummary
            connection={connection}
            organizationName={organization.name}
            connectedByName={connectedBy}
            mappedProfileCount={mappedProfiles.length}
            unmappedProfileCount={unmappedProfiles.length}
            importedReviewCount={importedReviewCount}
            actions={
              live ? (
                <ConnectionActions
                  connectionId={connection.id}
                  mappedProfileCount={mappedProfiles.length}
                  importedReviewCount={importedReviewCount}
                  canTest={can(role, "integration.test_connection")}
                  canDisconnect={can(role, "integration.disconnect")}
                />
              ) : undefined
            }
          />

          <Card>
            <CardHeader
              title="What this integration does"
              description="Stated per capability, so a working connection is never mistaken for continuous monitoring."
            />
            <div className="mt-3">
              <CapabilityTable capabilities={capabilities} />
            </div>
          </Card>

          {live ? (
            <Card className="xl:col-span-3">
              <CardHeader
                title="Connected locations"
                description="Reviews are imported when a sync is run. Google is not watched continuously, so a location is only as current as its last sync."
              />
              <div className="mt-3">
                <LocationSyncList
                  locations={syncRows}
                  canSync={can(role, "integration.sync_reviews")}
                  // A connection that needs re-consent cannot import anything,
                  // so the buttons are disabled rather than offering an action
                  // that is guaranteed to fail with the same message the
                  // banner above already gave.
                  needsReauthorization={connection.status === "action_required"}
                />
              </div>
            </Card>
          ) : null}
        </div>
      )}
    </PageBody>
  );
}
