"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Loader2 } from "lucide-react";

/**
 * Which restaurant's widget is being configured.
 *
 * Navigates rather than swapping client state, so the location's widget, its
 * eligible reviews, and its embed code are all fetched on the server by the
 * page that already knows how to fetch them. The alternative — holding every
 * location's reviews in the client so the select could switch instantly —
 * would load a group's entire review history to save one round trip.
 *
 * `replace` rather than `push`: the browser's back button should leave this
 * screen, not walk back through every location somebody glanced at.
 */

export interface ReviewWidgetLocationPickerProps {
  locations: { id: string; name: string; city: string; hasWidget: boolean }[];
  selectedId: string;
}

export function ReviewWidgetLocationPicker({
  locations,
  selectedId,
}: ReviewWidgetLocationPickerProps) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <label className="flex items-center gap-2 text-[13px] font-medium text-gray-700">
      Location
      <select
        value={selectedId}
        onChange={(event) => {
          const next = event.target.value;
          startTransition(() => {
            router.replace(`/integrations/review-widget?location=${next}`);
          });
        }}
        className="h-9 min-w-56 rounded-lg border border-gray-300 bg-white px-2 text-[13px] font-normal text-gray-950"
      >
        {locations.map((location) => (
          <option key={location.id} value={location.id}>
            {location.name} — {location.city}
            {location.hasWidget ? "" : " (not set up)"}
          </option>
        ))}
      </select>
      {pending ? (
        <Loader2 className="size-4 animate-spin text-gray-400" aria-hidden />
      ) : null}
    </label>
  );
}
