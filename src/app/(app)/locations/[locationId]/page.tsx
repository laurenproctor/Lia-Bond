import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { PageBody } from "@/components/shell/app-shell";
import { EditLocationForm } from "@/components/locations/edit-location-form";
import type { LocationMemberOption } from "@/components/locations/location-fields";
import { LocationSummary } from "@/components/locations/location-summary";
import { MappedProfilesCard } from "@/components/locations/mapped-profiles-card";
import { Card, CardHeader } from "@/components/ui/card";
import { KpiCard } from "@/components/ui/kpi-card";
import { PageHeader } from "@/components/ui/page-header";
import { LocationStatusBadge } from "@/components/ui/status-badge";
import { can, explainDenial } from "@/lib/auth/permissions";
import { getDataSource } from "@/lib/data";
import { formatNumber, formatPercent, formatRating } from "@/lib/format";
import { getOrganizationContext } from "@/lib/tenancy/organization-context";
import type { Kpi } from "@/lib/view-models/kpi";

interface LocationPageProps {
  params: Promise<{ locationId: string }>;
}

export async function generateMetadata({
  params,
}: LocationPageProps): Promise<Metadata> {
  const { locationId } = await params;
  const context = await getOrganizationContext();
  const dataSource = await getDataSource();
  const location = await dataSource.locations.get(context.scope, locationId);
  return { title: location?.name ?? "Location" };
}

/**
 * One location: its details, the profiles routing to it, and its numbers.
 *
 * The lookup is scoped, so a location id belonging to another organization is
 * simply not found — and takes the same `notFound()` branch a deleted one does.
 * That is the point: a distinct "you don't have access to that location" message
 * would confirm the record exists, which is exactly what a foreign id must not
 * be able to learn.
 */
export default async function LocationDetailPage({ params }: LocationPageProps) {
  const { locationId } = await params;
  const context = await getOrganizationContext();
  const dataSource = await getDataSource();

  const location = await dataSource.locations.get(context.scope, locationId);
  if (!location) notFound();

  const [members, profiles, connections, metrics] = await Promise.all([
    dataSource.memberships.listMembers(context.scope),
    dataSource.platformProfiles.list(context.scope),
    dataSource.platformConnections.list(context.scope),
    dataSource.locations.metrics(context.scope),
  ]);

  const editable = can(context.role, "location.update");

  const memberOptions: LocationMemberOption[] = members.map((member) => ({
    userId: member.userId,
    fullName: member.user.fullName,
    isActive: member.status === "active",
  }));

  const manager = members.find((member) => member.userId === location.managerUserId);
  const managerName = manager
    ? manager.status === "active"
      ? manager.user.fullName
      : `${manager.user.fullName} · access suspended`
    : null;

  const mapped = profiles.filter((profile) => profile.locationId === location.id);
  const locationMetrics = metrics.find((entry) => entry.locationId === location.id);

  return (
    <PageBody>
      <PageHeader
        title={location.name}
        description={`${location.city}, ${location.region}`}
        actions={<LocationStatusBadge status={location.status} />}
      >
        <Link
          href="/locations"
          className="inline-flex items-center gap-1.5 text-[13px] font-medium text-gray-500 transition-colors hover:text-gray-950"
        >
          <ArrowLeft className="size-4" aria-hidden />
          Locations
        </Link>
      </PageHeader>

      {locationMetrics ? (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {buildLocationKpis(locationMetrics).map((kpi) => (
            <KpiCard key={kpi.id} kpi={kpi} />
          ))}
        </div>
      ) : null}

      <div className="grid items-start gap-4 xl:grid-cols-12">
        <div className="xl:col-span-7">
          <Card>
            <CardHeader
              title="Details"
              description={
                editable
                  ? "Identity, address, lifecycle, and who runs it."
                  : "Owners and admins edit these."
              }
            />
            {editable ? (
              <div className="mt-4">
                <EditLocationForm location={location} members={memberOptions} />
              </div>
            ) : (
              <>
                <p className="mt-3 rounded-lg border border-gray-200 bg-gray-50 px-3 py-2.5 text-[13px] text-gray-600">
                  {explainDenial("location.update", context.role)}
                </p>
                <div className="mt-4">
                  <LocationSummary location={location} managerName={managerName} />
                </div>
              </>
            )}
          </Card>
        </div>

        <div className="flex flex-col gap-4 xl:col-span-5">
          <MappedProfilesCard profiles={mapped} connections={connections} />
        </div>
      </div>
    </PageBody>
  );
}

/** Per-location numbers, from the same metrics the portfolio table reads. */
function buildLocationKpis(metrics: {
  mentionVolume: number;
  averageRating: number | null;
  responseCoveragePercent: number;
  averageResponseMinutes: number;
  riskMentions: number;
}): Kpi[] {
  // No comparison period is stored, so these render "No change" rather than a
  // delta nobody computed — matching the portfolio roll-ups exactly.
  const flat = { changePercent: 0, higherIsBetter: true, comparisonLabel: "this period" };

  return [
    {
      id: "volume",
      label: "Mentions",
      value: formatNumber(metrics.mentionVolume),
      trend: { points: [0, metrics.mentionVolume], ...flat },
    },
    {
      id: "rating",
      label: "Average rating",
      value: formatRating(metrics.averageRating),
      trend: { points: [0, metrics.averageRating ?? 0], ...flat },
    },
    {
      id: "coverage",
      label: "Response coverage",
      value: formatPercent(metrics.responseCoveragePercent),
      trend: { points: [0, metrics.responseCoveragePercent], ...flat },
    },
    {
      id: "risk",
      label: "Risk mentions",
      value: String(metrics.riskMentions),
      trend: {
        points: [0, metrics.riskMentions],
        changePercent: 0,
        higherIsBetter: false,
        comparisonLabel: "high and critical",
      },
    },
  ];
}
