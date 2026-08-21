"use client";

import { useId, useState, useTransition } from "react";
import { AlertTriangle, Building2 } from "lucide-react";
import {
  changeBillingCapacityAction,
  previewCapacityChangeAction,
} from "@/app/actions/billing";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";
import { DetailField } from "@/components/ui/detail-panel";
import { formatCents } from "@/lib/billing/catalog";
import { LISTED_LOCATION_LIMIT, LOCATION_CHOICES } from "@/lib/pricing/schedule";

/**
 * Purchased location capacity, and how to change it.
 *
 * Two steps, always. The preview is not an optional nicety — a customer
 * increasing capacity during a trial is charged nothing today and a larger
 * amount when the trial ends, and that is a sentence they have to read before
 * agreeing rather than discover on an invoice. The confirm button does not
 * appear until the preview has returned.
 *
 * Reductions below the number of locations actually in use are refused by the
 * server, and the picker does not offer them either. Deactivating a location
 * is how capacity is freed, and the message says so rather than leaving
 * somebody to guess why the option is missing.
 */

export interface CapacityCardProps {
  purchased: number;
  billable: number;
  canManage: boolean;
}

interface Preview {
  quantity: number;
  amountDueCents: number;
  chargedAt: string | null;
  duringTrial: boolean;
}

export function CapacityCard({ purchased, billable, canManage }: CapacityCardProps) {
  const selectId = useId();
  const [quantity, setQuantity] = useState(purchased);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);
  const [pending, startTransition] = useTransition();

  const floor = Math.max(1, billable);
  const choices = LOCATION_CHOICES.filter(
    (choice) => choice >= floor && choice <= LISTED_LOCATION_LIMIT,
  );

  function requestPreview(next: number) {
    setQuantity(next);
    setPreview(null);
    setError(null);
    setDone(false);
    if (next === purchased) return;

    startTransition(async () => {
      const result = await previewCapacityChangeAction({ locationQuantity: next });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPreview(result.data);
    });
  }

  function confirm() {
    setError(null);
    startTransition(async () => {
      const result = await changeBillingCapacityAction({ locationQuantity: quantity });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setPreview(null);
      setDone(true);
    });
  }

  return (
    <Card>
      <CardHeader
        title="Location capacity"
        description="How many locations this subscription covers."
      />

      <dl className="mt-4 grid gap-4 sm:grid-cols-2">
        <DetailField label="Purchased">{purchased}</DetailField>
        <DetailField label="In use">
          {billable}
          {billable > purchased ? (
            <span className="ml-2 text-[12.5px] font-medium text-red-600">
              over capacity
            </span>
          ) : null}
        </DetailField>
      </dl>

      {canManage ? (
        <div className="mt-5 flex flex-col gap-3 border-t border-gray-200 pt-4">
          <label htmlFor={selectId} className="text-[13px] font-medium text-gray-700">
            Change capacity
          </label>
          <div className="flex flex-wrap items-center gap-2">
            <select
              id={selectId}
              value={quantity}
              onChange={(event) => requestPreview(Number(event.target.value))}
              disabled={pending}
              className="h-9 rounded-lg border border-gray-300 bg-white px-2.5 text-[13px] text-gray-950"
            >
              {choices.map((choice) => (
                <option key={choice} value={choice}>
                  {choice === 1 ? "1 location" : `${choice} locations`}
                </option>
              ))}
            </select>
            {preview ? (
              <Button variant="primary" icon={Building2} onClick={confirm} disabled={pending}>
                Confirm {preview.quantity}
              </Button>
            ) : null}
          </div>

          {billable > 0 ? (
            <p className="text-[12.5px] text-gray-500">
              You cannot go below {floor}. Deactivate a location first to free capacity.
            </p>
          ) : null}

          {preview ? (
            <p className="rounded-lg border border-gray-200 bg-gray-50 p-3 text-[13px] leading-[1.5] text-gray-700">
              {preview.duringTrial ? (
                <>
                  Nothing is charged today. Your first charge
                  {preview.chargedAt ? ` on ${preview.chargedAt}` : ""} becomes{" "}
                  <strong className="font-semibold">
                    {formatCents(preview.amountDueCents)}
                  </strong>
                  .
                </>
              ) : (
                <>
                  Your next invoice
                  {preview.chargedAt ? ` on ${preview.chargedAt}` : ""} becomes{" "}
                  <strong className="font-semibold">
                    {formatCents(preview.amountDueCents)}
                  </strong>
                  , adjusted for the part of the period already paid for.
                </>
              )}
            </p>
          ) : null}

          {done ? (
            <p className="text-[13px] text-gray-700">
              Capacity change sent to Stripe. This page updates as soon as Stripe
              confirms it — usually within a few seconds.
            </p>
          ) : null}

          {error ? (
            <p
              role="alert"
              className="flex items-start gap-2 rounded-lg border border-red-600/20 bg-red-100 p-3 text-[13px] text-red-600"
            >
              <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden />
              {error}
            </p>
          ) : null}
        </div>
      ) : null}
    </Card>
  );
}
