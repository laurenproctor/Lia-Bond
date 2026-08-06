import "server-only";

import type { ActivationState } from "@/components/overview/activation-banner";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";
import { readImportStatus } from "@/lib/onboarding/import-status";

/**
 * Whether the overview should carry an activation prompt, and which one.
 *
 * Returns null — meaning "render nothing" — for any workspace that is working
 * normally, which is the common case and the one that matters. The banner is
 * not a permanent "getting started" panel: it exists to explain an overview
 * whose numbers are all zero, and the moment they stop being zero it has
 * nothing to explain and disappears on its own.
 *
 * Every branch is a repository read. There is no "days since signup" heuristic
 * and no stored dismissal flag, because both would keep the banner on screen
 * after it stopped being true — or hide it while it still was.
 */
export async function resolveActivationState(
  dataSource: LiaDataSource,
  scope: OrganizationScope,
): Promise<ActivationState | null> {
  const counts = await dataSource.mentions.counts(scope);

  // There is feedback in the workspace. Whatever setup did or did not do, the
  // product is working and has nothing to apologise for.
  if (counts.total > 0) return null;

  const status = await readImportStatus(dataSource, scope);

  if (status.connectedProfiles === 0) return "no_source";
  if (status.isRunning) return "importing";
  return "no_mentions";
}
