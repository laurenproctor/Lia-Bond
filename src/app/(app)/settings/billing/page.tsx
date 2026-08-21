import type { Metadata } from "next";
import Link from "next/link";
import { PageBody } from "@/components/shell/app-shell";
import { BillingSyncNotice } from "@/components/billing/billing-sync-notice";
import { CapacityCard } from "@/components/billing/capacity-card";
import { CheckoutLauncher } from "@/components/billing/checkout-launcher";
import { PlanSummaryCard } from "@/components/billing/plan-summary-card";
import { PortalButton } from "@/components/billing/portal-button";
import { Card, CardHeader } from "@/components/ui/card";
import { PageHeader } from "@/components/ui/page-header";
import { TRIAL_PERIOD_DAYS } from "@/domain";
import { can } from "@/lib/auth/permissions";
import { firstChargeDate } from "@/lib/billing/catalog";
import { getBillingProjection, getEntitlement } from "@/lib/billing/context";
import { isBillingAvailable } from "@/lib/billing/registry";
import { loadBillingView } from "@/lib/billing/service";
import { getStripeGateway } from "@/lib/billing/registry";
import { getDataSource } from "@/lib/data";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";
import { formatBillingDate } from "@/lib/view-models/billing";

export const metadata: Metadata = { title: "Billing" };

/**
 * `/settings/billing` — the activation gate, and the place a billing problem
 * gets fixed.
 *
 * A child route of `/settings` rather than a tab on it, following the
 * precedent `/integrations/review-widget` set: `CLAUDE.md` fixes the top-level
 * route list and this is a child of one of them. A tab would have been wrong
 * anyway — this is the destination every banner in the product links to, and a
 * destination needs a URL.
 *
 * **This page is reachable in every entitlement state, including read-only.**
 * `billing.manage` is marked as not requiring paid access precisely so that
 * this route keeps working when everything else has stopped; an organization
 * that cannot reach its own billing cannot fix what is blocking it.
 *
 * The Checkout success redirect lands here with `?checkout=complete`, and it
 * grants nothing. It renders a synchronising notice until the webhook has
 * updated the projection, which is the only thing that ever changes access.
 */
export default async function BillingPage({
  searchParams,
}: {
  searchParams: Promise<{ checkout?: string }>;
}) {
  const [context, params] = await Promise.all([
    getOrganizationContext(),
    searchParams,
  ]);

  const canManage = can(context.role, "billing.manage");

  // Stripe not configured is a real, ordinary state — a fresh clone, or a
  // deployment nobody has set up yet — and it gets a plain explanation rather
  // than a crash. Everything below reads the projection, which exists whether
  // or not Stripe does.
  if (!isBillingAvailable()) {
    const billing = await getBillingProjection();
    const entitlement = await getEntitlement();

    return (
      <PageBody>
        <PageHeader
          title="Billing"
          description="Plan, payment, and location capacity."
        />
        <div className="grid gap-4 xl:grid-cols-12">
          <div className="flex flex-col gap-4 xl:col-span-7">
            <PlanSummaryCard
              billing={billing}
              entitlement={entitlement}
              chargeInCents={null}
            />
            <Card>
              <CardHeader
                title="Billing is not configured"
                description="This deployment has no Stripe credentials, so nothing can be purchased here."
              />
              <p className="mt-3 text-[13px] text-gray-700">
                Ask your administrator to configure Stripe. Nothing is charged and no
                access is restricted while billing is unconfigured.
              </p>
            </Card>
          </div>
        </div>
      </PageBody>
    );
  }

  const dataSource = await getDataSource();
  const [view, entitlement] = await Promise.all([
    loadBillingView({
      dataSource,
      scope: context.scope,
      gateway: getStripeGateway(),
      now: new Date().toISOString(),
    }),
    getEntitlement(),
  ]);

  const { billing, billableLocations, annualisedChargeInCents } = view;
  const hasSubscription = billing.subscriptionStatus !== null;

  return (
    <PageBody>
      <PageHeader title="Billing" description="Plan, payment, and location capacity." />

      {/* Never authoritative — see the module comment. */}
      <BillingSyncNotice
        checkoutState={params.checkout ?? null}
        hasSubscription={hasSubscription}
      />

      <div className="grid gap-4 xl:grid-cols-12">
        <div className="flex flex-col gap-4 xl:col-span-7">
          <PlanSummaryCard
            billing={billing}
            entitlement={entitlement}
            chargeInCents={annualisedChargeInCents}
          />

          {hasSubscription ? (
            <CapacityCard
              purchased={billing.purchasedLocationQuantity ?? 0}
              billable={billableLocations}
              canManage={canManage}
            />
          ) : null}
        </div>

        <div className="flex flex-col gap-4 xl:col-span-5">
          {!hasSubscription && canManage ? (
            <Card>
              <CardHeader
                title={billing.trialEligible ? "Start your free trial" : "Choose a plan"}
                description="Priced per location, and the rate falls as the group grows."
              />
              <div className="mt-4">
                <CheckoutLauncher
                  trialEligible={billing.trialEligible}
                  trialDays={TRIAL_PERIOD_DAYS}
                  billableLocations={billableLocations}
                  firstChargeDate={formatBillingDate(
                    firstChargeDate(new Date(), TRIAL_PERIOD_DAYS).toISOString(),
                  )}
                />
              </div>
            </Card>
          ) : null}

          {hasSubscription && canManage ? (
            <Card>
              <CardHeader
                title="Payment and invoices"
                description="Cards, billing address, receipts, and cancellation are handled by Stripe."
              />
              <div className="mt-4">
                <PortalButton
                  variant={entitlement.access === "full" ? "secondary" : "primary"}
                >
                  {entitlement.access === "full" ? "Manage billing" : "Fix payment"}
                </PortalButton>
              </div>
            </Card>
          ) : null}

          {!canManage ? (
            <Card>
              <CardHeader
                title="Your access"
                description="Billing is managed by owners and admins."
              />
              <p className="mt-3 text-[13px] text-gray-700">
                You can see the plan and what it covers. Ask an owner or admin to change
                the subscription or the payment method.
              </p>
            </Card>
          ) : null}

          <Card>
            <CardHeader
              title="More than 100 locations?"
              description="Above the listed range we quote to your portfolio."
            />
            <p className="mt-3 text-[13px] text-gray-700">
              <Link
                href="/contact"
                className="font-medium text-purple-600 underline underline-offset-2"
              >
                Talk to us
              </Link>{" "}
              and we will price it around the group you actually run.
            </p>
          </Card>
        </div>
      </div>
    </PageBody>
  );
}
