# Settings: profile photos and editable organization details

Two additions to `/settings`, sharing a release because they are the two
halves of the same page growing up: the profile panel gains a photo, and the
organization details card stops being read-only for the people allowed to
change it.

## Feature 1: profile photos

Every user may upload a photo of themselves. The photo replaces initials
everywhere the `Avatar` component renders a person — sidebar account chip,
team member list, assignee pickers, timelines — with initials remaining the
fallback for users who have no photo and for images that fail to load.

### What already exists

- `users.avatar_url` is in the schema (`src/domain/entities/organization.ts`,
  `userSchema.avatarUrl`, nullable URL) and is mirrored from auth metadata by
  `handle_new_auth_user`. Today it is always null in practice.
- `Avatar` (`src/components/ui/avatar.tsx`) renders initials only.
- No Supabase Storage bucket exists yet anywhere in the project.

### Storage

A new `avatars` Supabase Storage bucket, created by migration:

- **Public read.** An avatar URL is rendered in `<img>` tags across the app;
  it is not sensitive, and public-read buckets let the CDN cache it.
- **Writes scoped per user.** Insert/update/delete policies allow an
  authenticated user to touch only objects under their own `{userId}/`
  prefix. Nobody uploads anyone else's face.
- **Object path** `{userId}/{random}.{ext}` — the random segment makes each
  upload a new URL, so browsers never serve a stale cached photo after a
  change.

### Server actions

Both live in `src/app/actions/profile.ts` beside `updateOwnProfileAction`,
and follow its contract exactly: no permission check (every role owns their
own face), target id always from the session, `ActionResult` return.

- `updateOwnAvatarAction(formData)` — accepts one file, PNG/JPEG/WebP, ≤ 5 MB.
  Validates server-side (a file picker is a suggestion), uploads to the
  bucket, writes the public URL through a new
  `UserRepository.updateOwnAvatar(userId, url)`, syncs `avatar_url` auth
  metadata best-effort (same pattern and same reasoning as the name sync),
  and best-effort deletes the previous object so the bucket does not
  accumulate orphans. `revalidatePath("/settings")`.
- `removeOwnAvatarAction()` — writes null through the same repository
  method, deletes the object best-effort, syncs metadata.

The demo data source implements `updateOwnAvatar` by storing the value in
memory; the demo upload path converts the file to a data URL so demo mode
works with no storage at all.

### Rendering

`Avatar` gains an optional `imageUrl` prop. When present, it renders the
image clipped to the same circle; on load error it falls back to initials
(state flip on `onError`, which makes `Avatar` a client component — it is a
leaf with no children, so the boundary cost is nil). Existing call sites
that render a person pass `avatarUrl` through.

### Profile panel

`ProfilePanel` (`src/components/settings/profile-panel.tsx`) gains a photo
row above the name fields: the current avatar at `lg`, an "Upload photo"
button fronting a hidden file input (`accept` limited to the three types),
and a "Remove" button shown only when a photo exists. Upload submits
immediately on file choice — there is nothing else to fill in, so a separate
save step would be ceremony. Errors (wrong type, too big, upload failure)
render in the panel's existing alert slot.

## Feature 2: editable organization details

Owners and admins edit the organization's details in place; every other
role keeps the current read-only card.

### Permission

New `organization.update` permission in `src/lib/auth/permissions.ts`,
granted to `["owner", "admin"]`. Not a reuse of
`organization.manage_members`: who runs the roster and who defines the
organization's identity are different questions, and the matrix's value is
that each answer is legible on its own row.

### Fields

All six currently displayed: name, slug, industry, website URL, default
timezone, default language. Validation reuses the schemas the organization
entity already declares (`slugSchema`, `timezoneSchema`,
`languageTagSchema`, the length caps on name and industry); the form invents
no new rules.

**The slug becomes editable**, revising its "stable once issued" doctrine.
That comment predates the finding that the slug appears in no URL and no
route — organization context is session-based, switching is by id, and the
slug's only appearances are the settings page itself and a metadata field in
support emails. The field carries an inline hint ("Must be unique. Appears
in support correspondence.") and a uniqueness conflict maps to a friendly
"That slug is already taken." rather than a raw database error. The entity
comment is updated to match the new doctrine.

### Data path

- `OrganizationRepository.updateDetails(scope, input)` — scoped like every
  other organization write.
- Migration adds an RLS `update` policy on `organizations` for active
  owner/admin memberships. Application code checks the permission too, as
  everywhere: RLS is the backstop, `can()` is the contract.
- `updateOrganizationAction` in a new `src/app/actions/organization-settings.ts`
  (the existing `organization.ts` action file handles switching, a different
  concern): zod parse, `mutationContext`, `can(role, "organization.update")`
  or reject, repository write, unique-violation mapping, revalidate.

### UI

The read-only "Organization details" card in
`src/app/(app)/settings/page.tsx` is replaced by an `OrganizationPanel`
client component (`src/components/settings/organization-panel.tsx`):

- With `organization.update`: a form styled like `ProfilePanel` — six
  labelled inputs (timezone and language as text inputs matching current
  values; a curated dropdown is future work if free text proves error-prone),
  its own save button, saved/error states.
- Without: the exact read-only `DetailField` grid rendered today.

The page header's global "Save changes" button is removed. It has never
been wired to anything, and once real per-card saves exist beside it, a
decorative one reads as a broken one.

## Errors and testing

Both features return `ActionResult` with field-level messages. Tests follow
`tests/profile.test.ts` patterns:

- Avatar action: rejects wrong MIME type, oversize file, missing file;
  demo-mode round-trip stores and clears the data URL.
- Organization action: rejects each invalid field; denies every role
  without `organization.update`; maps slug conflicts to the friendly error;
  demo-mode round-trip.
- Permission matrix: `organization.update` held by exactly owner and admin.
- `Avatar`: renders image when `imageUrl` present, initials otherwise and
  on image error.

## Out of scope

Client-side cropping or resizing, image moderation, org logo upload,
curated timezone/language dropdowns, and any change to how organization
context or switching works.
