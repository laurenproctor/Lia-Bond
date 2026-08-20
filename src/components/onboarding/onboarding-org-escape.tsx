"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ChevronsUpDown, Loader2 } from "lucide-react";
import { switchOrganizationAction } from "@/app/actions/organization";
import type { OrganizationMembership } from "@/domain";

/**
 * A way out of the wizard, for somebody who has somewhere else to be.
 *
 * Onboarding deliberately has no navigation: the counts would read zero and a
 * sidebar of empty screens is a worse first impression than no sidebar. That
 * reasoning was written when an account could only ever hold one organization,
 * and it was right then — being held in setup for your only workspace is the
 * point.
 *
 * It stopped being right when organizations became creatable from inside the
 * product. Creating a second one makes it active, `redirectIfOnboarding` then
 * diverts its owner into this wizard, and every product route bounces back to
 * it — so a person with three working organizations could be locked out of all
 * of them by the fourth one they made. Even `/organizations/new`'s "Back to
 * Lia" link led to `/overview`, which redirected straight back here. The only
 * escapes were finishing five steps or clearing a cookie.
 *
 * So this renders **only when there is genuinely somewhere else to go** — more
 * than one membership — and nowhere else. A single-organization signup, which
 * is still the common path, sees exactly what it saw before.
 *
 * Progress is not lost by leaving: `organization_onboarding` is a row per
 * organization, and the guard resumes from the per-outcome timestamps. Coming
 * back lands on the same step.
 */
export function OnboardingOrgEscape({
  organizations,
  activeOrganizationId,
}: {
  organizations: OrganizationMembership[];
  activeOrganizationId: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  const others = organizations.filter(
    (entry) => entry.organization.id !== activeOrganizationId,
  );
  if (others.length === 0) return null;

  function leaveFor(organizationId: string) {
    setError(null);
    startTransition(async () => {
      const result = await switchOrganizationAction({ organizationId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      router.push("/overview");
    });
  }

  return (
    <div className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="listbox"
        onClick={() => setOpen((value) => !value)}
        className="inline-flex items-center gap-1.5 rounded-lg border border-site-border bg-white px-3 py-1.5 text-[13px] font-medium text-site-body transition-colors hover:text-site-ink"
      >
        {pending ? (
          <Loader2 className="size-4 animate-spin" aria-hidden />
        ) : (
          <ChevronsUpDown className="size-4 text-site-muted" aria-hidden />
        )}
        Switch organization
      </button>

      {open ? (
        <div className="absolute top-full right-0 z-30 mt-1.5 w-[min(18rem,calc(100vw-2rem))] overflow-hidden rounded-xl border border-site-border bg-white shadow-lg">
          <p className="px-3 pt-3 pb-1 text-[11px] font-semibold tracking-wide text-site-muted uppercase">
            Continue in
          </p>
          <ul role="listbox" aria-label="Organization" className="max-h-64 overflow-y-auto pb-1.5">
            {others.map((entry) => (
              <li key={entry.organization.id}>
                <button
                  type="button"
                  role="option"
                  aria-selected={false}
                  disabled={pending}
                  onClick={() => leaveFor(entry.organization.id)}
                  className="block w-full truncate px-3 py-2 text-left text-[13px] text-site-ink hover:bg-site-tint disabled:opacity-60"
                >
                  {entry.organization.name}
                </button>
              </li>
            ))}
          </ul>
          <p className="border-t border-site-border px-3 py-2 text-[12px] text-site-muted">
            Setup here is saved. You can come back to it any time.
          </p>
          {error ? (
            <p role="alert" className="border-t border-site-border px-3 py-2 text-[12px] text-red-600">
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
