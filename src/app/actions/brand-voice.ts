"use server";

import { revalidatePath } from "next/cache";
import { updateBrandVoiceInputSchema, type BrandVoiceProfile } from "@/domain";
import { authorize } from "@/lib/actions/guard";
import { runAction, type ActionResult } from "@/lib/actions/result";
import { saveBrandVoice } from "@/lib/brand-voice/save";

/**
 * Save the organization's brand voice.
 *
 * Thin, like the analysis and integration actions: authorise, call the service,
 * revalidate. Nothing generates text from these settings yet, so this changes
 * no output today — but it is audited, because "who widened the approved phrase
 * list" is exactly the question asked after a response goes wrong, and the
 * trail has to already exist by then.
 */
export async function updateBrandVoiceAction(
  input: unknown,
): Promise<ActionResult<BrandVoiceProfile>> {
  return runAction("brand_voice.update", async () => {
    const parsed = updateBrandVoiceInputSchema.parse(input);
    const context = await authorize("brand_voice.update");

    const { profile } = await saveBrandVoice(context, parsed);

    // Only this screen reads the voice. Nothing generates from it yet, so no
    // other route's output can have changed.
    revalidatePath("/brand-voice");
    return profile;
  });
}
