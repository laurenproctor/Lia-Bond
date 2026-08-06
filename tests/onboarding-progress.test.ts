import { describe, expect, it } from "vitest";
import {
  DEFAULT_ONBOARDING_LANGUAGE,
  firstIncompleteStep,
  INDUSTRY_OPTIONS,
  isOnboardingComplete,
  isStepReachable,
  isStepSettled,
  isStepSkipped,
  isSupportedTimezone,
  ONBOARDING_LANGUAGES,
  ONBOARDING_READY_PATH,
  ONBOARDING_STEP_DEFINITIONS,
  ONBOARDING_TIMEZONES,
  ONBOARDING_WIZARD_STEPS,
  onboardingPathFor,
  onboardingStepDefinition,
  ORGANIZATION_SIZE_LABELS,
  ORGANIZATION_SIZES,
  resumePath,
  stepState,
  suggestedTimezone,
  updateOnboardingOrganizationInputSchema,
  type OrganizationOnboarding,
} from "@/domain";

/**
 * The onboarding progress model.
 *
 * Pure functions, so they are tested directly rather than through a route. This
 * is where the guard's decisions actually live: `requireOnboardingStep` does no
 * arithmetic of its own — it asks `isStepReachable` and redirects to
 * `resumePath`. Getting these wrong is how somebody types their way to step 4
 * with no Google connection behind it.
 */

const AT_START: OrganizationOnboarding = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  status: "in_progress",
  currentStep: "organization",
  organizationCompletedAt: null,
  sourceCompletedAt: null,
  sourceSkippedAt: null,
  locationsCompletedAt: null,
  locationsSkippedAt: null,
  brandVoiceCompletedAt: null,
  teamCompletedAt: null,
  teamSkippedAt: null,
  completedAt: null,
  readyViewedAt: null,
  organizationSize: null,
  createdAt: "2026-08-06T00:00:00.000Z",
  updatedAt: "2026-08-06T00:00:00.000Z",
};

const STAMP = "2026-08-06T10:00:00.000Z";

function progressed(patch: Partial<OrganizationOnboarding>): OrganizationOnboarding {
  return { ...AT_START, ...patch };
}

describe("step settlement", () => {
  it("treats nothing as settled at the start", () => {
    for (const step of ONBOARDING_WIZARD_STEPS) {
      expect(isStepSettled(AT_START, step)).toBe(false);
    }
  });

  it("counts a completed step as settled", () => {
    const state = progressed({ organizationCompletedAt: STAMP });
    expect(isStepSettled(state, "organization")).toBe(true);
    expect(isStepSettled(state, "connect_sources")).toBe(false);
  });

  it("counts a skipped step as settled but not completed", () => {
    const state = progressed({ sourceSkippedAt: STAMP });
    expect(isStepSettled(state, "connect_sources")).toBe(true);
    expect(isStepSkipped(state, "connect_sources")).toBe(true);
  });

  it("never reports the two unskippable steps as skipped", () => {
    // Neither has a `_skipped_at` column, which is the point: the organization
    // details and the brand voice are always answered, never waived.
    expect(isStepSkipped(progressed({ organizationCompletedAt: STAMP }), "organization")).toBe(
      false,
    );
    expect(
      isStepSkipped(progressed({ brandVoiceCompletedAt: STAMP }), "brand_voice"),
    ).toBe(false);
  });
});

describe("first incomplete step", () => {
  it("starts at the organization", () => {
    expect(firstIncompleteStep(AT_START)).toBe("organization");
  });

  it("walks forward as steps settle", () => {
    expect(
      firstIncompleteStep(progressed({ organizationCompletedAt: STAMP })),
    ).toBe("connect_sources");

    expect(
      firstIncompleteStep(
        progressed({ organizationCompletedAt: STAMP, sourceSkippedAt: STAMP }),
      ),
    ).toBe("locations");
  });

  it("returns null once every step is settled", () => {
    const finished = progressed({
      organizationCompletedAt: STAMP,
      sourceCompletedAt: STAMP,
      locationsCompletedAt: STAMP,
      brandVoiceCompletedAt: STAMP,
      teamSkippedAt: STAMP,
    });
    expect(firstIncompleteStep(finished)).toBeNull();
  });

  it("does not skip a gap left by a later step settling first", () => {
    // Should be impossible through the UI, but the guard must not be fooled by
    // a row in that state — the answer is still the earliest unsettled step.
    const odd = progressed({ teamCompletedAt: STAMP });
    expect(firstIncompleteStep(odd)).toBe("organization");
  });
});

describe("step reachability", () => {
  it("allows only the first step at the start", () => {
    expect(isStepReachable(AT_START, "organization")).toBe(true);
    expect(isStepReachable(AT_START, "connect_sources")).toBe(false);
    expect(isStepReachable(AT_START, "locations")).toBe(false);
    expect(isStepReachable(AT_START, "brand_voice")).toBe(false);
    expect(isStepReachable(AT_START, "team")).toBe(false);
  });

  it("refuses a step whose predecessor is unsettled, however far along", () => {
    // The exact URL-typing case: three steps done, but step 3 was never
    // settled, so steps 4 and 5 stay closed.
    const gap = progressed({
      organizationCompletedAt: STAMP,
      sourceCompletedAt: STAMP,
      brandVoiceCompletedAt: STAMP,
    });
    expect(isStepReachable(gap, "locations")).toBe(true);
    expect(isStepReachable(gap, "brand_voice")).toBe(false);
    expect(isStepReachable(gap, "team")).toBe(false);
  });

  it("keeps completed steps reachable, so back navigation works", () => {
    const midway = progressed({
      organizationCompletedAt: STAMP,
      sourceCompletedAt: STAMP,
      locationsCompletedAt: STAMP,
    });
    expect(isStepReachable(midway, "organization")).toBe(true);
    expect(isStepReachable(midway, "connect_sources")).toBe(true);
    expect(isStepReachable(midway, "locations")).toBe(true);
    expect(isStepReachable(midway, "brand_voice")).toBe(true);
  });

  it("treats a skipped step exactly like a completed one for reachability", () => {
    const skipped = progressed({
      organizationCompletedAt: STAMP,
      sourceSkippedAt: STAMP,
    });
    expect(isStepReachable(skipped, "locations")).toBe(true);
  });
});

describe("resume path", () => {
  it("points at the first incomplete step", () => {
    expect(resumePath(AT_START)).toBe("/onboarding/organization");
    expect(resumePath(progressed({ organizationCompletedAt: STAMP }))).toBe(
      "/onboarding/connect-sources",
    );
  });

  it("sends a completed organization to the ready screen", () => {
    const done = progressed({
      status: "completed",
      completedAt: STAMP,
      currentStep: "ready",
      organizationCompletedAt: STAMP,
      sourceCompletedAt: STAMP,
      locationsCompletedAt: STAMP,
      brandVoiceCompletedAt: STAMP,
      teamCompletedAt: STAMP,
    });
    expect(isOnboardingComplete(done)).toBe(true);
    expect(resumePath(done)).toBe(ONBOARDING_READY_PATH);
  });

  it("sends every-step-settled-but-not-finished back to the last step", () => {
    // The browser died between Finish setup and the completion write. The
    // person must be able to press the button again rather than be stranded.
    const stranded = progressed({
      organizationCompletedAt: STAMP,
      sourceCompletedAt: STAMP,
      locationsCompletedAt: STAMP,
      brandVoiceCompletedAt: STAMP,
      teamCompletedAt: STAMP,
    });
    expect(isOnboardingComplete(stranded)).toBe(false);
    expect(resumePath(stranded)).toBe("/onboarding/team");
  });
});

describe("step display state", () => {
  it("marks the active step current even when it is already settled", () => {
    const revisiting = progressed({
      organizationCompletedAt: STAMP,
      sourceCompletedAt: STAMP,
    });
    expect(stepState(revisiting, "organization", "organization")).toBe("current");
    expect(stepState(revisiting, "connect_sources", "organization")).toBe("done");
    expect(stepState(revisiting, "locations", "organization")).toBe("upcoming");
  });

  it("distinguishes skipped from done", () => {
    const skipped = progressed({
      organizationCompletedAt: STAMP,
      sourceSkippedAt: STAMP,
    });
    expect(stepState(skipped, "connect_sources", "locations")).toBe("skipped");
  });
});

describe("the step table", () => {
  it("numbers the five steps in order", () => {
    expect(ONBOARDING_STEP_DEFINITIONS.map((entry) => entry.number)).toEqual([
      1, 2, 3, 4, 5,
    ]);
  });

  it("matches the wizard vocabulary exactly", () => {
    expect(ONBOARDING_STEP_DEFINITIONS.map((entry) => entry.step)).toEqual([
      ...ONBOARDING_WIZARD_STEPS,
    ]);
  });

  it("carries the copy the progress strip renders", () => {
    expect(onboardingStepDefinition("organization").description).toBe(
      "Tell us about your business",
    );
    expect(onboardingStepDefinition("team").title).toBe("Invite team");
  });

  it("routes `ready` to the ready screen rather than a step", () => {
    expect(onboardingPathFor("ready")).toBe(ONBOARDING_READY_PATH);
    expect(onboardingPathFor("locations")).toBe("/onboarding/locations");
  });
});

describe("organization step input", () => {
  const valid = {
    name: "Acme Restaurant Group",
    websiteUrl: "https://acme.example",
    industry: "Restaurant group",
    organizationSize: "2-5",
    defaultTimezone: "America/New_York",
    defaultLanguage: "en-US",
  };

  it("accepts a complete submission", () => {
    const parsed = updateOnboardingOrganizationInputSchema.parse(valid);
    expect(parsed.name).toBe("Acme Restaurant Group");
    expect(parsed.websiteUrl).toBe("https://acme.example");
  });

  it("normalises a blank website to null rather than rejecting it", () => {
    const parsed = updateOnboardingOrganizationInputSchema.parse({
      ...valid,
      websiteUrl: "   ",
    });
    expect(parsed.websiteUrl).toBeNull();
  });

  it("refuses a website that is not a URL", () => {
    const result = updateOnboardingOrganizationInputSchema.safeParse({
      ...valid,
      websiteUrl: "acme dot example",
    });
    expect(result.success).toBe(false);
  });

  it("refuses a timezone that is not on the offered list", () => {
    const result = updateOnboardingOrganizationInputSchema.safeParse({
      ...valid,
      defaultTimezone: "Mars/Olympus_Mons",
    });
    expect(result.success).toBe(false);
  });

  it("refuses a language that is not on the offered list", () => {
    const result = updateOnboardingOrganizationInputSchema.safeParse({
      ...valid,
      defaultLanguage: "xx-XX",
    });
    expect(result.success).toBe(false);
  });

  it("refuses an empty organization name", () => {
    const result = updateOnboardingOrganizationInputSchema.safeParse({
      ...valid,
      name: "   ",
    });
    expect(result.success).toBe(false);
  });

  it("has no slug field at all", () => {
    // Not merely "ignores a slug": the shape must not accept one, because the
    // slug is globally unique and appears in links.
    const parsed = updateOnboardingOrganizationInputSchema.parse({
      ...valid,
      slug: "somebody-elses-slug",
    });
    expect("slug" in parsed).toBe(false);
  });

  it("treats organization size as optional", () => {
    const parsed = updateOnboardingOrganizationInputSchema.parse({
      ...valid,
      organizationSize: null,
    });
    expect(parsed.organizationSize).toBeNull();
  });
});

describe("the offered options", () => {
  it("includes every industry the flow promises", () => {
    for (const industry of [
      "Restaurant group",
      "Independent restaurant",
      "Hotel or hospitality group",
      "Clinic or medical practice",
      "Salon or barbershop",
      "Med spa",
      "Retail",
      "Agency",
      "Other",
    ]) {
      expect(INDUSTRY_OPTIONS).toContain(industry);
    }
  });

  it("labels every organization size", () => {
    for (const size of ORGANIZATION_SIZES) {
      expect(ORGANIZATION_SIZE_LABELS[size]).toBeTruthy();
    }
  });

  it("offers only real IANA time zones", () => {
    for (const zone of ONBOARDING_TIMEZONES) {
      // Throws for a name the runtime does not know, which is the check.
      expect(() =>
        new Intl.DateTimeFormat("en-US", { timeZone: zone.value }).format(new Date(0)),
      ).not.toThrow();
    }
  });

  it("defaults the language to English (US)", () => {
    expect(DEFAULT_ONBOARDING_LANGUAGE).toBe("en-US");
    expect(ONBOARDING_LANGUAGES).toContain("en-US");
  });

  it("accepts a browser time zone only when it is one Lia offers", () => {
    expect(suggestedTimezone("Europe/London")).toBe("Europe/London");
    expect(isSupportedTimezone("Europe/London")).toBe(true);
    // Real IANA name, but not on the offered list — falls back rather than
    // writing a value the server would reject.
    expect(suggestedTimezone("Africa/Nairobi")).toBe("America/New_York");
    expect(suggestedTimezone(null)).toBe("America/New_York");
  });
});
