"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { Building2 } from "lucide-react";
import { updateOnboardingOrganizationAction } from "@/app/actions/onboarding";
import {
  OnboardingActions,
  OnboardingError,
  OnboardingErrorSummary,
  PrimaryAction,
} from "@/components/onboarding/onboarding-actions";
import {
  OnboardingCard,
  OnboardingNote,
  OnboardingStepHeader,
} from "@/components/onboarding/onboarding-card";
import {
  OnboardingSelectField,
  OnboardingTextField,
} from "@/components/onboarding/onboarding-field";
import {
  INDUSTRY_OPTIONS,
  ONBOARDING_LANGUAGE_LABELS,
  ONBOARDING_LANGUAGES,
  ONBOARDING_TIMEZONES,
  ORGANIZATION_SIZE_LABELS,
  ORGANIZATION_SIZES,
  isSupportedTimezone,
  type OrganizationSize,
} from "@/domain";

/**
 * Step 1's form.
 *
 * A client component because it holds five interdependent controls and has to
 * render per-field errors from the server's own Zod result — a plain server
 * action form would lose the person's typing on every validation failure, which
 * on a nine-field form is the difference between a correction and a re-entry.
 *
 * The device's time zone is **offered**, never applied. Two reasons it is a
 * button rather than a default: `Intl` resolves to the server's zone during
 * SSR, so writing it into state on mount would flip the select under somebody's
 * cursor after hydration; and a customer whose organization already carries a
 * time zone should not have it silently replaced by wherever they happen to be
 * sitting. The server re-validates whatever is submitted against the same list,
 * so a browser reporting something exotic changes nothing either way.
 */

/**
 * True once hydrated, false during SSR.
 *
 * `useSyncExternalStore` with a server snapshot rather than an effect: it gives
 * React the two answers explicitly, so there is no hydration mismatch and no
 * setState in an effect body.
 */
function useIsHydrated(): boolean {
  return useSyncExternalStore(
    // Never resubscribes: the answer changes exactly once, at hydration.
    () => () => {},
    () => true,
    () => false,
  );
}

export interface OrganizationStepInitial {
  name: string;
  websiteUrl: string;
  industry: string;
  organizationSize: OrganizationSize | null;
  defaultTimezone: string;
  defaultLanguage: string;
}

const FIELD_LABELS: Record<string, string> = {
  name: "Organization name",
  websiteUrl: "Website",
  industry: "Industry",
  organizationSize: "Organization size",
  defaultTimezone: "Default timezone",
  defaultLanguage: "Default language",
};

const INDUSTRY_SELECT = INDUSTRY_OPTIONS.map((value) => ({ value, label: value }));

const SIZE_SELECT = ORGANIZATION_SIZES.map((value) => ({
  value,
  label: ORGANIZATION_SIZE_LABELS[value],
}));

const LANGUAGE_SELECT = ONBOARDING_LANGUAGES.map((value) => ({
  value,
  label: ONBOARDING_LANGUAGE_LABELS[value] ?? value,
}));

const TIMEZONE_SELECT = ONBOARDING_TIMEZONES.map((zone) => ({
  value: zone.value,
  label: zone.label,
}));

export function OrganizationStepForm({
  initial,
}: {
  initial: OrganizationStepInitial;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [name, setName] = useState(initial.name);
  const [websiteUrl, setWebsiteUrl] = useState(initial.websiteUrl);
  // Falls back to the first option rather than to an empty string when the
  // organization's stored industry is something this list does not contain —
  // provisioning defaults it to "Restaurant group", but an organization edited
  // elsewhere could hold anything, and a select with no matching option renders
  // blank while claiming to be required.
  const [industry, setIndustry] = useState(
    (INDUSTRY_OPTIONS as readonly string[]).includes(initial.industry)
      ? initial.industry
      : INDUSTRY_OPTIONS[0],
  );
  const [size, setSize] = useState<string>(initial.organizationSize ?? "");
  const [timezone, setTimezone] = useState(
    isSupportedTimezone(initial.defaultTimezone) ? initial.defaultTimezone : "",
  );
  const [language, setLanguage] = useState(initial.defaultLanguage);

  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const summaryRef = useRef<HTMLDivElement>(null);

  // The device's zone, offered as a one-click alternative. Read during render
  // rather than stored, and only after hydration — during SSR `Intl` would
  // resolve to the server's zone, which is nobody's answer.
  const hydrated = useIsHydrated();
  const deviceZone = hydrated
    ? Intl.DateTimeFormat().resolvedOptions().timeZone
    : null;
  const zoneSuggestion =
    deviceZone && isSupportedTimezone(deviceZone) && deviceZone !== timezone
      ? deviceZone
      : null;

  // Focus moves to the summary after a failure, so the next thing a keyboard or
  // screen-reader user encounters is what went wrong rather than the top of the
  // form they just filled in.
  useEffect(() => {
    if (Object.keys(fieldErrors).length > 0) summaryRef.current?.focus();
  }, [fieldErrors]);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    setError(null);
    setFieldErrors({});

    startTransition(async () => {
      const result = await updateOnboardingOrganizationAction({
        name,
        websiteUrl,
        industry,
        organizationSize: size === "" ? null : size,
        defaultTimezone: timezone,
        defaultLanguage: language,
      });

      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }

      router.push(result.data.nextPath);
    });
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-6">
      <OnboardingCard className="flex flex-col gap-6">
        <OnboardingStepHeader
          icon={Building2}
          title="Tell us about your organization"
          description="This information helps Lia personalize your experience and organize your data securely."
        />

        <div ref={summaryRef} tabIndex={-1} className="focus:outline-none">
          <OnboardingErrorSummary errors={fieldErrors} labels={FIELD_LABELS} />
        </div>

        <div className="flex flex-col gap-5">
          <OnboardingTextField
            id="name"
            name="name"
            label="Organization name"
            required
            autoComplete="organization"
            maxLength={160}
            value={name}
            onChange={(event) => setName(event.target.value)}
            hint="This is the name that will appear in Lia."
            error={fieldErrors.name}
          />

          <OnboardingTextField
            id="websiteUrl"
            name="websiteUrl"
            label="Website"
            type="url"
            inputMode="url"
            autoComplete="url"
            placeholder="https://your-website.com"
            value={websiteUrl}
            onChange={(event) => setWebsiteUrl(event.target.value)}
            hint="Used to understand your brand and public presence."
            error={fieldErrors.websiteUrl}
          />

          <div className="grid gap-5 sm:grid-cols-2">
            <OnboardingSelectField
              id="industry"
              name="industry"
              label="Industry"
              required
              options={INDUSTRY_SELECT}
              value={industry}
              onChange={(event) => setIndustry(event.target.value)}
              error={fieldErrors.industry}
            />

            <OnboardingSelectField
              id="organizationSize"
              name="organizationSize"
              label="Organization size"
              options={SIZE_SELECT}
              placeholder="Select size"
              value={size}
              onChange={(event) => setSize(event.target.value)}
              error={fieldErrors.organizationSize}
            />
          </div>

          <div className="flex flex-col gap-2">
            <OnboardingSelectField
              id="defaultTimezone"
              name="defaultTimezone"
              label="Default timezone"
              required
              options={TIMEZONE_SELECT}
              placeholder="Select your timezone"
              value={timezone}
              onChange={(event) => setTimezone(event.target.value)}
              error={fieldErrors.defaultTimezone}
            />
            {zoneSuggestion ? (
              <button
                type="button"
                onClick={() => setTimezone(zoneSuggestion)}
                className="w-fit rounded-lg text-[12.5px] font-semibold text-site-blue underline-offset-4 hover:underline"
              >
                Use your device time zone ({zoneSuggestion.replace(/_/g, " ")})
              </button>
            ) : null}
          </div>

          <OnboardingSelectField
            id="defaultLanguage"
            name="defaultLanguage"
            label="Default language"
            required
            options={LANGUAGE_SELECT}
            value={language}
            onChange={(event) => setLanguage(event.target.value)}
            error={fieldErrors.defaultLanguage}
          />
        </div>

        <OnboardingNote title="You can change these settings anytime">
          You&rsquo;ll be able to invite team members, connect sources, and customize
          Lia after your workspace is created.
        </OnboardingNote>

        {error && Object.keys(fieldErrors).length === 0 ? (
          <OnboardingError>{error}</OnboardingError>
        ) : null}

        <OnboardingActions
          primary={
            <PrimaryAction pending={pending} pendingLabel="Saving…">
              Save and continue
            </PrimaryAction>
          }
          note="Your data is secure and never shared"
        />
      </OnboardingCard>
    </form>
  );
}
