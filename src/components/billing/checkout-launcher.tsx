"use client";

import { useId, useState, useTransition } from "react";
import { AlertTriangle, CreditCard } from "lucide-react";
import { startBillingCheckoutAction } from "@/app/actions/billing";
import { Button } from "@/components/ui/button";
import { chargeInCents, formatCents } from "@/lib/billing/catalog";
import { LOCATION_CHOICES, LISTED_LOCATION_LIMIT } from "@/lib/pricing/schedule";
import type { BillingPeriod } from "@/lib/pricing/schedule";

/**
 * Choose a plan, see exactly what will be charged and when, then go to Stripe.
 *
 * The whole disclosure is rendered **before** the button, from the same
 * `chargeInCents` the catalog builds Stripe's tiers from, so the figure on
 * this screen and the figure on the invoice cannot disagree. Card networks
 * require a trial's terms to be clear before the card is handed over; this is
 * where Lia satisfies that, rather than relying on Stripe's page to do it.
 *
 * Four things are always on screen for a trial, and none of them is in small
 * print: how long the trial runs, the exact date of the first charge, the
 * exact amount, and that it renews automatically unless cancelled.
 *
 * The server decides whether a trial applies at all — `trialEligible` here is
 * a *hint for rendering*, resolved on the server and passed down. The action
 * re-reads it from the projection and would refuse a trial to an ineligible
 * organization however this component was persuaded to render.
 */

export interface CheckoutLauncherProps {
  /** Server-resolved. Rendering only — the action decides for real. */
  trialEligible: boolean;
  trialDays: number;
  /** Locations already in use, so the picker cannot start below them. */
  billableLocations: number;
  /** The date the first charge would land, if a trial starts now. */
  firstChargeDate: string;
}

export function CheckoutLauncher({
  trialEligible,
  trialDays,
  billableLocations,
  firstChargeDate,
}: CheckoutLauncherProps) {
  const periodId = useId();
  const quantityId = useId();

  const [period, setPeriod] = useState<BillingPeriod>("annual");
  const [quantity, setQuantity] = useState(Math.max(1, billableLocations));
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const total = chargeInCents(period, quantity);
  const cadence = period === "annual" ? "a year" : "a month";

  // Never below what the organization already runs: buying three seats for
  // five restaurants is a purchase that cannot be honoured, and the server
  // refuses it. Offering it here and failing afterwards would be worse.
  const choices = LOCATION_CHOICES.filter(
    (choice) => choice >= Math.max(1, billableLocations) && choice <= LISTED_LOCATION_LIMIT,
  );

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await startBillingCheckoutAction({
        interval: period,
        locationQuantity: quantity,
      });

      if (!result.ok) {
        setError(result.error);
        return;
      }

      // A full navigation, not a router push: the destination is Stripe.
      window.location.assign(result.data.url);
    });
  }

  return (
    <div className="flex flex-col gap-4">
      <fieldset className="flex flex-col gap-2">
        <legend id={periodId} className="text-[13px] font-medium text-gray-700">
          Billing period
        </legend>
        <div className="flex gap-2" role="radiogroup" aria-labelledby={periodId}>
          {(["annual", "monthly"] as const).map((option) => (
            <button
              key={option}
              type="button"
              role="radio"
              aria-checked={period === option}
              onClick={() => setPeriod(option)}
              className={
                period === option
                  ? "h-9 rounded-lg border border-purple-600 bg-purple-100 px-3 text-[13px] font-medium text-purple-600"
                  : "h-9 rounded-lg border border-gray-300 bg-white px-3 text-[13px] font-medium text-gray-700 hover:bg-gray-50"
              }
            >
              {option === "annual" ? "Annual — 2 months free" : "Monthly"}
            </button>
          ))}
        </div>
      </fieldset>

      <div className="flex flex-col gap-2">
        <label htmlFor={quantityId} className="text-[13px] font-medium text-gray-700">
          Locations
        </label>
        <select
          id={quantityId}
          value={quantity}
          onChange={(event) => setQuantity(Number(event.target.value))}
          className="h-9 w-full max-w-[220px] rounded-lg border border-gray-300 bg-white px-2.5 text-[13px] text-gray-950"
        >
          {choices.map((choice) => (
            <option key={choice} value={choice}>
              {choice === 1 ? "1 location" : `${choice} locations`}
            </option>
          ))}
        </select>
        {billableLocations > 0 ? (
          <p className="text-[12.5px] text-gray-500">
            This organization has {billableLocations}{" "}
            {billableLocations === 1 ? "location" : "locations"} in use, so you cannot
            buy fewer than that.
          </p>
        ) : null}
      </div>

      {/* The disclosure. Deliberately above the button and in body type. */}
      <div className="rounded-lg border border-gray-200 bg-gray-50 p-4">
        <dl className="grid gap-2 text-[13px]">
          {trialEligible ? (
            <div className="flex justify-between gap-3">
              <dt className="text-gray-500">Free trial</dt>
              <dd className="font-medium text-gray-950">{trialDays} days</dd>
            </div>
          ) : null}
          <div className="flex justify-between gap-3">
            <dt className="text-gray-500">
              {trialEligible ? "First charge" : "Charged"}
            </dt>
            <dd className="font-medium text-gray-950">
              {trialEligible ? firstChargeDate : "Today"}
            </dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-gray-500">Amount</dt>
            <dd className="font-medium text-gray-950">
              {formatCents(total)} {cadence}
            </dd>
          </div>
        </dl>

        <p className="mt-3 text-[12.5px] leading-[1.5] text-gray-700">
          {trialEligible ? (
            <>
              Your card is collected now and charged nothing today. On{" "}
              {firstChargeDate} the subscription begins and{" "}
              <strong className="font-semibold">{formatCents(total)}</strong> is charged
              automatically, then once {cadence} after that. Cancel any time before{" "}
              {firstChargeDate} and you will not be charged.
            </>
          ) : (
            <>
              <strong className="font-semibold">{formatCents(total)}</strong> is charged
              today and automatically once {cadence} after that. Cancel any time; access
              continues to the end of the period you have paid for.
            </>
          )}
        </p>
      </div>

      {error ? (
        <p
          role="alert"
          className="flex items-start gap-2 rounded-lg border border-red-600/20 bg-red-100 p-3 text-[13px] text-red-600"
        >
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
          {error}
        </p>
      ) : null}

      <div>
        <Button variant="primary" size="lg" icon={CreditCard} onClick={submit} disabled={pending}>
          {pending
            ? "Opening Stripe…"
            : trialEligible
              ? `Start ${trialDays}-day free trial`
              : "Subscribe"}
        </Button>
        <p className="mt-2 text-[12.5px] text-gray-500">
          Payment is handled by Stripe. Lia never sees your card details.
        </p>
      </div>
    </div>
  );
}
