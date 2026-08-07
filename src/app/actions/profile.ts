"use server";

import { randomUUID } from "node:crypto";
import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { User } from "@/domain";
import { mutationContext } from "@/lib/actions/guard";
import { runAction, type ActionResult } from "@/lib/actions/result";
import { DataError, invalidInput } from "@/lib/data/errors";
import { resolveDataSourceKind } from "@/lib/env";
import { reviewAvatarFile } from "@/lib/profile/avatar-file";
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

/**
 * Everything a photo change needs to touch, in one place.
 *
 * Under Supabase: upload to the caller's own folder in the public `avatars`
 * bucket (storage policies restate the ownership), point the profile row at
 * the new public URL, then best-effort delete every *other* object in the
 * folder — each upload gets a fresh random name so browsers never serve a
 * stale cached photo, which means old objects are orphans the moment the row
 * moves on. Cleanup failures are logged and swallowed for the same reason the
 * metadata sync is best-effort: the profile row is the record, and a leftover
 * object in a bucket must not report the change as failed.
 *
 * In demo mode there is no storage: the file itself becomes a data URL and
 * the row stores that.
 */
export async function updateOwnAvatarAction(
  formData: FormData,
): Promise<ActionResult<User>> {
  return runAction("profile.avatar", async () => {
    const file = formData.get("avatar");
    if (!(file instanceof File) || file.size === 0) {
      throw invalidInput("Choose a photo to upload.", {
        avatar: "Choose a photo to upload.",
      });
    }

    const review = reviewAvatarFile(file);
    if (!review.ok) {
      throw invalidInput(review.reason, { avatar: review.reason });
    }

    const context = await mutationContext();

    let url: string;
    if (resolveDataSourceKind() === "supabase") {
      const supabase = await createSupabaseServerClient();
      const path = `${context.userId}/${randomUUID()}.${review.extension}`;

      const { error } = await supabase.storage
        .from("avatars")
        .upload(path, file, { contentType: file.type });
      if (error) {
        console.error("[profile.avatar] upload:", error.message);
        throw new DataError(
          "unavailable",
          "Could not upload that photo. Please try again.",
        );
      }

      url = supabase.storage.from("avatars").getPublicUrl(path).data.publicUrl;
      await removeOtherAvatarObjects(context.userId, path);
    } else {
      const bytes = Buffer.from(await file.arrayBuffer());
      url = `data:${file.type};base64,${bytes.toString("base64")}`;
    }

    const updated = await context.dataSource.users.updateOwnAvatar(
      context.userId,
      url,
    );
    await syncAvatarMetadata(updated.avatarUrl);

    revalidatePath("/settings");
    return updated;
  });
}

export async function removeOwnAvatarAction(): Promise<ActionResult<User>> {
  return runAction("profile.avatar.remove", async () => {
    const context = await mutationContext();

    const updated = await context.dataSource.users.updateOwnAvatar(
      context.userId,
      null,
    );

    if (resolveDataSourceKind() === "supabase") {
      await removeOtherAvatarObjects(context.userId, null);
    }
    await syncAvatarMetadata(null);

    revalidatePath("/settings");
    return updated;
  });
}

/**
 * Delete everything in the caller's avatar folder except `keepPath` (null
 * keeps nothing). Best-effort by design — see `updateOwnAvatarAction`.
 */
async function removeOtherAvatarObjects(
  userId: string,
  keepPath: string | null,
): Promise<void> {
  try {
    const supabase = await createSupabaseServerClient();
    const { data, error } = await supabase.storage.from("avatars").list(userId);
    if (error || !data) return;

    const stale = data
      .map((object) => `${userId}/${object.name}`)
      .filter((path) => path !== keepPath);
    if (stale.length === 0) return;

    const { error: removeError } = await supabase.storage
      .from("avatars")
      .remove(stale);
    if (removeError) {
      console.error("[profile.avatar] cleanup:", removeError.message);
    }
  } catch (error) {
    console.error("[profile.avatar] cleanup:", error);
  }
}

/** Same best-effort contract, and the same reason, as the name sync above. */
async function syncAvatarMetadata(avatarUrl: string | null): Promise<void> {
  if (resolveDataSourceKind() !== "supabase") return;
  const supabase = await createSupabaseServerClient();
  const { error } = await supabase.auth.updateUser({
    data: { avatar_url: avatarUrl },
  });
  if (error) console.error("[profile.avatar] metadata sync:", error.message);
}
