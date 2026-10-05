-- supabase/accounts.sql
-- Optional Kovrio accounts: one row of saved progress per user.
-- Run this once in Supabase: Dashboard -> SQL Editor -> New query -> paste -> Run.
--
-- The security idea: the "anon" key in js/tracking.js ships to every
-- visitor's browser, so ANYONE can talk to this database. The rules below
-- (Row Level Security) are what stop one student from reading or editing
-- another student's progress. They run inside the database, so they can't
-- be skipped by editing the website's JavaScript in DevTools.

-- 1. The table. user_id is the logged-in user's id from Supabase Auth.
--    "on delete cascade" = if the account is deleted, its progress row is
--    deleted with it automatically.
create table if not exists public.user_progress (
  user_id    uuid primary key default auth.uid()
             references auth.users (id) on delete cascade,
  data       jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  -- Stops anyone from stuffing giant junk data into their own row.
  constraint user_progress_size check (pg_column_size(data) < 200000)
);

-- 2. Turn on Row Level Security. With RLS on and no policies, NOBODY can
--    touch the table. Each policy below opens exactly one door.
alter table public.user_progress enable row level security;

-- Logged-out visitors get nothing. Logged-in users get read/insert/update
-- (no delete: rows are only removed by deleting the whole account).
revoke all on public.user_progress from anon;
grant select, insert, update on public.user_progress to authenticated;

drop policy if exists "Users can read their own progress" on public.user_progress;
create policy "Users can read their own progress"
  on public.user_progress for select to authenticated
  using ((select auth.uid()) = user_id);

drop policy if exists "Users can create their own progress row" on public.user_progress;
create policy "Users can create their own progress row"
  on public.user_progress for insert to authenticated
  with check ((select auth.uid()) = user_id);

drop policy if exists "Users can update their own progress" on public.user_progress;
create policy "Users can update their own progress"
  on public.user_progress for update to authenticated
  using ((select auth.uid()) = user_id)
  with check ((select auth.uid()) = user_id);

-- 3. "Delete my account" button. The browser isn't allowed to delete users
--    directly, so this function does it with elevated rights ("security
--    definer") but ONLY ever for the person calling it (auth.uid()).
create or replace function public.delete_my_account()
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Not signed in';
  end if;
  delete from auth.users where id = auth.uid();
end;
$$;

revoke all on function public.delete_my_account() from public, anon;
grant execute on function public.delete_my_account() to authenticated;
