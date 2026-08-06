-- ---------------------------------------------------------------------------
-- Split a person's name into first and last
--
-- Sign-up now collects first and last name separately, and settings lets a
-- person edit them, so `public.users` stores the parts. `full_name` stays —
-- every member list, assignee picker, and audit attribution renders it — but
-- it becomes a STORED GENERATED column, so the display name cannot drift from
-- the parts it is made of. That rules out the drift bug by construction
-- rather than by discipline, the same reasoning as the profile-mirror trigger.
--
-- Existing rows are backfilled by splitting on the first space: everything
-- before it is the first name, everything after it the last. That is lossy in
-- general — names do not reliably decompose — but every pre-existing row here
-- came from sign-up or the seed, both of which composed `full_name` from
-- exactly those two parts with a single space, so the split reproduces the
-- original for every row that actually exists.
-- ---------------------------------------------------------------------------

alter table public.users add column first_name text;
alter table public.users add column last_name text;

update public.users
   set first_name = split_part(full_name, ' ', 1),
       last_name  = btrim(substr(full_name, length(split_part(full_name, ' ', 1)) + 1));

alter table public.users alter column first_name set not null;
alter table public.users alter column last_name set not null;

-- Empty last names are allowed — an account created from the Supabase
-- dashboard falls back to the email local part, which has no last half. An
-- empty *first* name is not: it would render a blank display name.
alter table public.users
  add constraint users_first_name_not_blank check (btrim(first_name) <> '');

alter table public.users drop column full_name;

alter table public.users
  add column full_name text
    generated always as (btrim(first_name || ' ' || last_name)) stored
    not null;

comment on column public.users.first_name is
  'Collected at sign-up, editable in settings. Never blank.';
comment on column public.users.last_name is
  'May be empty: accounts created without one (e.g. from the auth dashboard) have nothing to put here.';
comment on column public.users.full_name is
  'Generated from first_name and last_name. Read everywhere a person is displayed; written nowhere.';

-- ---------------------------------------------------------------------------
-- Profile mirror, updated for the parts
--
-- Same contract as before (see 20260805000100): every new auth account gets a
-- profile row, and one created with no metadata at all still succeeds by
-- falling back to the email local part. Sign-up writes `first_name` and
-- `last_name` metadata now; `full_name` remains understood so accounts
-- created before this migration's deploy — or by older tooling — still mirror
-- with a real name instead of the fallback.
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  meta_first text := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'first_name', '')), '');
  meta_last  text := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'last_name', '')), '');
  meta_full  text := nullif(btrim(coalesce(new.raw_user_meta_data ->> 'full_name', '')), '');
begin
  insert into public.users (id, email, first_name, last_name, avatar_url)
  values (
    new.id,
    new.email,
    coalesce(
      meta_first,
      split_part(meta_full, ' ', 1),
      split_part(new.email, '@', 1)
    ),
    coalesce(
      meta_last,
      case
        when meta_full is not null
          then btrim(substr(meta_full, length(split_part(meta_full, ' ', 1)) + 1))
      end,
      ''
    ),
    nullif(trim(new.raw_user_meta_data ->> 'avatar_url'), '')
  )
  on conflict (id) do nothing;

  return new;
end;
$$;

comment on function public.handle_new_auth_user is
  'Mirrors a new auth account into public.users so auth.users.id = public.users.id holds by construction. Reads first_name/last_name metadata, falling back to splitting full_name, then to the email local part.';
