"use client";

import { useId, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Loader2 } from "lucide-react";
import { createOrganizationAction } from "@/app/actions/organization";
import { cn } from "@/lib/cn";

/**
 * The one field, and the guard against creating two organizations by accident.
 *
 * `requestKey` is generated once when the form mounts and sent with every
 * submission from it. A double-click, an impatient second press, or a retry
 * after a failed request all carry the same key, and the second call returns the
 * organization the first one created rather than making another — the database
 * decides that on the insert itself, where a unique index is the lock. A fresh
 * page load gets a new key, because that is somebody deliberately creating a
 * second organization.
 *
 * The disabled state below is a courtesy, not the guarantee. Two clicks on a
 * serverless deployment are routinely two processes, and a button cannot
 * serialise them.
 */
export function CreateOrganizationForm({ className }: { className?: string }) {
  const router = useRouter();
  const nameId = useId();
  const errorId = useId();

  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // `useRef` rather than `useState`: this must not change between renders, and
  // nothing renders it.
  const requestKey = useRef<string>(crypto.randomUUID());

  function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    setFieldError(null);

    startTransition(async () => {
      const result = await createOrganizationAction({
        name,
        requestKey: requestKey.current,
      });

      if (!result.ok) {
        setError(result.error);
        setFieldError(result.fieldErrors?.name ?? null);
        return;
      }

      router.push(result.data.nextPath);
    });
  }

  const message = fieldError ?? error;

  return (
    <form onSubmit={submit} className={cn("flex flex-col gap-4", className)} noValidate>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={nameId} className="text-[13px] font-medium text-site-ink">
          Organization name
        </label>
        <input
          id={nameId}
          name="name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          maxLength={160}
          autoComplete="organization"
          autoFocus
          placeholder="Union Square Hospitality Group"
          aria-invalid={message ? true : undefined}
          aria-describedby={message ? errorId : undefined}
          className={cn(
            "h-11 rounded-lg border bg-white px-3 text-[14px] text-site-ink placeholder:text-site-muted/70",
            message ? "border-red-400" : "border-site-border",
          )}
        />
        <p className="text-[12.5px] text-site-muted">
          You can change this later in settings.
        </p>
      </div>

      {message ? (
        <p id={errorId} role="alert" className="text-[13px] text-red-600">
          {message}
        </p>
      ) : null}

      <button
        type="submit"
        disabled={pending || name.trim().length === 0}
        className="inline-flex h-11 items-center justify-center gap-2 rounded-lg bg-site-ink px-4 text-[14px] font-semibold text-white transition-opacity disabled:opacity-60"
      >
        {pending ? <Loader2 className="size-4 animate-spin" aria-hidden /> : null}
        {pending ? "Creating…" : "Create organization"}
      </button>
    </form>
  );
}
