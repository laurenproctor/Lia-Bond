"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { updateLocationAction } from "@/app/actions/locations";
import {
  LocationFields,
  NO_MANAGER,
  type LocationFieldValues,
  type LocationMemberOption,
} from "@/components/locations/location-fields";
import { Button } from "@/components/ui/button";
import type { Location } from "@/domain";

/** A location's current values as the form holds them. */
function valuesOf(location: Location): LocationFieldValues {
  return {
    name: location.name,
    slug: location.slug,
    addressLine1: location.addressLine1,
    addressLine2: location.addressLine2 ?? "",
    city: location.city,
    region: location.region,
    postalCode: location.postalCode,
    countryCode: location.countryCode,
    timezone: location.timezone,
    status: location.status,
    managerUserId: location.managerUserId ?? NO_MANAGER,
  };
}

export function EditLocationForm({
  location,
  members,
}: {
  location: Location;
  members: LocationMemberOption[];
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [values, setValues] = useState<LocationFieldValues>(() => valuesOf(location));

  function update<K extends keyof LocationFieldValues>(
    field: K,
    value: LocationFieldValues[K],
  ) {
    setSaved(false);
    setValues((current) => ({ ...current, [field]: value }));
  }

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldErrors({});
    setSaved(false);

    startTransition(async () => {
      const result = await updateLocationAction({
        locationId: location.id,
        name: values.name,
        slug: values.slug,
        addressLine1: values.addressLine1,
        addressLine2: values.addressLine2.trim() === "" ? null : values.addressLine2,
        city: values.city,
        region: values.region,
        postalCode: values.postalCode,
        countryCode: values.countryCode,
        timezone: values.timezone,
        status: values.status,
        managerUserId: values.managerUserId === NO_MANAGER ? null : values.managerUserId,
      });

      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }

      setSaved(true);
      // The header shows the name and the status badge, and the list behind
      // this page shows both too.
      router.refresh();
    });
  }

  return (
    <form onSubmit={submit} className="flex flex-col gap-5" noValidate>
      <LocationFields
        mode="edit"
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
          {pending ? "Saving…" : "Save changes"}
        </Button>
        {saved ? (
          <p role="status" className="text-[13px] text-green-700">
            Saved
          </p>
        ) : null}
      </div>
    </form>
  );
}
