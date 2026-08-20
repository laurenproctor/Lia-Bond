import type { Metadata } from "next";
import { BarChart3, ShieldCheck, Sparkles, Users } from "lucide-react";
import { OnboardingAside, stepEyebrow } from "@/components/onboarding/onboarding-aside";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { TeamStepForm } from "@/components/onboarding/team-step-form";
import { onboardingStepDefinition } from "@/domain";
import { requireSession } from "@/lib/auth/session";
import { canEmailInvitations } from "@/lib/env";
import { requireOnboardingStep } from "@/lib/onboarding/context";
import { initialsFor } from "@/lib/view-models/mention";

export const metadata: Metadata = { title: "Bring your team into Lia" };

/**
 * Step 5 — invite the team.
 *
 * The owner row is rendered from the session, locked, and carries no remove
 * control. It is not a form field: an organization must always have at least one
 * active owner — a constraint trigger in the database enforces it — so offering
 * to edit or delete this row would offer something the database refuses.
 *
 * What this step produces is **copyable invitation links, which Lia also emails
 * when a verified sender is configured** (D191, extending D55). Both halves of
 * that matter. The link is always produced, because a deployment with no sender
 * must still be able to bring a team in; and the screen is told, via
 * `canEmailInvitations`, whether mail will actually go out, so it never promises
 * a message this server cannot send. A customer who believes an email went out
 * will wait for a reply that is never coming.
 */
export default async function OnboardingTeamPage() {
  const [context, session] = await Promise.all([
    requireOnboardingStep("team"),
    requireSession(),
  ]);
  const definition = onboardingStepDefinition("team");

  return (
    <OnboardingShell
      organizations={context.available}
      activeOrganizationId={context.organization.id}
      step="team"
      state={context.state}
      aside={
        <OnboardingAside
          eyebrow={stepEyebrow(definition.number)}
          headline="Bring your team into Lia"
          description="Add teammates and assign the right people to approve responses, manage locations, and review escalations."
          benefits={[
            {
              icon: Users,
              title: "Right people, right roles",
              description:
                "Give your team the right access based on their responsibilities.",
            },
            {
              icon: ShieldCheck,
              title: "More coverage, less risk",
              description:
                "Make sure someone is always available to keep your reputation protected.",
            },
            {
              icon: BarChart3,
              title: "Full visibility",
              description: "See what's happening across all locations in real time.",
            },
            {
              icon: Sparkles,
              title: "Built to scale",
              description: "Add teammates anytime as your business grows.",
            },
          ]}
        />
      }
    >
      <TeamStepForm
        owner={{
          name: session.fullName || session.email,
          email: session.email,
          initials: initialsFor(session.fullName || session.email),
        }}
        // Reported honestly on the "what happens next" panel: a voice that was
        // never configured must not be claimed as saved.
        brandVoiceSaved={context.state.brandVoiceCompletedAt !== null}
        locationsConfigured={context.state.locationsCompletedAt !== null}
        // Read on the server, where the configuration lives. Decides whether
        // this screen may say an invitation will be emailed at all.
        canEmailInvitations={canEmailInvitations()}
      />
    </OnboardingShell>
  );
}
