import type { Metadata } from "next";
import { Building2, MapPin, Star, Users } from "lucide-react";
import { OnboardingAside, stepEyebrow } from "@/components/onboarding/onboarding-aside";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { GoogleLocationsStep } from "@/components/onboarding/google-locations-step";
import { ManualLocationStep } from "@/components/onboarding/manual-location-step";
import type { LiaLocationOption } from "@/components/integrations/mapping-types";
import { onboardingStepDefinition } from "@/domain";
import { toIntegrationMessage } from "@/integrations/errors";
import type { ExternalAccount } from "@/integrations/connector";
import {
  buildCandidates,
  listGoogleBusinessAccounts,
  listGoogleBusinessLocations,
  type LocationCandidate,
} from "@/lib/integrations/google-service";
import { requireOnboardingStep } from "@/lib/onboarding/context";

export const metadata: Metadata = { title: "Choose your locations" };

/**
 * Step 3 — which locations Lia monitors.
 *
 * Two genuinely different screens behind one route, decided by whether a source
 * is connected:
 *
 * - **Connected.** Real Google accounts and real locations, discovered on the
 *   server during render through the same services the integrations setup
 *   screen uses. There are no fabricated candidates anywhere in this file.
 * - **Skipped.** A form for entering one location by hand. It does *not* show
 *   an empty Google table with a "refresh" button that could never return
 *   anything, because that would imply a connection exists.
 *
 * Discovery talks to Google, so it can fail for reasons the person has to be
 * told about — a revoked grant, a rate limit. Those surface as a message rather
 * than as an empty list, which would read as "you have no locations".
 */
export default async function OnboardingLocationsPage() {
  const context = await requireOnboardingStep("locations");
  const definition = onboardingStepDefinition("locations");
  const { dataSource, scope, organization } = context;

  const connection = await dataSource.platformConnections.getByPlatform(
    scope,
    "google_business_profile",
  );

  const aside = (
    <OnboardingAside
      eyebrow={stepEyebrow(definition.number)}
      headline="Choose the locations Lia should monitor"
      description="Select the Google Business Profile locations you want Lia to monitor and route feedback for."
      benefits={[
        {
          icon: MapPin,
          title: "Monitor the right places",
          description:
            "Pick the exact locations or profiles you want Lia to watch.",
        },
        {
          icon: Building2,
          title: "Manage multiple locations",
          description: "Select and manage all your businesses in one place.",
        },
        {
          icon: Users,
          title: "Route feedback to the right teams",
          description:
            "Lia helps you get feedback to the right people automatically.",
        },
        {
          icon: Star,
          title: "Stay in control",
          description: "You can add or edit locations anytime as you grow.",
        },
      ]}
    />
  );

  // No usable connection: the manual path. Reached after skipping step 2, and
  // also after disconnecting Google mid-setup.
  if (!connection || connection.status === "disconnected") {
    const existing = await dataSource.locations.list(scope);

    return (
      <OnboardingShell step="locations" state={context.state} aside={aside}>
        <ManualLocationStep
          organizationTimezone={organization.defaultTimezone}
          existingLocations={existing.map((location) => ({
            id: location.id,
            name: location.name,
            city: location.city,
            region: location.region,
          }))}
        />
      </OnboardingShell>
    );
  }

  let accounts: ExternalAccount[] = [];
  let candidates: LocationCandidate[] = [];
  let selectedAccountId: string | null = null;
  let discoveryError: string | null = null;

  try {
    const service = { dataSource, scope };
    accounts = await listGoogleBusinessAccounts(service, connection.id);

    // Default to the account the connection was established with, so returning
    // to this screen lands where the person left off.
    selectedAccountId =
      accounts.find(
        (account) => account.externalAccountId === connection.externalAccountId,
      )?.externalAccountId ??
      accounts[0]?.externalAccountId ??
      null;

    if (selectedAccountId) {
      const [profiles, mapped, locations] = await Promise.all([
        listGoogleBusinessLocations(service, connection.id, selectedAccountId),
        dataSource.platformProfiles.listForConnection(scope, connection.id),
        dataSource.locations.list(scope),
      ]);
      candidates = buildCandidates(profiles, mapped, locations);
    }
  } catch (error) {
    // Lia's own wording from a normalised code. Google's message never reaches
    // the browser: it quotes request URLs and parameters.
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
    <OnboardingShell step="locations" state={context.state} aside={aside}>
      <GoogleLocationsStep
        connectionId={connection.id}
        accountName={connection.externalAccountName}
        accounts={accounts.map((account) => ({
          externalAccountId: account.externalAccountId,
          name: account.name,
        }))}
        initialAccountId={selectedAccountId}
        initialCandidates={candidates}
        locations={options}
        // New locations inherit the organization's timezone. Google's location
        // resource does not carry one, and guessing from an address would be
        // wrong for exactly the multi-city groups Lia serves.
        organizationTimezone={organization.defaultTimezone}
        discoveryError={discoveryError}
      />
    </OnboardingShell>
  );
}
