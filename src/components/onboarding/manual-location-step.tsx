"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { MapPin } from "lucide-react";
import {
  createOnboardingLocationAction,
  skipOnboardingLocationsAction,
} from "@/app/actions/onboarding";
import {
  OnboardingActions,
  OnboardingError,
  OnboardingErrorSummary,
  PrimaryAction,
  SecondaryLink,
  TertiaryAction,
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
import { ONBOARDING_TIMEZONES } from "@/domain";

/**
 * Step 3, manual path.
 *
 * Reached when step 2 was skipped, or when Google was disconnected mid-setup.
 * There is **no Google table here at all** — not an empty one, not a disabled
 * one. Rendering a location picker with nothing in it would tell somebody their
 * Google account has no locations, when the truth is that no Google account is
 * connected.
 *
 * A manager is not asked for. Assigning one needs a member to assign, and at
 * this point in setup the only member is the person filling in the form —
 * teammates are invited two steps later. The field would be a select with one
 * option, so it is left to `/locations`, where the choice is real.
 */

const TIMEZONE_SELECT = ONBOARDING_TIMEZONES.map((zone) => ({
  value: zone.value,
  label: zone.label,
}));

const FIELD_LABELS: Record<string, string> = {
  name: "Location name",
  addressLine1: "Street address",
  city: "City",
  region: "State or region",
  postalCode: "Postal code",
  countryCode: "Country code",
  timezone: "Time zone",
};

export interface ExistingLocationSummary {
  id: string;
  name: string;
  city: string;
  region: string;
}

export function ManualLocationStep({
  organizationTimezone,
  existingLocations,
}: {
  organizationTimezone: string;
  existingLocations: readonly ExistingLocationSummary[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  const [name, setName] = useState("");
  const [addressLine1, setAddressLine1] = useState("");
  const [city, setCity] = useState("");
  const [region, setRegion] = useState("");
  const [postalCode, setPostalCode] = useState("");
  const [countryCode, setCountryCode] = useState("US");
  const [timezone, setTimezone] = useState(organizationTimezone);

  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const summaryRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (Object.keys(fieldErrors).length > 0) summaryRef.current?.focus();
  }, [fieldErrors]);

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (pending) return;

    setError(null);
    setFieldErrors({});

    startTransition(async () => {
      const result = await createOnboardingLocationAction({
        name,
        addressLine1,
        addressLine2: null,
        city,
        region,
        postalCode,
        // Uppercased here so somebody typing "us" is not told their country
        // code is invalid by a schema that only accepts uppercase.
        countryCode: countryCode.trim().toUpperCase(),
        timezone,
        status: "setup",
        managerUserId: null,
      });

      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }

      router.push(result.data.nextPath);
    });
  }

  function skip() {
    if (pending) return;
    setError(null);
    startTransition(async () => {
      const result = await skipOnboardingLocationsAction();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.push(result.data.nextPath);
    });
  }

  return (
    <form onSubmit={submit} noValidate className="flex flex-col gap-6">
      <OnboardingCard className="flex flex-col gap-6">
        <OnboardingStepHeader
          icon={MapPin}
          title="Add your first location"
          description="No source is connected, so Lia cannot discover your locations from Google. Add one by hand and you can connect a source at any time."
        />

        <div ref={summaryRef} tabIndex={-1} className="focus:outline-none">
          <OnboardingErrorSummary errors={fieldErrors} labels={FIELD_LABELS} />
        </div>

        {existingLocations.length > 0 ? (
          <div className="rounded-xl border border-site-border bg-site-tint px-4 py-3">
            <p className="text-[13px] font-semibold text-site-ink">
              Already in Lia
            </p>
            <ul className="mt-1.5 flex flex-col gap-0.5">
              {existingLocations.map((location) => (
                <li key={location.id} className="text-[12.5px] text-site-body">
                  {location.name}
                  {location.city ? ` — ${location.city}, ${location.region}` : ""}
                </li>
              ))}
            </ul>
            <p className="mt-2 text-[12px] text-site-muted">
              You can continue with these and skip adding another.
            </p>
          </div>
        ) : null}

        <div className="flex flex-col gap-5">
          <OnboardingTextField
            id="name"
            label="Location name"
            required
            maxLength={160}
            value={name}
            onChange={(event) => setName(event.target.value)}
            hint="What your team calls this site."
            error={fieldErrors.name}
          />

          <OnboardingTextField
            id="addressLine1"
            label="Street address"
            required
            autoComplete="address-line1"
            maxLength={200}
            value={addressLine1}
            onChange={(event) => setAddressLine1(event.target.value)}
            error={fieldErrors.addressLine1}
          />

          <div className="grid gap-5 sm:grid-cols-2">
            <OnboardingTextField
              id="city"
              label="City"
              required
              autoComplete="address-level2"
              maxLength={120}
              value={city}
              onChange={(event) => setCity(event.target.value)}
              error={fieldErrors.city}
            />
            <OnboardingTextField
              id="region"
              label="State or region"
              required
              autoComplete="address-level1"
              maxLength={120}
              value={region}
              onChange={(event) => setRegion(event.target.value)}
              error={fieldErrors.region}
            />
          </div>

          <div className="grid gap-5 sm:grid-cols-2">
            <OnboardingTextField
              id="postalCode"
              label="Postal code"
              required
              autoComplete="postal-code"
              maxLength={32}
              value={postalCode}
              onChange={(event) => setPostalCode(event.target.value)}
              error={fieldErrors.postalCode}
            />
            <OnboardingTextField
              id="countryCode"
              label="Country code"
              required
              autoComplete="country"
              maxLength={2}
              value={countryCode}
              onChange={(event) => setCountryCode(event.target.value)}
              hint="Two letters, such as US or GB."
              error={fieldErrors.countryCode}
            />
          </div>

          <OnboardingSelectField
            id="timezone"
            label="Time zone"
            required
            options={TIMEZONE_SELECT}
            value={timezone}
            onChange={(event) => setTimezone(event.target.value)}
            hint="Used to report when feedback arrives and how quickly you replied."
            error={fieldErrors.timezone}
          />
        </div>

        <OnboardingNote title="You can add a manager later">
          Assigning someone to a location needs a teammate to assign, and you invite
          your team on the next-but-one step. Managers are set from the locations
          screen once they have joined.
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
          secondary={
            <SecondaryLink href="/onboarding/connect-sources">Back</SecondaryLink>
          }
          tertiary={
            <TertiaryAction type="button" disabled={pending} onClick={skip}>
              Skip for now
            </TertiaryAction>
          }
        />
      </OnboardingCard>
    </form>
  );
}
