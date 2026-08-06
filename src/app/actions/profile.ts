"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { User } from "@/domain";
import { mutationContext } from "@/lib/actions/guard";
import { runAction, type ActionResult } from "@/lib/actions/result";
import { resolveDataSourceKind } from "@/lib/env";
import { createSupabaseServerClient } from "@/lib/supabase/server";

/**
 * A person editing their own profile.
 *
 * No permission check, on purpose: every role may rename themselves, and the
 * target is never taken from the input — the repository is handed the session
 * user's id, so this action cannot be aimed at anybody else. `mutationContext`
 * still runs first, which is what verifies there is a session at all.
 */

const profileSchema = z.object({
  firstName: z.string().trim().min(1, "Enter your first name.").max(80),
  lastName: z.string().trim().min(1, "Enter your last name.").max(80),
});

export async function updateOwnProfileAction(
  input: unknown,
): Promise<ActionResult<User>> {
  return runAction("profile.update", async () => {
    const parsed = profileSchema.parse(input);
    const context = await mutationContext();

    const updated = await context.dataSource.users.updateOwnProfile(
      context.userId,
      parsed,
    );

    // The sidebar renders the session's name, and under Supabase the session
    // reads auth metadata, not `public.users` — so the metadata is brought
    // along. Best-effort: the profile row above is the record every member
    // list reads, and a metadata failure should not report the rename as
    // failed when it in fact landed. The cost of a miss is a stale sidebar
    // until the next successful edit.
    if (resolveDataSourceKind() === "supabase") {
      const supabase = await createSupabaseServerClient();
      const { error } = await supabase.auth.updateUser({
        data: {
          first_name: updated.firstName,
          last_name: updated.lastName,
          full_name: updated.fullName,
        },
      });
      if (error) console.error("[profile.update] metadata sync:", error.message);
    }

    revalidatePath("/settings");
    return updated;
  });
}
