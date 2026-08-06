"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Save } from "lucide-react";
import { updateOwnProfileAction } from "@/app/actions/profile";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";

/**
 * Edit your own name.
 *
 * Initial values come from `public.users` (via the member list the settings
 * page already loads), not from session metadata — the profile row is what
 * member lists and audit attribution render, so it is the record being edited.
 *
 * Email is shown but not editable here: changing a sign-in address is a
 * credential change with its own confirmation flow, not a profile field.
 */

const INPUT_CLASS =
  "h-10 w-full rounded-[10px] border border-gray-300 bg-white px-3 text-[13.5px] text-gray-950 outline-none focus-visible:border-purple-600 focus-visible:ring-2 focus-visible:ring-purple-600/20";

export function ProfilePanel({
  firstName,
  lastName,
  email,
}: {
  firstName: string;
  lastName: string;
  email: string;
}) {
  const router = useRouter();
  const firstNameId = useId();
  const lastNameId = useId();

  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit(formData: FormData) {
    setError(null);
    setSaved(false);

    startTransition(async () => {
      const result = await updateOwnProfileAction({
        firstName: formData.get("firstName"),
        lastName: formData.get("lastName"),
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      setSaved(true);
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader
        title="Your profile"
        description={`How your name appears to your team. Signed in as ${email}.`}
      />

      <form action={submit} className="mt-4 flex flex-col gap-3">
        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={firstNameId}
              className="text-[13px] font-medium text-gray-950"
            >
              First name
            </label>
            <input
              id={firstNameId}
              name="firstName"
              defaultValue={firstName}
              required
              maxLength={80}
              autoComplete="given-name"
              className={INPUT_CLASS}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={lastNameId}
              className="text-[13px] font-medium text-gray-950"
            >
              Last name
            </label>
            <input
              id={lastNameId}
              name="lastName"
              defaultValue={lastName}
              required
              maxLength={80}
              autoComplete="family-name"
              className={INPUT_CLASS}
            />
          </div>
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
            {pending ? "Saving…" : "Save name"}
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
