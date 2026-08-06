import type { Metadata } from "next";
import { Link2, Layers, Sparkles, Users } from "lucide-react";
import { OnboardingAside, stepEyebrow } from "@/components/onboarding/onboarding-aside";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { ConnectSourcesStep } from "@/components/onboarding/connect-sources-step";
import { onboardingStepDefinition } from "@/domain";
import { isGoogleConnectorAvailable } from "@/integrations/registry";
import { requireOnboardingStep } from "@/lib/onboarding/context";

export const metadata: Metadata = { title: "Connect your sources" };

/**
 * Step 2 — connect the first source.
 *
 * The connection state is read on the server during render, so the first paint
 * already knows whether Google is connected rather than flashing a connect
 * button at somebody who connected five minutes ago on a previous visit.
 *
 * Only the account **name** crosses to the client. No token, no refresh token,
 * no scope list, and no account id: `platform_connection_secrets` is
 * service-role-only for a reason, and this screen is the closest any UI gets to
 * it.
 */
export default async function OnboardingConnectSourcesPage() {
  const context = await requireOnboardingStep("connect_sources");
  const definition = onboardingStepDefinition("connect_sources");

  const connection = await context.dataSource.platformConnections.getByPlatform(
    context.scope,
    "google_business_profile",
  );

  const connected = Boolean(connection) && connection?.status !== "disconnected";

  return (
    <OnboardingShell
      step="connect_sources"
      state={context.state}
      aside={
        <OnboardingAside
          eyebrow={stepEyebrow(definition.number)}
          headline="Connect your sources"
          description="We start with Google Business Profile so you can get value right away. Add more review platforms as your business grows."
          benefits={[
            {
              icon: Sparkles,
              title: "Start with what matters",
              description:
                "Google reviews drive the most visibility — connect in minutes.",
            },
            {
              icon: Layers,
              title: "Add more as you grow",
              description:
                "Yelp, Tripadvisor, Trustpilot and other platforms can follow once setup is done.",
            },
            {
              icon: Link2,
              title: "Everything in one place",
              description:
                "Monitor, respond, and report across all your sources from Lia.",
            },
            {
              icon: Users,
              title: "You stay in control",
              description:
                "Nothing is published automatically. You approve responses your way.",
            },
          ]}
        />
      }
    >
      <ConnectSourcesStep
        connected={connected}
        // Shown so somebody can confirm they authorised the right Google
        // account. Never the account id, which is a provider identifier the
        // browser has no use for.
        accountName={connection?.externalAccountName ?? null}
        connectorAvailable={isGoogleConnectorAvailable()}
        alreadySkipped={context.state.sourceSkippedAt !== null}
      />
    </OnboardingShell>
  );
}
