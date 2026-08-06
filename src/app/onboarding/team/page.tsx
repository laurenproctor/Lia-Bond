import type { Metadata } from "next";
import { BarChart3, ShieldCheck, Sparkles, Users } from "lucide-react";
import { OnboardingAside, stepEyebrow } from "@/components/onboarding/onboarding-aside";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { TeamStepForm } from "@/components/onboarding/team-step-form";
import { onboardingStepDefinition } from "@/domain";
import { requireSession } from "@/lib/auth/session";
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
 * What this step produces is **copyable invitation links, not emails.** Lia does
 * not send invitation mail (D55: Supabase's built-in SMTP on a new project is
 * rate-limited and may deliver only to project members, so an email-only
 * invitation would fail silently and look like a bug in Lia). The screen says so
 * in as many words, because a customer who believes an email went out will wait
 * for a reply that is never coming.
 */
export default async function OnboardingTeamPage() {
  const [context, session] = await Promise.all([
    requireOnboardingStep("team"),
    requireSession(),
  ]);
  const definition = onboardingStepDefinition("team");

  return (
    <OnboardingShell
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
      />
    </OnboardingShell>
  );
}
