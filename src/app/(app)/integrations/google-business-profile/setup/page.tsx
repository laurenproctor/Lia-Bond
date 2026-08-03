import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft } from "lucide-react";
import { PageBody } from "@/components/shell/app-shell";
import { ConnectGoogleForm } from "@/components/integrations/connect-google-form";
import { LocationMappingForm } from "@/components/integrations/location-mapping-form";
import type { LiaLocationOption } from "@/components/integrations/mapping-types";
import { Card } from "@/components/ui/card";
import { EmptyState } from "@/components/ui/empty-state";
import { PageHeader } from "@/components/ui/page-header";
import { PlatformGlyph } from "@/components/ui/source-badge";
import { ConnectionStatusBadge } from "@/components/ui/status-badge";
import { can } from "@/lib/auth/permissions";
import { getDataSource } from "@/lib/data";
import { toIntegrationMessage } from "@/integrations/errors";
import type { ExternalAccount } from "@/integrations/connector";
import { isGoogleConnectorAvailable } from "@/integrations/registry";
import {
  buildCandidates,
  listGoogleBusinessAccounts,
  listGoogleBusinessLocations,
  type LocationCandidate,
} from "@/lib/integrations/google-service";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";

export const metadata: Metadata = { title: "Connect Google locations" };

/**
 * Location selection and mapping.
 *
 * Discovery runs on the server during render so the first paint already shows
 * real Google locations rather than a spinner that then fetches. Everything
 * downstream is real repository data — there are no component-local fixtures on
 * this screen.
 *
 * The route deliberately has no `/[organizationSlug]` prefix. Workflow 01 fixed
 * the organization in a verified httpOnly cookie rather than the URL (decision
 * D4), because `CLAUDE.md` fixes the route list; prefixing this one route would
 * make it the only screen in the product that disagrees.
 */
export default async function GoogleSetupPage() {
  const [context, dataSource] = await Promise.all([
    getOrganizationContext(),
    getDataSource(),
  ]);
  const { scope, role, organization } = context;
  // The service layer takes the tenant scope plus a data source, not the whole
  // request context — it is called from route handlers and actions too.
  const service = { dataSource, scope };

  const connection = await dataSource.platformConnections.getByPlatform(
    scope,
    "google_business_profile",
  );

  const mayManage = can(role, "integration.manage_profiles");
  const connectorAvailable = isGoogleConnectorAvailable();

  if (!connection || connection.status === "disconnected") {
    return (
      <SetupShell organizationName={organization.name} connection={null}>
        <Card>
          <EmptyState
            title="Google is not connected"
            description="Connect a Google account before choosing which of its locations Lia should monitor."
            action={
              connectorAvailable && can(role, "integration.connect") ? (
                <ConnectGoogleForm />
              ) : undefined
            }
          />
        </Card>
      </SetupShell>
    );
  }

  if (!mayManage) {
    return (
      <SetupShell organizationName={organization.name} connection={connection.status}>
        <Card>
          <EmptyState
            title="You can't change location mappings"
            description="Deciding which Google location is which restaurant is limited to owners, admins, and the communications lead. Ask one of them to make the change."
          />
        </Card>
      </SetupShell>
    );
  }

  // Discovery talks to Google, so it can fail for reasons the user must be told
  // about — a revoked grant, a rate limit — rather than rendering an empty list
  // that reads as "you have no locations".
  let accounts: ExternalAccount[] = [];
  let candidates: LocationCandidate[] = [];
  let discoveryError: string | null = null;
  let selectedAccountId: string | null = null;

  try {
    accounts = await listGoogleBusinessAccounts(service, connection.id);
    // Default to the account the connection was established with, so returning
    // to this screen lands where the user left off.
    selectedAccountId =
      accounts.find(
        (account) => account.externalAccountId === connection.externalAccountId,
      )?.externalAccountId ??
      accounts[0]?.externalAccountId ??
      null;

    if (selectedAccountId) {
      const [profiles, existing, locations] = await Promise.all([
        listGoogleBusinessLocations(service, connection.id, selectedAccountId),
        dataSource.platformProfiles.listForConnection(scope, connection.id),
        dataSource.locations.list(scope),
      ]);
      candidates = buildCandidates(profiles, existing, locations);
    }
  } catch (error) {
    discoveryError = toIntegrationMessage(error);
  }

  const locations = await dataSource.locations.list(scope);
  const options: LiaLocationOption[] = locations.map((location) => ({
    id: location.id,
    name: location.name,
    city: location.city,
    region: location.region,
    status: location.status,
  }));

  return (
    <SetupShell
      organizationName={organization.name}
      connection={connection.status}
      accountName={connection.externalAccountName}
    >
      {accounts.length === 0 && !discoveryError ? (
        <Card>
          <EmptyState
            title="No Google Business accounts found"
            description="The connected Google user does not administer any Business Profile accounts. Sign in with an account that manages your listings, or ask its owner to grant you access in Google."
            action={
              can(role, "integration.reauthorize") ? (
                <ConnectGoogleForm
                  reauthorize
                  label="Connect a different Google account"
                />
              ) : undefined
            }
          />
        </Card>
      ) : (
        <LocationMappingForm
          connectionId={connection.id}
          accounts={accounts}
          initialAccountId={selectedAccountId}
          initialCandidates={candidates}
          locations={options}
          // New locations inherit the organization's timezone. Google's
          // location resource does not carry one, and guessing from an address
          // would be wrong for exactly the multi-city groups Lia serves.
          organizationTimezone={organization.defaultTimezone}
          discoveryError={discoveryError}
        />
      )}
    </SetupShell>
  );
}

function SetupShell({
  organizationName,
  connection,
  accountName,
  children,
}: {
  organizationName: string;
  connection: string | null;
  accountName?: string | null;
  children: React.ReactNode;
}) {
  return (
    <PageBody>
      <PageHeader
        title="Connect Google locations"
        description={
          accountName
            ? `Choose which locations from ${accountName} Lia should monitor for ${organizationName}.`
            : `Choose which Google locations Lia should monitor for ${organizationName}.`
        }
        actions={
          <Link
            href="/integrations/google-business-profile"
            className="inline-flex h-9 shrink-0 items-center justify-center gap-1.5 rounded-lg border border-gray-300 bg-white px-3 text-[13px] font-medium whitespace-nowrap text-gray-700 transition-colors hover:bg-gray-50 hover:text-gray-950 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-600"
          >
            <ArrowLeft className="size-4 shrink-0" aria-hidden />
            Back to integrations
          </Link>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <PlatformGlyph platform="google_business_profile" size="md" />
          <span className="text-[13px] font-medium text-gray-950">
            Google Business Profile
          </span>
          {connection ? (
            <ConnectionStatusBadge
              status={
                connection as Parameters<
                  typeof ConnectionStatusBadge
                >[0]["status"]
              }
            />
          ) : null}
        </div>
      </PageHeader>

      <p className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-[13px] text-gray-700">
        Mapping a Google location tells Lia which restaurant its reviews belong
        to. Nothing is connected until you save, and no reviews are imported —
        review synchronisation is not built yet.
      </p>

      {children}
    </PageBody>
  );
}
