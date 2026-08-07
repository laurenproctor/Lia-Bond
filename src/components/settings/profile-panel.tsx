"use client";

import { useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Save } from "lucide-react";
import {
  removeOwnAvatarAction,
  updateOwnAvatarAction,
  updateOwnProfileAction,
} from "@/app/actions/profile";
import { Avatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { AVATAR_ACCEPT, reviewAvatarFile } from "@/lib/profile/avatar-file";
import { initialsFor } from "@/lib/view-models/mention";

/**
 * Edit your own name and photo.
 *
 * Initial values come from `public.users` (via the member list the settings
 * page already loads), not from session metadata — the profile row is what
 * member lists and audit attribution render, so it is the record being edited.
 *
 * Email is shown but not editable here: changing a sign-in address is a
 * credential change with its own confirmation flow, not a profile field.
 *
 * The photo uploads on file choice — there is nothing else to fill in, so a
 * separate save step would be ceremony.
 */

const INPUT_CLASS =
  "h-10 w-full rounded-[10px] border border-gray-300 bg-white px-3 text-[13.5px] text-gray-950 outline-none focus-visible:border-purple-600 focus-visible:ring-2 focus-visible:ring-purple-600/20";

export function ProfilePanel({
  firstName,
  lastName,
  email,
  avatarUrl,
}: {
  firstName: string;
  lastName: string;
  email: string;
  avatarUrl: string | null;
}) {
  const router = useRouter();
  const firstNameId = useId();
  const lastNameId = useId();

  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  const fileInputRef = useRef<HTMLInputElement>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [photoPending, startPhotoTransition] = useTransition();

  function choosePhoto(file: File | null) {
    if (!file) return;
    setPhotoError(null);

    // Same review the server runs — catches a wrong pick before the upload.
    const review = reviewAvatarFile(file);
    if (!review.ok) {
      setPhotoError(review.reason);
      return;
    }

    const formData = new FormData();
    formData.set("avatar", file);
    startPhotoTransition(async () => {
      const result = await updateOwnAvatarAction(formData);
      if (!result.ok) {
        setPhotoError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function removePhoto() {
    setPhotoError(null);
    startPhotoTransition(async () => {
      const result = await removeOwnAvatarAction();
      if (!result.ok) {
        setPhotoError(result.error);
        return;
      }
      router.refresh();
    });
  }

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

      <div className="mt-4 flex items-center gap-3">
        <Avatar
          initials={initialsFor(`${firstName} ${lastName}`.trim() || email)}
          imageUrl={avatarUrl}
          name="Your profile photo"
          size="lg"
        />
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={photoPending}
            onClick={() => fileInputRef.current?.click()}
          >
            {photoPending ? "Uploading…" : "Upload photo"}
          </Button>
          {avatarUrl ? (
            <Button
              type="button"
              variant="ghost"
              disabled={photoPending}
              onClick={removePhoto}
            >
              Remove
            </Button>
          ) : null}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept={AVATAR_ACCEPT}
          className="sr-only"
          aria-label="Choose a profile photo"
          onChange={(event) => {
            choosePhoto(event.target.files?.[0] ?? null);
            event.target.value = "";
          }}
        />
      </div>

      {photoError ? (
        <p
          role="alert"
          className="mt-3 flex items-start gap-1.5 rounded-lg border border-red-600/20 bg-red-100 px-3 py-2.5 text-[13px] text-gray-950"
        >
          <AlertTriangle className="mt-px size-4 shrink-0 text-red-600" aria-hidden />
          {photoError}
        </p>
      ) : null}

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
