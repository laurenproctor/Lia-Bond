import { beforeEach, describe, expect, it } from "vitest";
import { freshDataSource, ushg } from "./helpers/scope";
import { DataError } from "@/lib/data/errors";
import type { LiaDataSource } from "@/lib/data/types";
import { userSchema } from "@/domain";
import { USER_KATE } from "@/lib/seed/dataset";

/**
 * A person editing their own name.
 *
 * Against the demo adapter. Under Supabase the same contract is held by the
 * database instead: `full_name` is a STORED GENERATED column, so the display
 * name cannot disagree with the parts no matter who writes them. These tests
 * pin the demo adapter to composing it identically, because the two adapters
 * must not render different names for the same person.
 */

let data: LiaDataSource;

beforeEach(() => {
  data = freshDataSource();
});

describe("updateOwnProfile", () => {
  it("updates the parts and recomposes the display name", async () => {
    const updated = await data.users.updateOwnProfile(USER_KATE, {
      firstName: "Katherine",
      lastName: "Morgan-Reyes",
    });

    expect(updated.firstName).toBe("Katherine");
    expect(updated.lastName).toBe("Morgan-Reyes");
    expect(updated.fullName).toBe("Katherine Morgan-Reyes");
  });

  it("composes cleanly when the last name is empty", async () => {
    // The domain allows an empty last name (dashboard-created accounts have
    // one); the composed display name must not carry a trailing space.
    const updated = await data.users.updateOwnProfile(USER_KATE, {
      firstName: "Kate",
      lastName: "",
    });

    expect(updated.fullName).toBe("Kate");
  });

  it("is visible to the member list afterwards", async () => {
    await data.users.updateOwnProfile(USER_KATE, {
      firstName: "Katherine",
      lastName: "Morgan",
    });

    const members = await data.memberships.listMembers(ushg.owner());
    const kate = members.find((member) => member.userId === USER_KATE);

    expect(kate?.user.fullName).toBe("Katherine Morgan");
  });

  it("refuses an id with no profile behind it", async () => {
    await expect(
      data.users.updateOwnProfile("00000000-0000-0000-0000-000000000000", {
        firstName: "Nobody",
        lastName: "Here",
      }),
    ).rejects.toThrow(DataError);
  });
});

describe("updateOwnAvatar", () => {
  it("stores and clears the caller's photo", async () => {
    const dataUrl = "data:image/png;base64,iVBORw0KGgo=";

    const withPhoto = await data.users.updateOwnAvatar(USER_KATE, dataUrl);
    expect(withPhoto.avatarUrl).toBe(dataUrl);

    const cleared = await data.users.updateOwnAvatar(USER_KATE, null);
    expect(cleared.avatarUrl).toBeNull();
  });

  it("produces a row the user schema accepts", async () => {
    // Demo mode stores uploads as data URLs — the schema must accept them or
    // every demo-mode read of this row would fail validation.
    const updated = await data.users.updateOwnAvatar(
      USER_KATE,
      "data:image/webp;base64,UklGRg==",
    );
    expect(userSchema.safeParse(updated).success).toBe(true);
  });

  it("refuses an id with no profile behind it", async () => {
    await expect(
      data.users.updateOwnAvatar("00000000-0000-0000-0000-000000000000", null),
    ).rejects.toThrow(DataError);
  });
});
