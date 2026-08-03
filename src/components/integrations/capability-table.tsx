import { Check, Minus, X } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import type { IntegrationCapability } from "@/integrations/connector";
import { INTEGRATION_CAPABILITY_STATE_LABELS } from "@/lib/labels";

/**
 * What the integration can do, stated plainly.
 *
 * Each row carries its own sentence rather than a bare tick or cross. "Review
 * sync: Not configured" invites the reading "somebody needs to turn this on";
 * the detail line says the feature does not exist yet, which is the difference
 * between an operator waiting and an operator planning.
 *
 * State is never communicated by colour alone — every row has a word and an
 * icon as well.
 */

const STATE_ICONS: Record<IntegrationCapability["state"], LucideIcon> = {
  enabled: Check,
  not_configured: Minus,
  unavailable: X,
};

const STATE_CLASSES: Record<IntegrationCapability["state"], string> = {
  enabled: "text-green-600",
  not_configured: "text-gray-400",
  unavailable: "text-red-600",
};

const LABEL_CLASSES: Record<IntegrationCapability["state"], string> = {
  enabled: "text-gray-950",
  not_configured: "text-gray-700",
  unavailable: "text-gray-700",
};

export function CapabilityTable({
  capabilities,
}: {
  capabilities: IntegrationCapability[];
}) {
  return (
    <ul className="divide-y divide-gray-200">
      {capabilities.map((capability) => {
        const Icon = STATE_ICONS[capability.state];

        return (
          <li key={capability.id} className="flex gap-2.5 py-2.5 first:pt-0 last:pb-0">
            <Icon
              className={`mt-0.5 size-4 shrink-0 ${STATE_CLASSES[capability.state]}`}
              aria-hidden
            />
            <div className="min-w-0">
              <p className="flex flex-wrap items-baseline gap-x-2 text-[13px] font-medium">
                <span className={LABEL_CLASSES[capability.state]}>
                  {capability.label}
                </span>
                <span className="text-[12px] font-normal text-gray-500">
                  {INTEGRATION_CAPABILITY_STATE_LABELS[capability.state]}
                </span>
              </p>
              <p className="mt-0.5 text-[12.5px] text-gray-500">{capability.detail}</p>
            </div>
          </li>
        );
      })}
    </ul>
  );
}
