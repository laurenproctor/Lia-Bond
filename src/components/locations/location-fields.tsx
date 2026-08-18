"use client";

import { useId } from "react";
import { ChevronDown } from "lucide-react";
import { LOCATION_STATUSES, ONBOARDING_TIMEZONES, type LocationStatus } from "@/domain";
import { cn } from "@/lib/cn";
import { LOCATION_STATUS_LABELS } from "@/lib/labels";

/**
 * The fields both location forms render.
 *
 * Shared with `/locations/new` and `/locations/[locationId]`, and deliberately
 * **not** with onboarding's manual-location step. That one lives outside the app
 * shell on the marketing brand and this is a product screen inside it — the same
 * split the brand-voice preview makes (D178). What the two share is the schema
 * and the repository method, which is where sharing actually prevents drift; the
 * markup is different on purpose.
 *
 * `mode` decides two fields rather than the layout:
 *
 * - **slug** is edit-only. On creation the repository derives it from the name
 *   and de-duplicates within the organization, so asking somebody to invent a
 *   URL fragment for a restaurant they are still typing the name of is a field
 *   that can only be got wrong.
 * - **status** is edit-only for a stronger reason: a manually created location
 *   always starts `setup`, and `createManualLocationInputSchema` has no status
 *   field at all. A control here would offer a choice the schema would discard.
 */

export interface LocationMemberOption {
  userId: string;
  fullName: string;
  /** False for suspended and invited memberships. */
  isActive: boolean;
}

export interface LocationFieldValues {
  name: string;
  slug: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  region: string;
  postalCode: string;
  countryCode: string;
  timezone: string;
  status: LocationStatus;
  managerUserId: string;
}

const INPUT_CLASS =
  "h-10 w-full rounded-[10px] border border-gray-300 bg-white px-3 text-[13.5px] text-gray-950 outline-none focus-visible:border-purple-600 focus-visible:ring-2 focus-visible:ring-purple-600/20 disabled:bg-gray-50 disabled:text-gray-500";

const SELECT_CLASS = cn(INPUT_CLASS, "appearance-none pr-8");

/** Unassigned is a real choice, and the empty string is how a select carries it. */
export const NO_MANAGER = "";

export function LocationFields({
  mode,
  values,
  members,
  fieldErrors,
  disabled = false,
  onChange,
}: {
  mode: "create" | "edit";
  values: LocationFieldValues;
  members: LocationMemberOption[];
  fieldErrors?: Record<string, string>;
  disabled?: boolean;
  onChange: <K extends keyof LocationFieldValues>(
    field: K,
    value: LocationFieldValues[K],
  ) => void;
}) {
  const prefix = useId();
  const fieldId = (name: string) => `${prefix}-${name}`;
  const errorOf = (name: string) => fieldErrors?.[name];

  // A suspended person keeps any assignment they already hold — the trigger
  // validates on assignment and never on suspension — so the current manager
  // has to remain visible here even when they are no longer selectable. Shown
  // as a disabled option rather than silently dropped: dropping them would make
  // the form look like nobody manages this restaurant, and saving would then
  // quietly unassign them.
  const active = members.filter((member) => member.isActive);
  const suspendedCurrent =
    values.managerUserId !== NO_MANAGER &&
    !active.some((member) => member.userId === values.managerUserId)
      ? members.find((member) => member.userId === values.managerUserId)
      : undefined;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field
          id={fieldId("name")}
          label="Name"
          error={errorOf("name")}
          className="sm:col-span-2"
        >
          <input
            id={fieldId("name")}
            className={INPUT_CLASS}
            value={values.name}
            disabled={disabled}
            maxLength={160}
            autoComplete="off"
            aria-invalid={errorOf("name") ? true : undefined}
            aria-describedby={errorOf("name") ? `${fieldId("name")}-error` : undefined}
            onChange={(event) => onChange("name", event.target.value)}
          />
        </Field>

        {mode === "edit" ? (
          <Field
            id={fieldId("slug")}
            label="Address slug"
            hint="Unique within this organization. Two organizations may both use “soho”."
            error={errorOf("slug")}
            className="sm:col-span-2"
          >
            <input
              id={fieldId("slug")}
              className={INPUT_CLASS}
              value={values.slug}
              disabled={disabled}
              maxLength={80}
              autoComplete="off"
              aria-invalid={errorOf("slug") ? true : undefined}
              aria-describedby={errorOf("slug") ? `${fieldId("slug")}-error` : undefined}
              onChange={(event) => onChange("slug", event.target.value)}
            />
          </Field>
        ) : null}

        <Field
          id={fieldId("addressLine1")}
          label="Address"
          error={errorOf("addressLine1")}
          className="sm:col-span-2"
        >
          <input
            id={fieldId("addressLine1")}
            className={INPUT_CLASS}
            value={values.addressLine1}
            disabled={disabled}
            maxLength={200}
            autoComplete="address-line1"
            aria-invalid={errorOf("addressLine1") ? true : undefined}
            onChange={(event) => onChange("addressLine1", event.target.value)}
          />
        </Field>

        <Field
          id={fieldId("addressLine2")}
          label="Address line 2"
          hint="Optional."
          error={errorOf("addressLine2")}
          className="sm:col-span-2"
        >
          <input
            id={fieldId("addressLine2")}
            className={INPUT_CLASS}
            value={values.addressLine2}
            disabled={disabled}
            maxLength={200}
            autoComplete="address-line2"
            onChange={(event) => onChange("addressLine2", event.target.value)}
          />
        </Field>

        <Field id={fieldId("city")} label="City" error={errorOf("city")}>
          <input
            id={fieldId("city")}
            className={INPUT_CLASS}
            value={values.city}
            disabled={disabled}
            maxLength={120}
            autoComplete="address-level2"
            aria-invalid={errorOf("city") ? true : undefined}
            onChange={(event) => onChange("city", event.target.value)}
          />
        </Field>

        <Field id={fieldId("region")} label="State or region" error={errorOf("region")}>
          <input
            id={fieldId("region")}
            className={INPUT_CLASS}
            value={values.region}
            disabled={disabled}
            maxLength={120}
            autoComplete="address-level1"
            aria-invalid={errorOf("region") ? true : undefined}
            onChange={(event) => onChange("region", event.target.value)}
          />
        </Field>

        <Field id={fieldId("postalCode")} label="Postal code" error={errorOf("postalCode")}>
          <input
            id={fieldId("postalCode")}
            className={INPUT_CLASS}
            value={values.postalCode}
            disabled={disabled}
            maxLength={32}
            autoComplete="postal-code"
            aria-invalid={errorOf("postalCode") ? true : undefined}
            onChange={(event) => onChange("postalCode", event.target.value)}
          />
        </Field>

        <Field
          id={fieldId("countryCode")}
          label="Country code"
          hint="Two letters, like US or GB."
          error={errorOf("countryCode")}
        >
          <input
            id={fieldId("countryCode")}
            className={cn(INPUT_CLASS, "uppercase")}
            value={values.countryCode}
            disabled={disabled}
            maxLength={2}
            autoComplete="country"
            aria-invalid={errorOf("countryCode") ? true : undefined}
            onChange={(event) => onChange("countryCode", event.target.value.toUpperCase())}
          />
        </Field>

        {/* Full width in both modes. The option labels carry a GMT offset and a
            region — "(GMT−05:00) Eastern Time (US & Canada)" — which a native
            select cannot wrap or ellipsise gracefully; at half width the
            selected value clipped mid-word to "…(US & Canad". Found by looking
            at the rendered screen, which is the only way this repo can catch a
            layout problem: the test suite computes no layout. */}
        <Field
          id={fieldId("timezone")}
          label="Time zone"
          error={errorOf("timezone")}
          className="sm:col-span-2"
        >
          <SelectShell>
            <select
              id={fieldId("timezone")}
              className={SELECT_CLASS}
              value={values.timezone}
              disabled={disabled}
              onChange={(event) => onChange("timezone", event.target.value)}
            >
              {/* The curated list, not `Intl.supportedValuesOf("timeZone")`:
                  several hundred entries is a select nobody can use, and the set
                  differs between runtimes, which would make validation depend on
                  which Node built the response. */}
              {ONBOARDING_TIMEZONES.map((zone) => (
                <option key={zone.value} value={zone.value}>
                  {zone.label}
                </option>
              ))}
            </select>
          </SelectShell>
        </Field>

        {mode === "edit" ? (
          <Field
            id={fieldId("status")}
            label="Status"
            hint="A lifecycle and reporting state. It does not pause data collection or processing."
            error={errorOf("status")}
          >
            <SelectShell>
              <select
                id={fieldId("status")}
                className={SELECT_CLASS}
                value={values.status}
                disabled={disabled}
                onChange={(event) => onChange("status", event.target.value as LocationStatus)}
              >
                {LOCATION_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {LOCATION_STATUS_LABELS[status]}
                  </option>
                ))}
              </select>
            </SelectShell>
          </Field>
        ) : null}

        <Field
          id={fieldId("managerUserId")}
          label="Manager"
          hint="Active members of this organization."
          error={errorOf("managerUserId")}
          className={mode === "edit" ? undefined : "sm:col-span-2"}
        >
          <SelectShell>
            <select
              id={fieldId("managerUserId")}
              className={SELECT_CLASS}
              value={values.managerUserId}
              disabled={disabled}
              aria-invalid={errorOf("managerUserId") ? true : undefined}
              onChange={(event) => onChange("managerUserId", event.target.value)}
            >
              <option value={NO_MANAGER}>Unassigned</option>
              {active.map((member) => (
                <option key={member.userId} value={member.userId}>
                  {member.fullName}
                </option>
              ))}
              {suspendedCurrent ? (
                // Disabled, not merely annotated: re-selecting them would be
                // refused by the database, so offering it as a live choice
                // would be a control that cannot work.
                <option value={suspendedCurrent.userId} disabled>
                  {suspendedCurrent.fullName} · access suspended
                </option>
              ) : null}
            </select>
          </SelectShell>
        </Field>
      </div>
    </div>
  );
}

function Field({
  id,
  label,
  hint,
  error,
  className,
  children,
}: {
  id: string;
  label: string;
  hint?: string;
  error?: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("flex min-w-0 flex-col gap-1.5", className)}>
      <label htmlFor={id} className="text-[13px] font-medium text-gray-950">
        {label}
      </label>
      {children}
      {hint ? <p className="text-[12px] text-gray-500">{hint}</p> : null}
      {error ? (
        <p id={`${id}-error`} role="alert" className="text-[12px] text-red-600">
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A native select in a styled shell, so it keeps its keyboard and mobile picker. */
function SelectShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="relative">
      {children}
      <ChevronDown
        className="pointer-events-none absolute top-1/2 right-3 size-4 -translate-y-1/2 text-gray-400"
        aria-hidden
      />
    </div>
  );
}
