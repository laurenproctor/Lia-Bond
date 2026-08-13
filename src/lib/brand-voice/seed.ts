import {
  DEFAULT_BRAND_VOICE,
  type BrandVoiceProfile,
  type UpdateBrandVoiceInput,
} from "@/domain";

/**
 * What a brand-voice form starts from.
 *
 * Both surfaces that edit the voice — step 4 of onboarding and `/brand-voice` —
 * seed their form this way, so the settings somebody chose during setup are the
 * settings the product screen opens on. They already shared the schema, the
 * service, and the repository; this is the last piece that was written out
 * twice, and two copies of "which fields carry over, and what happens when
 * there is no row" is exactly where the two screens would drift apart.
 *
 * Null means no profile has ever been saved, which is the normal state of a new
 * organization: provisioning does not create one and no migration backfills it.
 * The fallback is `DEFAULT_BRAND_VOICE` — the single declaration of the starting
 * axis values — rather than a second set of numbers written here.
 *
 * `version`, `updatedByUserId`, and the timestamps are deliberately dropped: the
 * form edits `UpdateBrandVoiceInput`, and carrying a version into it would let a
 * stale tab write one back.
 */
export function brandVoiceFormSeed(
  profile: BrandVoiceProfile | null,
): UpdateBrandVoiceInput {
  if (!profile) return DEFAULT_BRAND_VOICE;

  return {
    name: profile.name,
    axes: profile.axes,
    approvedPhrases: profile.approvedPhrases,
    prohibitedPhrases: profile.prohibitedPhrases,
  };
}
