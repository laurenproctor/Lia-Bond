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
