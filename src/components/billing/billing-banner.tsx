import Link from "next/link";
import { AlertTriangle, Info } from "lucide-react";
import { billingBannerView } from "@/lib/view-models/billing";
import type { Entitlement } from "@/lib/billing/entitlement";
import type { OrganizationBilling } from "@/domain";

/**
 * The one line the shell carries about billing, or nothing at all.
 *
 * Nothing at all is the common case and the important one. An active
 * subscription with nothing wrong renders no banner, and neither does a trial
 * with more than a week left — a strip that is always there is furniture, and
 * furniture is what people stop reading before the day it matters.
 *
 * A server component, so the entitlement is resolved once per request by the
 * layout that renders it rather than fetched again in the browser.
 */

const TONE_STYLES = {
  info: "border-blue-600/20 bg-blue-100 text-blue-600",
  warning: "border-amber-600/20 bg-amber-100 text-amber-600",
  danger: "border-red-600/20 bg-red-100 text-red-600",
} as const;

export function BillingBanner({
  entitlement,
  billing,
}: {
  entitlement: Entitlement;
  billing: OrganizationBilling;
}) {
  const view = billingBannerView(entitlement, billing);
  if (!view) return null;

  const Icon = view.tone === "info" ? Info : AlertTriangle;

  return (
    <div
      // `status` rather than `alert`: this is standing information a person
      // navigates to when ready, not something that should interrupt whatever
      // a screen reader is in the middle of saying.
      role="status"
      className={`flex flex-wrap items-center justify-between gap-3 border-b px-6 py-2.5 text-[13px] ${TONE_STYLES[view.tone]}`}
    >
      <span className="flex items-center gap-2">
        <Icon className="size-4 shrink-0" aria-hidden />
        {view.message}
      </span>
      <Link
        href="/settings/billing"
        className="shrink-0 font-medium underline underline-offset-2"
      >
        {view.actionLabel}
      </Link>
    </div>
  );
}
