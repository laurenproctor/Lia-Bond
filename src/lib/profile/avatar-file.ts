/**
 * What a profile photo is allowed to be.
 *
 * Pure and free of `server-only` on purpose — the settings file input and the
 * upload action run the same review over the same limits. The client's copy
 * exists so someone learns their file is wrong before an upload round-trip;
 * the server's copy is the one that decides, because a file picker is a
 * suggestion and a request body is not.
 *
 * The storage bucket restates both limits (`20260808000500_avatar_storage`),
 * so a request that skips this review entirely still cannot store a 40 MB GIF.
 */

export const MAX_AVATAR_BYTES = 5 * 1024 * 1024;

/** Allowed MIME types, each with the extension the object path uses. */
const AVATAR_TYPES: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
};

/** The `accept` attribute for the hidden file input. */
export const AVATAR_ACCEPT = Object.keys(AVATAR_TYPES).join(",");

export function reviewAvatarFile(file: {
  type: string;
  size: number;
}): { ok: true; extension: string } | { ok: false; reason: string } {
  const extension = AVATAR_TYPES[file.type];
  if (!extension) {
    return { ok: false, reason: "Use a PNG, JPEG, or WebP image." };
  }
  if (file.size > MAX_AVATAR_BYTES) {
    return { ok: false, reason: "Photos can be up to 5 MB." };
  }
  return { ok: true, extension };
}
