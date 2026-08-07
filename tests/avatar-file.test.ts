import { describe, expect, it } from "vitest";
import {
  MAX_AVATAR_BYTES,
  reviewAvatarFile,
} from "@/lib/profile/avatar-file";

describe("reviewAvatarFile", () => {
  it("accepts each allowed type and reports its extension", () => {
    expect(reviewAvatarFile({ type: "image/png", size: 10 })).toEqual({
      ok: true,
      extension: "png",
    });
    expect(reviewAvatarFile({ type: "image/jpeg", size: 10 })).toEqual({
      ok: true,
      extension: "jpg",
    });
    expect(reviewAvatarFile({ type: "image/webp", size: 10 })).toEqual({
      ok: true,
      extension: "webp",
    });
  });

  it("accepts a file exactly at the cap", () => {
    expect(
      reviewAvatarFile({ type: "image/png", size: MAX_AVATAR_BYTES }).ok,
    ).toBe(true);
  });

  it("refuses an oversize file with the limit in the sentence", () => {
    const result = reviewAvatarFile({
      type: "image/png",
      size: MAX_AVATAR_BYTES + 1,
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("5 MB");
  });

  it("refuses a type outside the list", () => {
    expect(reviewAvatarFile({ type: "image/gif", size: 10 }).ok).toBe(false);
    expect(reviewAvatarFile({ type: "", size: 10 }).ok).toBe(false);
  });
});
