import {
  BRAND_VOICE_AXIS_KEYS,
  type BrandVoiceProfile,
  type UpdateBrandVoiceInput,
} from "@/domain";
import { diff, recordAuditEvent } from "@/lib/audit/record";
import type { LiaDataSource, OrganizationScope } from "@/lib/data/types";

/**
 * Saving the brand voice: persist, then record what moved.
 *
 * Separate from the action for the reason `analyzeMentions` is: the ordering
 * that matters lives here, so a future caller — a scheduled reset, an import —
 * gets identical behaviour rather than a second implementation of it.
 *
 * The caller has already passed `authorize("brand_voice.update")`. This
 * function performs no role check of its own.
 */

export interface BrandVoiceContext {
  dataSource: LiaDataSource;
  scope: OrganizationScope;
}

export interface SaveBrandVoiceResult {
  profile: BrandVoiceProfile;
  /** False when the input matched what was already stored. */
  changed: boolean;
}

/**
 * Flatten a profile into scalars for the audit diff.
 *
 * `diff` compares with `===` and stringifies anything that is not a primitive,
 * so handing it the axes object or the phrase arrays would report a change on
 * every save — two equal arrays are never `===`. Joining them makes the
 * comparison meaningful and the stored trail readable.
 */
function auditShape(profile: BrandVoiceProfile): Record<string, string | number> {
  const axes = Object.fromEntries(
    BRAND_VOICE_AXIS_KEYS.map((key) => [key, profile.axes[key]]),
  ) as Record<string, number>;

  return {
    ...axes,
    name: profile.name,
    approvedPhrases: profile.approvedPhrases.join(", "),
    prohibitedPhrases: profile.prohibitedPhrases.join(", "),
  };
}

const AUDITED_FIELDS = [
  ...BRAND_VOICE_AXIS_KEYS,
  "name",
  "approvedPhrases",
  "prohibitedPhrases",
] as const;

export async function saveBrandVoice(
  context: BrandVoiceContext,
  input: UpdateBrandVoiceInput,
): Promise<SaveBrandVoiceResult> {
  const existing = await context.dataSource.brandVoice.get(context.scope);
  const profile = await context.dataSource.brandVoice.save(context.scope, input);

  // The repository returns the stored row untouched when nothing differs, so
  // the version is the signal. Comparing the inputs again here would be a
  // second implementation of the same rule.
  const changed = existing === null || existing.version !== profile.version;

  if (!changed) return { profile, changed: false };

  const changes = existing
    ? diff(auditShape(existing), auditShape(profile), [...AUDITED_FIELDS])
    : { previousState: null, newState: auditShape(profile) };

  await recordAuditEvent(context, {
    eventType: "brand_voice.updated",
    entityType: "brand_voice",
    entityId: profile.id,
    previousState: changes.previousState,
    newState: changes.newState,
    metadata: { version: profile.version },
  });

  return { profile, changed: true };
}
