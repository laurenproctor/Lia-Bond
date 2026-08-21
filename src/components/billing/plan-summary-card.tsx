import { Badge } from "@/components/ui/badge";
import { Card, CardHeader } from "@/components/ui/card";
import { DetailField } from "@/components/ui/detail-panel";
import { formatCents } from "@/lib/billing/catalog";
import {
  billingHeadline,
  billingStatusView,
  formatBillingDate,
  trialCountdownLabel,
  trialCountdownTone,
} from "@/lib/view-models/billing";
import type { Entitlement } from "@/lib/billing/entitlement";
import type { OrganizationBilling } from "@/domain";

/**
 * What plan this organization is on, and what happens next.
 *
 * Every date and amount comes from the view model, which is pure and tested,
 * so the sentence a customer reads here is the same one a test asserts. The
 * card renders for every state including the ones with no subscription at all
 * — "no plan yet" is information, and an empty card would be a bug report.
 */

const INTERVAL_LABELS = { month: "Monthly", year: "Annual" } as const;

export function PlanSummaryCard({
  billing,
  entitlement,
  chargeInCents,
}: {
  billing: OrganizationBilling;
  entitlement: Entitlement;
  chargeInCents: number | null;
}) {
  const status = billingStatusView(entitlement);
  const countdown =
    entitlement.reason === "trialing"
      ? trialCountdownLabel(entitlement.trialDaysRemaining)
      : null;

  return (
    <Card>
      <CardHeader
        title="Plan"
        description="What this organization is subscribed to."
        actions={
          <span className="flex items-center gap-2">
            {countdown ? (
              <Badge tone={trialCountdownTone(entitlement.trialDaysRemaining)}>
                {countdown}
              </Badge>
            ) : null}
            <Badge tone={status.tone}>{status.label}</Badge>
          </span>
        }
      />

      <p className="mt-3 text-[13.5px] leading-[1.55] text-gray-700">
        {billingHeadline(entitlement, billing, chargeInCents)}
      </p>

      {billing.subscriptionStatus ? (
        <dl className="mt-5 grid gap-4 border-t border-gray-200 pt-4 sm:grid-cols-2">
          <DetailField label="Billing period">
            {billing.billingInterval ? INTERVAL_LABELS[billing.billingInterval] : "—"}
          </DetailField>
          <DetailField label="Amount">
            {chargeInCents === null ? "—" : formatCents(chargeInCents)}
          </DetailField>
          {billing.trialEnd && entitlement.reason === "trialing" ? (
            <DetailField label="First charge">
              {formatBillingDate(billing.trialEnd)}
            </DetailField>
          ) : null}
          {billing.currentPeriodEnd && entitlement.reason !== "trialing" ? (
            <DetailField label={billing.cancelAtPeriodEnd ? "Access until" : "Renews"}>
              {formatBillingDate(billing.currentPeriodEnd)}
            </DetailField>
          ) : null}
          {billing.lastPaymentFailureAt && !billing.lastPaidAt ? (
            <DetailField label="Last payment attempt">
              {formatBillingDate(billing.lastPaymentFailureAt)} — failed
            </DetailField>
          ) : null}
        </dl>
      ) : null}
    </Card>
  );
}
