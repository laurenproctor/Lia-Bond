"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { createLocationAction } from "@/app/actions/locations";
import {
  LocationFields,
  NO_MANAGER,
  type LocationFieldValues,
  type LocationMemberOption,
} from "@/components/locations/location-fields";
import { Button } from "@/components/ui/button";

/**
 * The manual-creation form.
 *
 * `slug` and `status` are carried in state but never rendered in create mode:
 * the repository derives the slug, and the action writes `setup` itself. They
 * exist here only because `LocationFieldValues` is one shape for both forms.
 */
export function CreateLocationForm({
  members,
  defaultTimezone,
}: {
  members: LocationMemberOption[];
  /** The organization's own default, so the common case needs no thought. */
  defaultTimezone: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const [values, setValues] = useState<LocationFieldValues>({
    name: "",
    slug: "",
    addressLine1: "",
    addressLine2: "",
    city: "",
    region: "",
    postalCode: "",
    countryCode: "US",
    timezone: defaultTimezone,
    status: "setup",
    managerUserId: NO_MANAGER,
  });

  function update<K extends keyof LocationFieldValues>(
    field: K,
    value: LocationFieldValues[K],
  ) {
    setValues((current) => ({ ...current, [field]: value }));
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});

    startTransition(async () => {
      const result = await createLocationAction({
        name: values.name,
        addressLine1: values.addressLine1,
        // The schema takes null for "not given", not an empty string.
        addressLine2: values.addressLine2.trim() === "" ? null : values.addressLine2,
        city: values.city,
        region: values.region,
        postalCode: values.postalCode,
        countryCode: values.countryCode,
        timezone: values.timezone,
        managerUserId: values.managerUserId === NO_MANAGER ? null : values.managerUserId,
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
    <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
      <LocationFields
        mode="create"
        values={values}
        members={members}
        fieldErrors={fieldErrors}
        disabled={pending}
        onChange={update}
      />

      {error ? (
        <p role="alert" className="text-[13px] text-red-600">
          {error}
        </p>
      ) : null}

      <div className="flex items-center gap-3">
        <Button type="submit" variant="primary" disabled={pending}>
          {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
          {pending ? "Adding…" : "Add location"}
        </Button>
        <p className="text-[12.5px] text-gray-500">
          It will start in onboarding. Move it to active once its profiles are
          connected.
        </p>
      </div>
    </form>
  );
}
