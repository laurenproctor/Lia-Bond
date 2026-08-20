import { LOCATION_STATUS_LABELS } from "@/lib/labels";
import type { Location } from "@/domain";

/**
 * A location's details, read-only.
 *
 * What a role without `location.update` sees instead of the form. Deliberately a
 * definition list rather than the same form with every control disabled: eleven
 * greyed-out inputs communicate the same refusal at ten times the visual cost,
 * and a form nobody can submit reads as broken rather than as somebody else's
 * job. This also has nothing to tab into, which is the honest keyboard
 * experience for a screen you can only read.
 */
export function LocationSummary({
  location,
  managerName,
}: {
  location: Location;
  /** Null when unassigned; the label carries suspension where it applies. */
  managerName: string | null;
}) {
  const address = [
    location.addressLine1,
    location.addressLine2,
    `${location.city}, ${location.region} ${location.postalCode}`,
    location.countryCode,
  ].filter(Boolean);

  return (
    <dl className="grid gap-x-6 gap-y-4 sm:grid-cols-2">
      <Row label="Name">{location.name}</Row>
      <Row label="Address slug">
        <span className="font-mono text-[12.5px]">{location.slug}</span>
      </Row>
      <Row label="Address">
        <span className="block whitespace-pre-line">{address.join("\n")}</span>
      </Row>
      <Row label="Time zone">{location.timezone}</Row>
      <Row label="Status">{LOCATION_STATUS_LABELS[location.status]}</Row>
      <Row label="Manager">
        {managerName ?? <span className="text-gray-400">Unassigned</span>}
      </Row>
    </dl>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-[12px] font-medium tracking-wide text-gray-500 uppercase">
        {label}
      </dt>
      <dd className="mt-1 text-[13.5px] text-gray-950">{children}</dd>
    </div>
  );
}
