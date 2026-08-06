import type { Metadata } from "next";
import { BarChart3, MessageSquare, ShieldCheck, Sparkles } from "lucide-react";
import { OnboardingAside, stepEyebrow } from "@/components/onboarding/onboarding-aside";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { OrganizationStepForm } from "@/components/onboarding/organization-step-form";
import { DEFAULT_ONBOARDING_LANGUAGE, onboardingStepDefinition } from "@/domain";
import { requireOnboardingStep } from "@/lib/onboarding/context";

export const metadata: Metadata = { title: "Create your workspace" };

/**
 * Step 1 — the organization.
 *
 * The organization already exists: sign-up created it, with a name and
 * defaults. This step **enriches** that row rather than creating a second one,
 * which is why the form is prefilled from the record and why there is no
 * "create" anywhere in this file.
 *
 * The slug is not on the form and must not be. It is globally unique, it
 * appears in links, and it was derived at provisioning — offering it here would
 * let a customer collide with, or impersonate, another tenant's URL.
 */
export default async function OnboardingOrganizationPage() {
  const context = await requireOnboardingStep("organization");
  const { organization } = context;
  const definition = onboardingStepDefinition("organization");

  return (
    <OnboardingShell
      step="organization"
      state={context.state}
      aside={
        <OnboardingAside
          eyebrow={stepEyebrow(definition.number)}
          headline="Create your Lia workspace"
          description="Set up the organization whose reputation Lia will monitor, analyze, and help you protect across every channel."
          benefits={[
            {
              icon: MessageSquare,
              title: "Monitor what matters",
              description:
                "Track reviews, mentions, and feedback from every channel in one place.",
            },
            {
              icon: Sparkles,
              title: "Catch issues early",
              description: "Identify risks and trends before they escalate.",
            },
            {
              icon: ShieldCheck,
              title: "Respond with confidence",
              description:
                "AI-assisted drafts and approval workflows help you reply with care and clarity.",
            },
            {
              icon: BarChart3,
              title: "Improve your reputation",
              description:
                "Turn feedback into action and build trust over time.",
            },
          ]}
        />
      }
    >
      <OrganizationStepForm
        initial={{
          name: organization.name,
          websiteUrl: organization.websiteUrl ?? "",
          industry: organization.industry,
          organizationSize: context.state.organizationSize,
          defaultTimezone: organization.defaultTimezone,
          // Only substituted when the organization carries no preference at
          // all. An organization provisioned with a language keeps it — the
          // form is not an opportunity to quietly reset somebody's choice.
          defaultLanguage: organization.defaultLanguage || DEFAULT_ONBOARDING_LANGUAGE,
        }}
      />
    </OnboardingShell>
  );
}
