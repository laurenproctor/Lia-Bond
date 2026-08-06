# Settings: profile photos and editable organization details — implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every user can upload/remove a profile photo that renders everywhere their avatar shows; owners and admins can edit all six organization detail fields, including the slug.

**Architecture:** Photos live in a new public-read Supabase Storage bucket (`avatars`) with per-user write policies; `users.avatar_url` (already in the schema) stores the public URL, and demo mode stores a data URL instead so it needs no storage. Org editing extends the existing `OrganizationRepository.update` with an optional `slug`, gated by a new `organization.update` permission — the `organizations_update_admins` RLS policy **already covers owner/admin updates, so no new org policy is needed** (a deviation from the spec, which assumed one was).

**Tech Stack:** Next.js App Router server actions, Supabase (Postgres + Storage), Zod v4, Vitest, Tailwind.

**Spec:** `docs/superpowers/specs/2026-08-06-settings-profile-photo-org-details-design.md`

## Global Constraints

- TypeScript strict mode; no `any` unless justified in a comment.
- Server components by default; client components only where interactivity requires them.
- Sentence case for all UI copy.
- No page component over ~300 lines.
- Comments explain constraints the code can't show, in the codebase's discursive style — read neighboring code before writing any.
- Run the full suite with `npm test` (vitest). Lint with `npm run lint`.
- Commit after every task with the trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Avatars storage bucket migration

**Files:**
- Create: `supabase/migrations/20260808000500_avatar_storage.sql`

**Interfaces:**
- Consumes: nothing.
- Produces: an `avatars` bucket that Task 5's upload action writes to. Object paths are `{userId}/{random}.{ext}`; the bucket itself enforces the 5 MB cap and the three MIME types as a backstop to the application check.

- [ ] **Step 1: Write the migration**

```sql
-- ---------------------------------------------------------------------------
-- Profile photo storage
--
-- The first storage bucket in the project. Public read: an avatar URL is
-- rendered in <img> tags across the app and carries nothing sensitive, and a
-- public bucket lets the CDN cache it. Writes are scoped to the caller's own
-- {userId}/ prefix — nobody uploads anyone else's face.
--
-- The size and type limits restate `src/lib/profile/avatar-file.ts` at the
-- bucket level. The application check is the one that produces a friendly
-- sentence; this one is the backstop for anything that reaches storage
-- without passing through it.
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'avatars',
  'avatars',
  true,
  5242880,
  array['image/png', 'image/jpeg', 'image/webp']
)
on conflict (id) do nothing;

create policy avatars_select on storage.objects
  for select to authenticated
  using (bucket_id = 'avatars');

create policy avatars_insert_own on storage.objects
  for insert to authenticated
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

create policy avatars_update_own on storage.objects
  for update to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  )
  with check (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );

create policy avatars_delete_own on storage.objects
  for delete to authenticated
  using (
    bucket_id = 'avatars'
    and (storage.foldername(name))[1] = (select auth.uid()::text)
  );
```

- [ ] **Step 2: Verify it applies cleanly**

Run: `npx supabase db push --dry-run`
Expected: the new migration is listed as pending, no errors. Do **not** push for real yet — that happens in Task 10 with everything verified.

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/20260808000500_avatar_storage.sql
git commit -m "Add avatars storage bucket with per-user write policies"
```

---

### Task 2: Avatar repository plumbing (schema, contract, both adapters)

**Files:**
- Modify: `src/domain/entities/organization.ts` (the `userSchema.avatarUrl` field)
- Modify: `src/lib/data/types.ts` (`UserRepository`)
- Modify: `src/lib/data/demo/index.ts` (users repository, next to `updateOwnProfile` at ~line 501)
- Modify: `src/lib/data/supabase/index.ts` (users repository, next to `updateOwnProfile` at ~line 649)
- Test: `tests/profile.test.ts`

**Interfaces:**
- Consumes: existing `User`, `notFound`, `replaceRow`, `nowIso`, `fail`, `toUser` helpers already imported in each adapter file.
- Produces: `UserRepository.updateOwnAvatar(userId: string, avatarUrl: string | null): Promise<User>` — Task 5's actions call this.

- [ ] **Step 1: Write the failing tests**

Append to `tests/profile.test.ts`:

```ts
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
```

Add `import { userSchema } from "@/domain";` to the test file's imports (check `src/domain/index.ts` re-exports it; if not, import from `@/domain/entities/organization`).

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/profile.test.ts`
Expected: FAIL — `updateOwnAvatar is not a function`.

- [ ] **Step 3: Widen the avatar URL schema**

In `src/domain/entities/organization.ts`, replace `avatarUrl: z.url().nullable(),` in `userSchema` with:

```ts
    /**
     * A real URL under Supabase (the public `avatars` bucket), a data URL in
     * demo mode — demo has no storage, so the upload itself is the value.
     */
    avatarUrl: z
      .union([
        z.url(),
        z.string().regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/),
      ])
      .nullable(),
```

- [ ] **Step 4: Add the contract**

In `src/lib/data/types.ts`, inside `UserRepository` after `updateOwnProfile`:

```ts
  /**
   * Set or clear the caller's own photo. Same contract as `updateOwnProfile`:
   * `userId` comes from the session, never from a form, and RLS
   * (`users_update_self`) is the backstop under Supabase. The value is a
   * public storage URL, or a data URL in demo mode, or null to remove.
   */
  updateOwnAvatar(userId: string, avatarUrl: string | null): Promise<User>;
```

- [ ] **Step 5: Implement the demo adapter**

In `src/lib/data/demo/index.ts`, inside the `users` object after `updateOwnProfile` (mirror its structure exactly — find/notFound/replaceRow):

```ts
      async updateOwnAvatar(userId, avatarUrl) {
        const user = store().users.find((row) => row.id === userId);
        if (!user) throw notFound("User");

        const updated: User = { ...user, avatarUrl, updatedAt: nowIso() };
        return replaceRow(store().users, updated);
      },
```

(If `User` is not already imported as a type in the file, add it to the existing type import from `@/domain`.)

- [ ] **Step 6: Implement the Supabase adapter**

In `src/lib/data/supabase/index.ts`, inside `users` after `updateOwnProfile`:

```ts
      async updateOwnAvatar(userId, avatarUrl) {
        const { data, error } = await client
          .from("users")
          .update({ avatar_url: avatarUrl })
          .eq("id", userId)
          .select("*")
          .single();

        if (error) fail(error, "update your photo");
        return toUser(data as Row);
      },
```

- [ ] **Step 7: Run tests**

Run: `npx vitest run tests/profile.test.ts`
Expected: PASS. Then `npm test` — everything green.

- [ ] **Step 8: Commit**

```bash
git add src/domain/entities/organization.ts src/lib/data/types.ts src/lib/data/demo/index.ts src/lib/data/supabase/index.ts tests/profile.test.ts
git commit -m "Add updateOwnAvatar to the user repository in both adapters"
```

---

### Task 3: Slug on organization update (contract, both adapters, conflict mapping)

**Files:**
- Modify: `src/lib/data/types.ts` (`UpdateOrganizationInput`, ~line 162, and its doc comment ~line 155–161)
- Modify: `src/domain/entities/organization.ts` (the slug doc comment on `organizationSchema`, ~line 23)
- Modify: `src/lib/data/demo/index.ts` (organizations `update`, ~line 344)
- Modify: `src/lib/data/supabase/index.ts` (organizations `update`, ~line 451)
- Test: create `tests/organization-settings.test.ts`

**Interfaces:**
- Consumes: existing `OrganizationRepository.update(scope, input)`.
- Produces: `UpdateOrganizationInput` gains `slug?: string`. A slug collision throws `DataError` code `conflict` with `fieldErrors: { slug: "That slug is already taken." }`. Task 6's action relies on both.

- [ ] **Step 1: Write the failing tests**

Create `tests/organization-settings.test.ts`:

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { freshDataSource, harbor, ushg, ORG_HARBOR, ORG_USHG } from "./helpers/scope";
import { DataError } from "@/lib/data/errors";
import type { LiaDataSource } from "@/lib/data/types";

/**
 * Editing the organization's own details, slug included.
 *
 * Against the demo adapter. Under Supabase the slug's global uniqueness is a
 * database constraint; the demo adapter restates it with a linear scan so both
 * adapters refuse the same collision with the same field error.
 */

let data: LiaDataSource;

beforeEach(() => {
  data = freshDataSource();
});

const DETAILS = {
  name: "Union Square Hospitality Group",
  websiteUrl: "https://www.ushg.com",
  industry: "Hospitality",
  defaultTimezone: "America/New_York",
  defaultLanguage: "en-US",
};

describe("organizations.update with a slug", () => {
  it("renames the slug", async () => {
    const updated = await data.organizations.update(ushg.owner(), {
      ...DETAILS,
      slug: "ushg-hq",
    });
    expect(updated.slug).toBe("ushg-hq");
  });

  it("leaves the slug alone when omitted", async () => {
    const before = await data.organizations.getById(
      ORG_USHG,
      ushg.owner().userId,
    );
    const updated = await data.organizations.update(ushg.owner(), DETAILS);
    expect(updated.slug).toBe(before?.organization.slug);
  });

  it("keeps the caller's own slug idempotent", async () => {
    // Saving the form without touching the slug must not read as a collision
    // with yourself.
    const before = await data.organizations.getById(
      ORG_USHG,
      ushg.owner().userId,
    );
    const updated = await data.organizations.update(ushg.owner(), {
      ...DETAILS,
      slug: before!.organization.slug,
    });
    expect(updated.slug).toBe(before!.organization.slug);
  });

  it("refuses another tenant's slug with a field error", async () => {
    const other = await data.organizations.getById(
      ORG_HARBOR,
      harbor.owner().userId,
    );

    const attempt = data.organizations.update(ushg.owner(), {
      ...DETAILS,
      slug: other!.organization.slug,
    });

    await expect(attempt).rejects.toMatchObject({
      code: "conflict",
      fieldErrors: { slug: "That slug is already taken." },
    });
    await expect(attempt).rejects.toBeInstanceOf(DataError);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/organization-settings.test.ts`
Expected: FAIL — TypeScript rejects `slug` on the input type (and the conflict test fails at runtime).

- [ ] **Step 3: Update the contract and doctrine comments**

In `src/lib/data/types.ts`, add to `UpdateOrganizationInput`:

```ts
  /**
   * Omitted everywhere except the settings form. Globally unique; a collision
   * surfaces as a `conflict` DataError carrying a `slug` field error. Present
   * here since the slug became editable (see the 2026-08-06 settings spec) —
   * it appears in no URL and no route, so renaming it breaks nothing.
   */
  slug?: string;
```

Rewrite the interface's doc comment (~line 155–161): it currently says the type "carries no slug and no id, so neither is reachable from a form" — revise to say only the **id** is unreachable, and the slug is form-editable but collision-checked. In `src/domain/entities/organization.ts`, change the slug comment on `organizationSchema` from `/** Globally unique. Stable once issued — it appears in shared links. */` to:

```ts
    /**
     * Globally unique. Editable by owners and admins in settings — it appears
     * in no URL or route, only on the settings page and as metadata in
     * support correspondence.
     */
```

- [ ] **Step 4: Implement the demo adapter**

In `src/lib/data/demo/index.ts` organizations `update`, after the `notFound` check and before building `updated`:

```ts
        if (input.slug !== undefined && input.slug !== existing.slug) {
          const taken = store().organizations.some(
            (row) => row.slug === input.slug && row.id !== existing.id,
          );
          if (taken) {
            throw new DataError("conflict", "That slug is already taken.", {
              slug: "That slug is already taken.",
            });
          }
        }
```

and add `slug: input.slug ?? existing.slug,` to the `updated` object. Add `DataError` to the file's imports from `@/lib/data/errors` if not present.

- [ ] **Step 5: Implement the Supabase adapter**

In `src/lib/data/supabase/index.ts` organizations `update`, build the payload conditionally and map the unique violation *before* the generic `fail`:

```ts
      async update(scope, input) {
        const { data, error } = await client
          .from("organizations")
          .update({
            name: input.name,
            website_url: input.websiteUrl,
            industry: input.industry,
            default_timezone: input.defaultTimezone,
            default_language: input.defaultLanguage,
            ...(input.slug !== undefined ? { slug: input.slug } : {}),
          })
          // Scoped by primary key rather than by `organization_id`: this *is*
          // the tenant root. `organizations_update_admins` re-checks the role,
          // so a scope forged past the application layer still writes nothing.
          .eq("id", scope.organizationId)
          .select("*")
          .maybeSingle();

        // The one unique constraint on this table is the slug, so 23505 can be
        // named precisely instead of falling through to fail()'s generic
        // "already exists" — the form needs a field to attach the sentence to.
        if (error?.code === "23505") {
          throw new DataError("conflict", "That slug is already taken.", {
            slug: "That slug is already taken.",
          });
        }
        if (error) fail(error, "save that organization");
        if (!data) throw notFound("Organization");
        return toOrganization(data as Row);
      },
```

(`DataError` is already imported in this file — verify.)

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/organization-settings.test.ts`, then `npm test`.
Expected: PASS, suite green (the onboarding path passes no slug, so nothing else moves).

- [ ] **Step 7: Commit**

```bash
git add src/lib/data/types.ts src/domain/entities/organization.ts src/lib/data/demo/index.ts src/lib/data/supabase/index.ts tests/organization-settings.test.ts
git commit -m "Make the organization slug editable through the repository update"
```

---

### Task 4: The organization.update permission

**Files:**
- Modify: `src/lib/auth/permissions.ts` (the `PERMISSIONS` array ~line 23 and `PERMISSION_MATRIX` ~line 86)
- Test: `tests/permissions.test.ts`

**Interfaces:**
- Produces: `"organization.update"` as a `Permission`, held by exactly `owner` and `admin`. Task 6's action and Task 8's page both check it.

- [ ] **Step 1: Write the failing test**

Append inside the `role permissions` describe block of `tests/permissions.test.ts`:

```ts
  it("keeps organization details with owners and admins", () => {
    for (const role of MEMBERSHIP_ROLES) {
      const expected = role === "owner" || role === "admin";
      expect(can(role, "organization.update")).toBe(expected);
    }
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/permissions.test.ts`
Expected: FAIL — TypeScript rejects the unknown permission string.

- [ ] **Step 3: Implement**

Add `"organization.update",` to the `PERMISSIONS` array next to `"organization.manage_members"`. Add to the matrix, next to the `organization.manage_members` row:

```ts
  // Who runs the roster and who defines the organization's identity are
  // different questions — this is deliberately not a reuse of
  // `manage_members`, so each answer stays legible on its own row. Backstopped
  // by `organizations_update_admins` in RLS, which named the same two roles
  // before this permission existed.
  "organization.update": ["owner", "admin"],
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/permissions.test.ts` then `npm test`.
Expected: PASS (the "owners and admins get everything" test covers the positive rows automatically).

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/permissions.ts tests/permissions.test.ts
git commit -m "Add the organization.update permission for owners and admins"
```

---

### Task 5: Avatar file review helper and the two profile actions

**Files:**
- Create: `src/lib/profile/avatar-file.ts`
- Modify: `src/app/actions/profile.ts`
- Test: create `tests/avatar-file.test.ts`

**Interfaces:**
- Consumes: `UserRepository.updateOwnAvatar` (Task 2), `mutationContext`, `runAction`, `invalidInput`, `resolveDataSourceKind`, `createSupabaseServerClient` — all already imported or importable in `profile.ts`.
- Produces:
  - `reviewAvatarFile(file: { type: string; size: number }): { ok: true; extension: string } | { ok: false; reason: string }`
  - `MAX_AVATAR_BYTES = 5 * 1024 * 1024`, `AVATAR_ACCEPT` (comma-joined MIME types for the file input)
  - `updateOwnAvatarAction(formData: FormData): Promise<ActionResult<User>>`
  - `removeOwnAvatarAction(): Promise<ActionResult<User>>`

- [ ] **Step 1: Write the failing helper tests**

Create `tests/avatar-file.test.ts`:

```ts
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
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/avatar-file.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the helper**

Create `src/lib/profile/avatar-file.ts` (pure and free of `server-only`, for the same reason as `help-attachments.ts`: the file input and the action review the same file with the same rules):

```ts
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
```

- [ ] **Step 4: Run helper tests**

Run: `npx vitest run tests/avatar-file.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the two actions**

Append to `src/app/actions/profile.ts` (its header comment already explains the no-permission-check contract; extend the imports with `invalidInput` from `@/lib/data/errors`, `reviewAvatarFile` from `@/lib/profile/avatar-file`, and `randomUUID` from `node:crypto`):

```ts
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
```

Add `DataError` to the imports from `@/lib/data/errors`.

- [ ] **Step 6: Verify it compiles and nothing regressed**

Run: `npm test && npx tsc --noEmit`
Expected: green. (The actions themselves have no unit tests — session and storage need a running stack; the pure review logic, the repository write, and the schema all have them. This mirrors how `updateOwnProfileAction` is covered.)

- [ ] **Step 7: Commit**

```bash
git add src/lib/profile/avatar-file.ts src/app/actions/profile.ts tests/avatar-file.test.ts
git commit -m "Add avatar upload and removal actions with a shared file review"
```

---

### Task 6: The organization settings action

**Files:**
- Create: `src/app/actions/organization-settings.ts`
- Test: append to `tests/organization-settings.test.ts`

**Interfaces:**
- Consumes: `authorize` from `@/lib/actions/guard` (permission from Task 4), `organizations.update` (Task 3), `slugSchema`/`timezoneSchema`/`languageTagSchema` from `@/domain/primitives`.
- Produces: `updateOrganizationAction(input: unknown): Promise<ActionResult<Organization>>` and the exported `organizationDetailsSchema` (Task 8's form imports nothing from here except the action; the schema export exists to be tested).

- [ ] **Step 1: Write the failing schema tests**

Append to `tests/organization-settings.test.ts`:

```ts
import { organizationDetailsSchema } from "@/app/actions/organization-settings";

describe("organizationDetailsSchema", () => {
  const valid = {
    name: "Union Square Hospitality Group",
    slug: "ushg",
    industry: "Hospitality",
    websiteUrl: "https://www.ushg.com",
    defaultTimezone: "America/New_York",
    defaultLanguage: "en-US",
  };

  it("accepts a complete form", () => {
    expect(organizationDetailsSchema.safeParse(valid).success).toBe(true);
  });

  it("turns an empty website into null", () => {
    const parsed = organizationDetailsSchema.parse({ ...valid, websiteUrl: "" });
    expect(parsed.websiteUrl).toBeNull();
  });

  it("refuses a slug with the wrong shape", () => {
    for (const slug of ["Has Spaces", "UPPER", "trailing-", "-leading", "a"]) {
      expect(
        organizationDetailsSchema.safeParse({ ...valid, slug }).success,
      ).toBe(false);
    }
  });

  it("refuses a blank name and a bad URL", () => {
    expect(
      organizationDetailsSchema.safeParse({ ...valid, name: "  " }).success,
    ).toBe(false);
    expect(
      organizationDetailsSchema.safeParse({ ...valid, websiteUrl: "not a url" })
        .success,
    ).toBe(false);
  });
});
```

Note: `"a"` fails because `slugSchema` requires `min(2)`.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/organization-settings.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the action**

Create `src/app/actions/organization-settings.ts`:

```ts
"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import type { Organization } from "@/domain";
import {
  languageTagSchema,
  slugSchema,
  timezoneSchema,
} from "@/domain/primitives";
import { authorize } from "@/lib/actions/guard";
import { runAction, type ActionResult } from "@/lib/actions/result";

/**
 * Owners and admins editing the organization's own details.
 *
 * A separate file from `organization.ts` on purpose: that action switches
 * between organizations, this one changes what an organization *is* — the
 * concerns share a noun and nothing else.
 *
 * Validation reuses the schemas the entity already declares; the form invents
 * no rules of its own. The slug is the one field with teeth: globally unique,
 * so the repository maps a collision to a `slug` field error this action just
 * passes through.
 */

export const organizationDetailsSchema = z.object({
  name: z.string().trim().min(1, "Enter the organization's name.").max(160),
  slug: slugSchema,
  industry: z.string().trim().min(1, "Enter an industry.").max(120),
  websiteUrl: z
    .union([z.url("Enter a full URL, like https://example.com."), z.literal("")])
    .transform((value) => (value === "" ? null : value)),
  defaultTimezone: timezoneSchema,
  defaultLanguage: languageTagSchema,
});

export async function updateOrganizationAction(
  input: unknown,
): Promise<ActionResult<Organization>> {
  return runAction("organization.update", async () => {
    const parsed = organizationDetailsSchema.parse(input);
    const context = await authorize("organization.update");

    const updated = await context.dataSource.organizations.update(
      context.scope,
      parsed,
    );

    revalidatePath("/settings");
    return updated;
  });
}
```

Caveat for the implementer: a `"use server"` file may only export async functions. If the build rejects the schema export, move `organizationDetailsSchema` to `src/lib/settings/organization-details.ts` (no `server-only`), import it in the action, and point the test's import there. Prefer the co-located export if the toolchain accepts it.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/organization-settings.test.ts` then `npm test && npx tsc --noEmit`.
Expected: PASS. If the `"use server"` export constraint bites (it will under Next's compiler even when vitest passes — verify with `npm run build` here), apply the caveat above.

- [ ] **Step 5: Commit**

```bash
git add src/app/actions/organization-settings.ts tests/organization-settings.test.ts
git commit -m "Add the organization details action behind organization.update"
```

---

### Task 7: Avatar component renders photos

**Files:**
- Modify: `src/components/ui/avatar.tsx`

**Interfaces:**
- Produces: `AvatarProps` gains `imageUrl?: string | null`. When set and loadable, the photo renders clipped to the circle; initials remain the fallback (absent URL, or the image failed to load). Tasks 8 and 9 pass it.

- [ ] **Step 1: Implement**

Replace the body of `src/components/ui/avatar.tsx` (it becomes a client component — the load-error fallback is state, and the component is a childless leaf, so the boundary costs nothing):

```tsx
"use client";

import { useState } from "react";
import { cn } from "@/lib/cn";

const SIZES = {
  xs: "size-6 text-[10px]",
  sm: "size-7 text-[11px]",
  md: "size-9 text-[13px]",
  lg: "size-11 text-sm",
} as const;

export interface AvatarProps {
  initials: string;
  /** A profile photo. Initials render when absent — or when it fails to load. */
  imageUrl?: string | null;
  name?: string;
  size?: keyof typeof SIZES;
  tone?: "light" | "dark";
  className?: string;
}

export function Avatar({
  initials,
  imageUrl,
  name,
  size = "md",
  tone = "light",
  className,
}: AvatarProps) {
  // Tracks which URL failed rather than a boolean, so a new upload gets a
  // fresh attempt without an effect to reset state.
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const showImage = Boolean(imageUrl) && imageUrl !== failedUrl;

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center justify-center overflow-hidden rounded-full font-semibold",
        tone === "light"
          ? "bg-gray-100 text-gray-700 ring-1 ring-gray-200 ring-inset"
          : "bg-purple-600 text-white",
        SIZES[size],
        className,
      )}
      role="img"
      aria-label={name ?? initials}
    >
      {showImage ? (
        // eslint-disable-next-line @next/next/no-img-element -- avatar URLs
        // are user uploads from storage (or data URLs in demo mode), not
        // assets next/image should be optimizing and licensing dimensions for.
        <img
          src={imageUrl ?? undefined}
          alt=""
          className="size-full object-cover"
          onError={() => setFailedUrl(imageUrl ?? null)}
        />
      ) : (
        initials
      )}
    </span>
  );
}
```

(If lint does not complain about `<img>`, drop the disable comment rather than carrying a dead exemption.)

- [ ] **Step 2: Verify**

Run: `npm run lint && npx tsc --noEmit && npm test`
Expected: green — every existing call site omits `imageUrl` and is unchanged. (No component rendering tests: the project has no DOM test environment, and adding one is not this feature's job.)

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/avatar.tsx
git commit -m "Let Avatar render a photo with initials as the fallback"
```

---

### Task 8: Profile panel photo row and settings page wiring

**Files:**
- Modify: `src/components/settings/profile-panel.tsx`
- Modify: `src/app/(app)/settings/page.tsx` (the `<ProfilePanel …>` call, ~line 105)

**Interfaces:**
- Consumes: `updateOwnAvatarAction`, `removeOwnAvatarAction` (Task 5), `AVATAR_ACCEPT`, `reviewAvatarFile` (Task 5), `Avatar` with `imageUrl` (Task 7), `initialsFor` from `@/lib/view-models/mention`.
- Produces: `ProfilePanel` props gain `avatarUrl: string | null`; the page passes `self.avatarUrl`.

- [ ] **Step 1: Add the photo row to ProfilePanel**

In `src/components/settings/profile-panel.tsx`:

1. Extend props: `avatarUrl: string | null` alongside the existing three.
2. Extend the header comment: the photo uploads on file choice — there is nothing else to fill in, so a separate save step would be ceremony.
3. Add imports: `useRef` (react), `updateOwnAvatarAction, removeOwnAvatarAction` (the actions file already imported), `Avatar` from `@/components/ui/avatar`, `AVATAR_ACCEPT, reviewAvatarFile` from `@/lib/profile/avatar-file`, `initialsFor` from `@/lib/view-models/mention`.
4. Inside the component add photo state and handlers (a second, separate pending flag — a photo upload must not disable the name save, they are different requests):

```tsx
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [photoError, setPhotoError] = useState<string | null>(null);
  const [photoPending, startPhotoTransition] = useTransition();

  function choosePhoto(file: File | null) {
    if (!file) return;
    setPhotoError(null);

    // Same review the server runs — catches a wrong pick before the upload.
    const review = reviewAvatarFile(file);
    if (!review.ok) {
      setPhotoError(review.reason);
      return;
    }

    const formData = new FormData();
    formData.set("avatar", file);
    startPhotoTransition(async () => {
      const result = await updateOwnAvatarAction(formData);
      if (!result.ok) {
        setPhotoError(result.error);
        return;
      }
      router.refresh();
    });
  }

  function removePhoto() {
    setPhotoError(null);
    startPhotoTransition(async () => {
      const result = await removeOwnAvatarAction();
      if (!result.ok) {
        setPhotoError(result.error);
        return;
      }
      router.refresh();
    });
  }
```

5. Render the row between the `CardHeader` and the name form:

```tsx
      <div className="mt-4 flex items-center gap-3">
        <Avatar
          initials={initialsFor(`${firstName} ${lastName}`.trim() || email)}
          imageUrl={avatarUrl}
          name="Your profile photo"
          size="lg"
        />
        <div className="flex items-center gap-2">
          <Button
            type="button"
            variant="secondary"
            disabled={photoPending}
            onClick={() => fileInputRef.current?.click()}
          >
            {photoPending ? "Uploading…" : "Upload photo"}
          </Button>
          {avatarUrl ? (
            <Button
              type="button"
              variant="ghost"
              disabled={photoPending}
              onClick={removePhoto}
            >
              Remove
            </Button>
          ) : null}
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept={AVATAR_ACCEPT}
          className="sr-only"
          aria-label="Choose a profile photo"
          onChange={(event) => {
            choosePhoto(event.target.files?.[0] ?? null);
            event.target.value = "";
          }}
        />
      </div>

      {photoError ? (
        <p
          role="alert"
          className="mt-3 flex items-start gap-1.5 rounded-lg border border-red-600/20 bg-red-100 px-3 py-2.5 text-[13px] text-gray-950"
        >
          <AlertTriangle className="mt-px size-4 shrink-0 text-red-600" aria-hidden />
          {photoError}
        </p>
      ) : null}
```

Check `Button`'s actual variants in `src/components/ui/button.tsx` first (`secondary`/`ghost` are assumptions — use whatever the file defines for a bordered and a quiet button). Resetting `event.target.value` lets someone re-pick the same file after a failure.

- [ ] **Step 2: Pass the URL from the page**

In `src/app/(app)/settings/page.tsx`, add `avatarUrl={self.avatarUrl}` to the `<ProfilePanel>` call.

- [ ] **Step 3: Verify**

Run: `npm run lint && npx tsc --noEmit && npm test`
Expected: green.

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/profile-panel.tsx "src/app/(app)/settings/page.tsx"
git commit -m "Add photo upload and removal to the profile panel"
```

---

### Task 9: Organization panel, page swap, header button removal

**Files:**
- Create: `src/components/settings/organization-panel.tsx`
- Modify: `src/app/(app)/settings/page.tsx`

**Interfaces:**
- Consumes: `updateOrganizationAction` (Task 6), `can(context.role, "organization.update")` (Task 4), existing `Card`/`CardHeader`/`Button`/`DetailField`.
- Produces: `OrganizationPanel({ organization })` — client form for editors. Non-editors keep the existing read-only card, rendered by the page.

- [ ] **Step 1: Write OrganizationPanel**

Create `src/components/settings/organization-panel.tsx`, modeled directly on `ProfilePanel` (same input class, same error/saved affordances, same transition flow):

```tsx
"use client";

import { useId, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, Save } from "lucide-react";
import { updateOrganizationAction } from "@/app/actions/organization-settings";
import { Button } from "@/components/ui/button";
import { Card, CardHeader } from "@/components/ui/card";

/**
 * Owners and admins editing the organization's details in place.
 *
 * Rendered only for holders of `organization.update` — the settings page keeps
 * the read-only card for everyone else, so this client island never ships to
 * a viewer. Field errors land under their fields; the slug's uniqueness
 * conflict arrives the same way, mapped by the repository.
 */

const INPUT_CLASS =
  "h-10 w-full rounded-[10px] border border-gray-300 bg-white px-3 text-[13.5px] text-gray-950 outline-none focus-visible:border-purple-600 focus-visible:ring-2 focus-visible:ring-purple-600/20";

const FIELDS = [
  { name: "name", label: "Name", autoComplete: "organization" },
  { name: "slug", label: "Slug", hint: "Must be unique. Appears in support correspondence." },
  { name: "industry", label: "Industry" },
  { name: "websiteUrl", label: "Website", placeholder: "https://" },
  { name: "defaultTimezone", label: "Default timezone" },
  { name: "defaultLanguage", label: "Default language" },
] as const;

export function OrganizationPanel({
  organization,
}: {
  organization: {
    name: string;
    slug: string;
    industry: string;
    websiteUrl: string | null;
    defaultTimezone: string;
    defaultLanguage: string;
  };
}) {
  const router = useRouter();
  const idPrefix = useId();

  const [error, setError] = useState<string | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [saved, setSaved] = useState(false);
  const [pending, startTransition] = useTransition();

  function submit(formData: FormData) {
    setError(null);
    setFieldErrors({});
    setSaved(false);

    startTransition(async () => {
      const result = await updateOrganizationAction({
        name: formData.get("name"),
        slug: formData.get("slug"),
        industry: formData.get("industry"),
        websiteUrl: formData.get("websiteUrl"),
        defaultTimezone: formData.get("defaultTimezone"),
        defaultLanguage: formData.get("defaultLanguage"),
      });

      if (!result.ok) {
        setError(result.error);
        setFieldErrors(result.fieldErrors ?? {});
        return;
      }

      setSaved(true);
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader
        title="Organization details"
        description="Used as the default for every location."
      />

      <form action={submit} className="mt-4 flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-2">
          {FIELDS.map((field) => (
            <div key={field.name} className="flex flex-col gap-1.5">
              <label
                htmlFor={`${idPrefix}-${field.name}`}
                className="text-[13px] font-medium text-gray-950"
              >
                {field.label}
              </label>
              <input
                id={`${idPrefix}-${field.name}`}
                name={field.name}
                defaultValue={organization[field.name] ?? ""}
                required={field.name !== "websiteUrl"}
                autoComplete={"autoComplete" in field ? field.autoComplete : undefined}
                placeholder={"placeholder" in field ? field.placeholder : undefined}
                aria-describedby={
                  "hint" in field ? `${idPrefix}-${field.name}-hint` : undefined
                }
                aria-invalid={field.name in fieldErrors || undefined}
                className={INPUT_CLASS}
              />
              {"hint" in field && !(field.name in fieldErrors) ? (
                <p
                  id={`${idPrefix}-${field.name}-hint`}
                  className="text-[12px] text-gray-500"
                >
                  {field.hint}
                </p>
              ) : null}
              {field.name in fieldErrors ? (
                <p role="alert" className="text-[12px] text-red-600">
                  {fieldErrors[field.name]}
                </p>
              ) : null}
            </div>
          ))}
        </div>

        {error ? (
          <p
            role="alert"
            className="flex items-start gap-1.5 rounded-lg border border-red-600/20 bg-red-100 px-3 py-2.5 text-[13px] text-gray-950"
          >
            <AlertTriangle className="mt-px size-4 shrink-0 text-red-600" aria-hidden />
            {error}
          </p>
        ) : null}

        <div className="flex items-center gap-3">
          <Button type="submit" variant="primary" icon={Save} disabled={pending}>
            {pending ? "Saving…" : "Save details"}
          </Button>
          {saved ? (
            <p role="status" className="text-[13px] text-green-700">
              Saved.
            </p>
          ) : null}
        </div>
      </form>
    </Card>
  );
}
```

- [ ] **Step 2: Swap it into the page and drop the dead header button**

In `src/app/(app)/settings/page.tsx`:

1. Compute `const canEditOrganization = can(context.role, "organization.update");` next to `canManage`.
2. Replace the read-only organization `<Card>` with a conditional — editors get the panel, everyone else keeps the exact existing card:

```tsx
          {canEditOrganization ? (
            <OrganizationPanel organization={organization} />
          ) : (
            <Card>
              {/* …the existing CardHeader + DetailField grid, unchanged… */}
            </Card>
          )}
```

3. Remove the `actions={<Button …>Save changes</Button>}` prop from `PageHeader` — it has never been wired to anything, and beside real per-card saves a decorative button reads as a broken one. Drop the now-unused `Button` and `Save` imports.
4. Add the `OrganizationPanel` import.

- [ ] **Step 3: Verify**

Run: `npm run lint && npx tsc --noEmit && npm test`
Expected: green. Also check the page file is still under ~300 lines.

- [ ] **Step 4: Commit**

```bash
git add src/components/settings/organization-panel.tsx "src/app/(app)/settings/page.tsx"
git commit -m "Let owners and admins edit organization details in settings"
```

---

### Task 10: Photos everywhere — session, sidebar, team roster

**Files:**
- Modify: `src/lib/auth/session.ts`
- Modify: `src/app/(app)/layout.tsx`
- Modify: `src/components/shell/user-menu.tsx`
- Modify: `src/components/settings/team-panel.tsx`

**Interfaces:**
- Consumes: `Avatar` `imageUrl` (Task 7), auth metadata `avatar_url` (synced by Task 5), seed users' `avatarUrl` (already in the dataset, currently null).
- Produces: `SessionUser` gains `avatarUrl: string | null`; `UserMenuUser` gains `avatarUrl: string | null`.

- [ ] **Step 1: Carry the avatar through the session**

In `src/lib/auth/session.ts`:

1. Add `avatarUrl: string | null;` to `SessionUser`.
2. Demo branch: return `avatarUrl: user.avatarUrl` (the seed rows carry the field).
3. Supabase branch: widen the metadata cast to `{ full_name?: unknown; avatar_url?: unknown }` and return `avatarUrl: typeof metadata?.avatar_url === "string" ? metadata.avatar_url : null` — same trust-but-verify shape as `full_name`, and the same reasoning: the sidebar reads session metadata, not `public.users`, so the best-effort sync in the avatar action is what keeps this fresh.

- [ ] **Step 2: Pass it to the sidebar**

In `src/app/(app)/layout.tsx`, add `avatarUrl: session.avatarUrl,` to the `user` object.

In `src/components/shell/user-menu.tsx`, add `avatarUrl: string | null;` to `UserMenuUser` and pass it through:

```tsx
        <Avatar
          initials={user.initials}
          imageUrl={user.avatarUrl}
          name={user.name}
          size="sm"
          tone="dark"
        />
```

(Check whether `AppShell`/`Sidebar` type the `user` prop separately — `src/components/shell/app-shell.tsx` and `sidebar.tsx` both take it; extend any intermediate type the compiler flags.)

- [ ] **Step 3: Add avatars to the team roster**

In `src/components/settings/team-panel.tsx`, the member cell gains the photo (the spec's "member list" — it currently renders name and email only). Import `Avatar` and `initialsFor` (from `@/lib/view-models/mention`), then:

```tsx
      cell: (member) => (
        <span className="flex items-center gap-2.5">
          <Avatar
            initials={initialsFor(member.user.fullName)}
            imageUrl={member.user.avatarUrl}
            name={member.user.fullName}
            size="sm"
          />
          <span className="min-w-0">
            <span className="block truncate font-medium text-gray-950">
              {member.user.fullName}
            </span>
            <span className="block truncate text-[12px] text-gray-500">
              {member.user.email}
            </span>
          </span>
        </span>
      ),
```

(`TeamPanel` is a server component composing client islands; `Avatar` becoming a client component is fine — it is itself an island.)

- [ ] **Step 4: Verify**

Run: `npm run lint && npx tsc --noEmit && npm test`
Expected: green.

- [ ] **Step 5: Commit**

```bash
git add src/lib/auth/session.ts "src/app/(app)/layout.tsx" src/components/shell/user-menu.tsx src/components/settings/team-panel.tsx
git commit -m "Render profile photos in the sidebar and team roster"
```

---

### Task 11: Full verification and database push

**Files:** none new.

- [ ] **Step 1: Full local verification**

Run: `npm test && npm run lint && npm run build`
Expected: all green. Fix anything that isn't before proceeding (the `"use server"` schema-export caveat from Task 6 is the likely build-stage surprise).

- [ ] **Step 2: Exercise both features against the demo adapter**

Run the dev server (`npm run dev`), sign in as the demo admin, and on `/settings`: upload a PNG (appears in the panel, the sidebar chip, and the team roster), remove it, change the org name and slug, save, and confirm a slug collision with the second tenant's slug shows "That slug is already taken." under the field.

- [ ] **Step 3: Apply the storage migration to production**

Run: `npx supabase db push`
Expected: `20260808000500` applies. Verify with `npx supabase migration list` — local and remote agree.

- [ ] **Step 4: Commit anything outstanding**

The working tree should already be clean; if verification forced fixes, commit them with a message describing the fix.

---

## Self-review notes

- **Spec coverage:** photos (bucket → Task 1, actions → Task 5, component → Task 7, panel → Task 8, everywhere-rendering → Task 10); org details (permission → Task 4, repository+conflict → Task 3, action → Task 6, panel+header-button removal → Task 9); doctrine comment revisions → Task 3. The spec's "RLS update policy on organizations" is intentionally not implemented — `organizations_update_admins` already exists (migration `20260801000200`, verified) and names exactly owner/admin.
- **Deviation from spec, deliberate:** assignee pickers and timelines render mention *authors* and free-text names, not `User` rows — there is nothing to wire there. "Everywhere avatars show" for actual users means the sidebar chip and the team roster, both covered.
- **Type consistency:** `updateOwnAvatar(userId, avatarUrl)` (Tasks 2→5), `slug?: string` on `UpdateOrganizationInput` (Tasks 3→6), `imageUrl` on `AvatarProps` (Tasks 7→8/10), `avatarUrl: string | null` on `ProfilePanel`/`UserMenuUser`/`SessionUser` (Tasks 8/10) — names checked against each other.
