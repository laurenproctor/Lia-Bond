"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Save } from "lucide-react";
import { updateOrganizationAction } from "@/app/actions/organization-settings";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";

/**
 * Owners and admins editing the organization's details in place.
 *
 * Rendered only for holders of `organization.update` — the settings page keeps
 * the read-only card for everyone else, so this client island never ships to
 * a viewer. Field errors land under their fields; the slug's uniqueness
 * conflict arrives the same way, mapped by the repository.
 */

const INPUT_CLASS =
  "h-10 w-full rounded-[10px] border border-gray-300 bg-white px-3 text-[13.5px] text-gray-950 outline-none focus-visible:border-purple-600 focus-visible:ring-2 focus-visible:ring-purple-600/20";

const FIELDS = [
  { name: "name", label: "Name", autoComplete: "organization" },
  { name: "slug", label: "Slug", hint: "Must be unique. Appears in support correspondence." },
  { name: "industry", label: "Industry" },
  { name: "websiteUrl", label: "Website", placeholder: "https://" },
  { name: "defaultTimezone", label: "Default timezone" },
  { name: "defaultLanguage", label: "Default language" },
] as const;

export function OrganizationPanel({
  organization,
}: {
  organization: {
    name: string;
    slug: string;
    industry: string;
    websiteUrl: string | null;
    defaultTimezone: string;
    defaultLanguage: string;
  };
}) {
  const router = useRouter();
  const idPrefix = useId();

  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit(formData: FormData) {
    setError(null);
    setFieldErrors({});
    setSaved(false);

    startTransition(async () => {
      const result = await updateOrganizationAction({
        name: formData.get("name"),
        slug: formData.get("slug"),
        industry: formData.get("industry"),
        websiteUrl: formData.get("websiteUrl"),
        defaultTimezone: formData.get("defaultTimezone"),
        defaultLanguage: formData.get("defaultLanguage"),
      });

      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }

      setSaved(true);
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader
        title="Organization details"
        description="Used as the default for every location."
      />

      <form action={submit} className="mt-4 flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          {FIELDS.map((field) => (
            <div key={field.name} className="flex flex-col gap-1.5">
              <label
                htmlFor={`${idPrefix}-${field.name}`}
                className="text-[13px] font-medium text-gray-950"
              >
                {field.label}
              </label>
              <input
                id={`${idPrefix}-${field.name}`}
                name={field.name}
                defaultValue={organization[field.name] ?? ""}
                required={field.name !== "websiteUrl"}
                autoComplete={"autoComplete" in field ? field.autoComplete : undefined}
                placeholder={"placeholder" in field ? field.placeholder : undefined}
                aria-describedby={
                  "hint" in field ? `${idPrefix}-${field.name}-hint` : undefined
                }
                aria-invalid={field.name in fieldErrors || undefined}
                className={INPUT_CLASS}
              />
              {"hint" in field && !(field.name in fieldErrors) ? (
                <p
                  id={`${idPrefix}-${field.name}-hint`}
                  className="text-[12px] text-gray-500"
                >
                  {field.hint}
                </p>
              ) : null}
              {field.name in fieldErrors ? (
                <p role="alert" className="text-[12px] text-red-600">
                  {fieldErrors[field.name]}
                </p>
              ) : null}
            </div>
          ))}
        </div>

        {error ? (
          <p
            role="alert"
            className="flex items-start gap-1.5 rounded-lg border border-red-600/20 bg-red-100 px-3 py-2.5 text-[13px] text-gray-950"
          >
            <AlertTriangle className="mt-px size-4 shrink-0 text-red-600" aria-hidden />
            {error}
          </p>
        ) : null}

        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" icon={Save} disabled={pending}>
            {pending ? "Saving…" : "Save details"}
          </Button>
          {saved ? (
            <p role="status" className="text-[13px] text-green-700">
              Saved.
            </p>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
