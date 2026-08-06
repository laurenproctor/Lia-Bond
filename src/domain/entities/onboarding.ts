import { z } from "zod";
import {
  ONBOARDING_WIZARD_STEPS,
  onboardingStatusSchema,
  onboardingStepSchema,
  type OnboardingStep,
  type OnboardingWizardStep,
} from "@/domain/enums";
import {
  languageTagSchema,
  timestampSchema,
  timestampsSchema,
  timezoneSchema,
  uuidSchema,
} from "@/domain/primitives";

/**
 * First-run setup progress.
 *
 * One row per organization, created with it. The reason this is a table rather
 * than wizard state in the browser is that setup is not a single sitting: it
 * involves an OAuth round trip through Google, and people routinely start on a
 * laptop and finish somewhere else. Progress has to be a fact about the
 * organization, not about a tab.
 *
 * This module is pure. Everything the route guard decides — which step is next,
 * which steps may be revisited, whether the wizard is finished — is derived
 * here from timestamps, so it is unit-testable and identical on both adapters.
 */

/* -------------------------------------------------------------------------- */
/* The record                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * How many locations the organization runs.
 *
 * Setup metadata, deliberately not a column on `Organization`: nothing in the
 * product queries or renders it. The values are ranges rather than a number
 * because the question is answered before anybody has counted, and a range is
 * what a person can answer honestly in one click.
 */
export const ORGANIZATION_SIZES = ["1", "2-5", "6-20", "21-50", "51+"] as const;

export type OrganizationSize = (typeof ORGANIZATION_SIZES)[number];

export const organizationSizeSchema = z.enum(ORGANIZATION_SIZES);

export const ORGANIZATION_SIZE_LABELS: Record<OrganizationSize, string> = {
  "1": "1 location",
  "2-5": "2–5 locations",
  "6-20": "6–20 locations",
  "21-50": "21–50 locations",
  "51+": "51+ locations",
};

export const organizationOnboardingSchema = z
  .object({
    /** The primary key. One row per organization, so there is no separate id. */
    organizationId: uuidSchema,
    status: onboardingStatusSchema,
    /**
     * Advisory only.
     *
     * The route guard recomputes the resume point from the timestamps below, so
     * a stale or tampered value here cannot let anybody skip a step. It is
     * stored because "where were they" is worth answering without replaying the
     * derivation, not because anything trusts it.
     */
    currentStep: onboardingStepSchema,

    organizationCompletedAt: timestampSchema.nullable(),
    sourceCompletedAt: timestampSchema.nullable(),
    sourceSkippedAt: timestampSchema.nullable(),
    locationsCompletedAt: timestampSchema.nullable(),
    locationsSkippedAt: timestampSchema.nullable(),
    brandVoiceCompletedAt: timestampSchema.nullable(),
    teamCompletedAt: timestampSchema.nullable(),
    teamSkippedAt: timestampSchema.nullable(),
    completedAt: timestampSchema.nullable(),
    readyViewedAt: timestampSchema.nullable(),

    organizationSize: organizationSizeSchema.nullable(),
  })
  .extend(timestampsSchema.shape);

export type OrganizationOnboarding = z.infer<typeof organizationOnboardingSchema>;

/* -------------------------------------------------------------------------- */
/* Step metadata                                                               */
/* -------------------------------------------------------------------------- */

export interface OnboardingStepDefinition {
  step: OnboardingWizardStep;
  /** 1-based, as displayed. */
  number: number;
  title: string;
  description: string;
  path: string;
}

/**
 * The five steps, in order.
 *
 * The single declaration: the progress strip, the route guard, the redirect
 * helpers, and the tests all read this. Adding a step is one edit here plus a
 * migration for the new timestamp column.
 */
export const ONBOARDING_STEP_DEFINITIONS: readonly OnboardingStepDefinition[] = [
  {
    step: "organization",
    number: 1,
    title: "Organization",
    description: "Tell us about your business",
    path: "/onboarding/organization",
  },
  {
    step: "connect_sources",
    number: 2,
    title: "Connect sources",
    description: "Add your reviews and profiles",
    path: "/onboarding/connect-sources",
  },
  {
    step: "locations",
    number: 3,
    title: "Choose locations",
    description: "Select locations to monitor",
    path: "/onboarding/locations",
  },
  {
    step: "brand_voice",
    number: 4,
    title: "Brand voice",
    description: "Set how Lia should sound",
    path: "/onboarding/brand-voice",
  },
  {
    step: "team",
    number: 5,
    title: "Invite team",
    description: "Bring your team on board",
    path: "/onboarding/team",
  },
] as const;

export const ONBOARDING_READY_PATH = "/onboarding/ready";

export function onboardingStepDefinition(
  step: OnboardingWizardStep,
): OnboardingStepDefinition {
  const definition = ONBOARDING_STEP_DEFINITIONS.find((entry) => entry.step === step);
  // Unreachable while the two lists are declared from the same tuple, but
  // returning a placeholder would let a future mismatch render a blank step
  // rather than fail.
  if (!definition) throw new Error(`Unknown onboarding step: ${step}`);
  return definition;
}

/** The wizard path for a step, or the ready screen for `ready`. */
export function onboardingPathFor(step: OnboardingStep): string {
  if (step === "ready") return ONBOARDING_READY_PATH;
  return onboardingStepDefinition(step).path;
}

/* -------------------------------------------------------------------------- */
/* Derived progress                                                            */
/* -------------------------------------------------------------------------- */

/**
 * What a step looks like in the progress strip.
 *
 * `skipped` is separate from `done` because the two mean different things to
 * the person reading the strip: a skipped source step is why location discovery
 * is unavailable two screens later, and showing it as a completed tick would
 * make that unexplainable.
 */
export type OnboardingStepState = "done" | "skipped" | "current" | "upcoming";

/** True when a step has been either completed or deliberately skipped. */
export function isStepSettled(
  state: OrganizationOnboarding,
  step: OnboardingWizardStep,
): boolean {
  switch (step) {
    case "organization":
      return state.organizationCompletedAt !== null;
    case "connect_sources":
      return state.sourceCompletedAt !== null || state.sourceSkippedAt !== null;
    case "locations":
      return state.locationsCompletedAt !== null || state.locationsSkippedAt !== null;
    case "brand_voice":
      return state.brandVoiceCompletedAt !== null;
    case "team":
      return state.teamCompletedAt !== null || state.teamSkippedAt !== null;
  }
}

export function isStepSkipped(
  state: OrganizationOnboarding,
  step: OnboardingWizardStep,
): boolean {
  switch (step) {
    case "connect_sources":
      return state.sourceSkippedAt !== null;
    case "locations":
      return state.locationsSkippedAt !== null;
    case "team":
      return state.teamSkippedAt !== null;
    default:
      // The organization and brand-voice steps offer no skip. Saying so here
      // rather than adding unused columns keeps the table honest.
      return false;
  }
}

/**
 * The first step that has neither been completed nor skipped.
 *
 * Null once every step is settled — which is what "the wizard is finished"
 * means, independently of the `status` column. Deriving it rather than trusting
 * `currentStep` is what stops a tampered or stale value from unlocking a step.
 */
export function firstIncompleteStep(
  state: OrganizationOnboarding,
): OnboardingWizardStep | null {
  for (const step of ONBOARDING_WIZARD_STEPS) {
    if (!isStepSettled(state, step)) return step;
  }
  return null;
}

export function isOnboardingComplete(state: OrganizationOnboarding): boolean {
  return state.status === "completed";
}

/**
 * Whether the wizard may render this step right now.
 *
 * A step is reachable when every step before it is settled. Backward navigation
 * therefore falls out for free — a completed step's predecessors are settled by
 * definition — and typing the URL of a step three ahead does not.
 */
export function isStepReachable(
  state: OrganizationOnboarding,
  step: OnboardingWizardStep,
): boolean {
  for (const candidate of ONBOARDING_WIZARD_STEPS) {
    if (candidate === step) return true;
    if (!isStepSettled(state, candidate)) return false;
  }
  return false;
}

export function stepState(
  state: OrganizationOnboarding,
  step: OnboardingWizardStep,
  activeStep: OnboardingWizardStep,
): OnboardingStepState {
  if (step === activeStep) return "current";
  if (isStepSkipped(state, step)) return "skipped";
  if (isStepSettled(state, step)) return "done";
  return "upcoming";
}

/**
 * Where an incomplete organization should be sent.
 *
 * Once every step is settled but the wizard has not been finished — which
 * happens if the browser dies between the last step and the completion write —
 * the answer is the team step, so the person can press Finish setup again
 * rather than being stranded.
 */
export function resumePath(state: OrganizationOnboarding): string {
  if (isOnboardingComplete(state)) return ONBOARDING_READY_PATH;
  const next = firstIncompleteStep(state);
  return onboardingPathFor(next ?? "team");
}

/* -------------------------------------------------------------------------- */
/* Step 1 input                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Industries offered on step 1.
 *
 * `organizations.industry` is a free-text column, so this list constrains the
 * form rather than the database. That is deliberate: a customer whose business
 * does not appear here still has to be able to sign up, which is what `Other`
 * is for, and a Postgres enum would turn every new vertical into a migration.
 */
export const INDUSTRY_OPTIONS = [
  "Restaurant group",
  "Independent restaurant",
  "Hotel or hospitality group",
  "Clinic or medical practice",
  "Salon or barbershop",
  "Med spa",
  "Retail",
  "Agency",
  "Other",
] as const;

export type IndustryOption = (typeof INDUSTRY_OPTIONS)[number];

/**
 * What step 1 writes.
 *
 * The slug is absent and must stay absent. It is globally unique and appears in
 * links, so it is derived at provisioning and never edited — offering it here
 * would let a customer collide with, or impersonate, another tenant's URL.
 *
 * The website is optional but validated when present: a value that is not a URL
 * would be stored and then rendered as a broken link on every screen that shows
 * it. An empty string is normalised to null rather than rejected, because "I
 * left the optional field blank" is not a mistake.
 */
export const updateOnboardingOrganizationInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, "Enter your organization name.")
    .max(160, "Keep the name under 160 characters."),
  websiteUrl: z
    .string()
    .trim()
    .transform((value) => (value.length === 0 ? null : value))
    .nullable()
    .refine(
      (value) => value === null || z.url().safeParse(value).success,
      "Enter a full web address, including https://",
    ),
  industry: z.enum(INDUSTRY_OPTIONS, {
    message: "Choose the industry that fits best.",
  }),
  organizationSize: organizationSizeSchema.nullable().optional(),
  defaultTimezone: timezoneSchema.refine(
    isSupportedTimezone,
    "Choose a time zone from the list.",
  ),
  defaultLanguage: languageTagSchema.refine(
    (value) => (ONBOARDING_LANGUAGES as readonly string[]).includes(value),
    "Choose a language from the list.",
  ),
});

export type UpdateOnboardingOrganizationInput = z.infer<
  typeof updateOnboardingOrganizationInputSchema
>;

/**
 * The languages the form offers.
 *
 * Short on purpose. Lia generates text in the configured language, and offering
 * one it has never been exercised in would be a promise the response drafting
 * cannot keep.
 */
export const ONBOARDING_LANGUAGES = ["en-US", "en-GB", "es-ES", "fr-FR", "de-DE"] as const;

export const ONBOARDING_LANGUAGE_LABELS: Record<string, string> = {
  "en-US": "English (US)",
  "en-GB": "English (UK)",
  "es-ES": "Spanish (Spain)",
  "fr-FR": "French (France)",
  "de-DE": "German (Germany)",
};

export const DEFAULT_ONBOARDING_LANGUAGE = "en-US";

/**
 * Time zones the form offers, grouped for the select.
 *
 * A curated list rather than `Intl.supportedValuesOf("timeZone")`, which
 * returns several hundred entries — a select nobody can use — and differs
 * between runtimes, which would make server-side validation depend on which
 * Node built the response. Every entry is a real IANA name, so the value stored
 * is one `Intl.DateTimeFormat` accepts.
 */
export const ONBOARDING_TIMEZONES: readonly { value: string; label: string }[] = [
  { value: "America/New_York", label: "(GMT−05:00) Eastern Time (US & Canada)" },
  { value: "America/Chicago", label: "(GMT−06:00) Central Time (US & Canada)" },
  { value: "America/Denver", label: "(GMT−07:00) Mountain Time (US & Canada)" },
  { value: "America/Phoenix", label: "(GMT−07:00) Arizona" },
  { value: "America/Los_Angeles", label: "(GMT−08:00) Pacific Time (US & Canada)" },
  { value: "America/Anchorage", label: "(GMT−09:00) Alaska" },
  { value: "Pacific/Honolulu", label: "(GMT−10:00) Hawaii" },
  { value: "America/Toronto", label: "(GMT−05:00) Toronto" },
  { value: "America/Vancouver", label: "(GMT−08:00) Vancouver" },
  { value: "America/Mexico_City", label: "(GMT−06:00) Mexico City" },
  { value: "America/Sao_Paulo", label: "(GMT−03:00) São Paulo" },
  { value: "Europe/London", label: "(GMT+00:00) London" },
  { value: "Europe/Dublin", label: "(GMT+00:00) Dublin" },
  { value: "Europe/Paris", label: "(GMT+01:00) Paris" },
  { value: "Europe/Madrid", label: "(GMT+01:00) Madrid" },
  { value: "Europe/Berlin", label: "(GMT+01:00) Berlin" },
  { value: "Europe/Amsterdam", label: "(GMT+01:00) Amsterdam" },
  { value: "Europe/Stockholm", label: "(GMT+01:00) Stockholm" },
  { value: "Europe/Athens", label: "(GMT+02:00) Athens" },
  { value: "Asia/Dubai", label: "(GMT+04:00) Dubai" },
  { value: "Asia/Kolkata", label: "(GMT+05:30) Kolkata" },
  { value: "Asia/Singapore", label: "(GMT+08:00) Singapore" },
  { value: "Asia/Hong_Kong", label: "(GMT+08:00) Hong Kong" },
  { value: "Asia/Tokyo", label: "(GMT+09:00) Tokyo" },
  { value: "Australia/Sydney", label: "(GMT+11:00) Sydney" },
  { value: "Pacific/Auckland", label: "(GMT+13:00) Auckland" },
  { value: "UTC", label: "(GMT+00:00) UTC" },
];

export function isSupportedTimezone(value: string): boolean {
  return ONBOARDING_TIMEZONES.some((zone) => zone.value === value);
}

/**
 * The browser's time zone, if the form may offer it.
 *
 * A suggestion only — the server re-validates against the same list, so a
 * browser reporting something exotic simply gets the default rather than
 * writing an unusable value.
 */
export function suggestedTimezone(browserTimezone: string | null): string {
  if (browserTimezone && isSupportedTimezone(browserTimezone)) return browserTimezone;
  return "America/New_York";
}
