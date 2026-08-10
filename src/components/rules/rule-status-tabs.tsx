"use client";

import { useRouter } from "next/navigation";
import { SegmentedTabs } from "@/components/ui/segmented-tabs";
import type { AutomationRuleStatus } from "@/domain";

export interface RuleStatusTabsProps {
  activeStatus: AutomationRuleStatus | "all";
  counts: {
    all: number;
    active: number;
    inactive: number;
    draft: number;
  };
}

/**
 * Status filter for the rules list, backed by the `?status=` URL param
 * rather than component state — so the filtered view is shareable and
 * survives a refresh. Navigation replaces (not pushes) history and skips the
 * scroll-to-top, matching the escalations selection pattern.
 */
export function RuleStatusTabs({ activeStatus, counts }: RuleStatusTabsProps) {
  const router = useRouter();

  return (
    <SegmentedTabs
      label="Rules view"
      activeTabId={activeStatus}
      onChange={(id) => {
        router.replace(id === "all" ? "/rules" : `/rules?status=${id}`, { scroll: false });
      }}
      tabs={[
        { id: "all", label: "All rules", count: counts.all },
        { id: "active", label: "Active", count: counts.active },
        { id: "inactive", label: "Inactive", count: counts.inactive },
        { id: "draft", label: "Draft", count: counts.draft },
      ]}
    />
  );
}
