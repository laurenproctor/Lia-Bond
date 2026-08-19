import type { Metadata } from "next";
import { BarChart3, Clock, MessageSquare, ShieldCheck } from "lucide-react";
import { OnboardingAside, stepEyebrow } from "@/components/onboarding/onboarding-aside";
import { OnboardingShell } from "@/components/onboarding/onboarding-shell";
import { BrandVoiceStepForm } from "@/components/onboarding/brand-voice-step-form";
import { onboardingStepDefinition } from "@/domain";
import { brandVoiceFormSeed } from "@/lib/brand-voice/seed";
import { requireOnboardingStep } from "@/lib/onboarding/context";

export const metadata: Metadata = { title: "Set how Lia should sound" };

/**
 * Step 4 — brand voice.
 *
 * Reads the **existing** persisted profile. There is no second brand-voice
 * schema and no onboarding-only storage: this screen writes through
 * `saveBrandVoice`, the same service `/brand-voice` uses, so a voice set here is
 * the voice the product uses and editing it later is editing the same row.
 *
 * That is also what makes resume safe. If the completion write fails after the
 * voice is saved, the person comes back to this screen and finds their own
 * settings already in the form — because the form is seeded from the stored
 * profile, not from wizard state.
 *
 * The seed comes from `brandVoiceFormSeed`, which `/brand-voice` also uses, so
 * the two screens cannot disagree about which fields carry over or about what to
 * show when nothing is stored. `DEFAULT_BRAND_VOICE` is that starting point, and
 * absence is normal: provisioning does not create a profile, and no migration
 * backfills one.
 */
export default async function OnboardingBrandVoicePage() {
  const context = await requireOnboardingStep("brand_voice");
  const definition = onboardingStepDefinition("brand_voice");

  const stored = await context.dataSource.brandVoice.get(context.scope);

  return (
    <OnboardingShell
      organizations={context.available}
      activeOrganizationId={context.organization.id}
      step="brand_voice"
      state={context.state}
      aside={
        <OnboardingAside
          eyebrow={stepEyebrow(definition.number)}
          headline="Set how Lia should sound"
          description="A few simple choices help Lia draft responses that feel like your business and match your brand."
          benefits={[
            {
              icon: MessageSquare,
              title: "Consistent voice",
              description: "Lia replies in a tone that reflects your brand.",
            },
            {
              icon: ShieldCheck,
              title: "Stronger connections",
              description:
                "The right tone builds trust and keeps guests coming back.",
            },
            {
              icon: Clock,
              title: "Save time",
              description: "Approve faster with replies that feel on-brand.",
            },
            {
              icon: BarChart3,
              title: "Better reputation",
              description:
                "Thoughtful replies turn more reviews into loyal customers.",
            },
          ]}
        />
      }
    >
      <BrandVoiceStepForm initial={brandVoiceFormSeed(stored)} />
    </OnboardingShell>
  );
}
