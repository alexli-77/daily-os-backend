-- Sticky board sync (LEO-358): teammates can read each other's shared board.
--
-- Same shape and same rules as `cycles` / `daily_plans` (see the init migration
-- and supabase/README.md): local files are the source of truth, this table is a
-- transport, and nothing reads a row back into the owner's own data. Read-only
-- for teammates — there is no path that writes a pulled row into a local store.
--
-- Keyed by (team_id, owner): one row per person, holding their whole shared
-- board as a snapshot. `owner` is auth.uid(), never a display label, for the
-- reasons the README gives for `cycles`. Sharing is opt-in on the owner's
-- machine (reminders.share_with_team, default off); when they turn it off the
-- client deletes its own row, so the board disappears for teammates. Idempotent
-- — safe to re-run.

create table if not exists public.stickies (
  team_id    uuid not null references public.teams (id),
  owner      uuid not null default auth.uid(),
  payload    jsonb not null,            -- { items: [ { id, text, color, x, y, w, h, nextSurface, ... } ] }
  updated_at timestamptz not null default now(),
  primary key (team_id, owner)
);

-- Polled by updated_at within a team, exactly like cycles / daily_plans.
create index if not exists stickies_team_updated_at_idx
  on public.stickies (team_id, updated_at desc);

drop trigger if exists stickies_touch_updated_at on public.stickies;
create trigger stickies_touch_updated_at
  before update on public.stickies
  for each row execute function public.touch_updated_at();

alter table public.stickies enable row level security;

-- Read: every row in your team. Write: only your own row, only inside your team.
-- Both write conditions are load-bearing; the cycles policies in the init
-- migration explain why each one is needed on its own.
drop policy if exists stickies_select_team on public.stickies;
create policy stickies_select_team on public.stickies
  for select to authenticated
  using (team_id = public.current_team_id());

drop policy if exists stickies_insert_own on public.stickies;
create policy stickies_insert_own on public.stickies
  for insert to authenticated
  with check (
    owner = auth.uid()
    and team_id = public.current_team_id()
  );

drop policy if exists stickies_update_own on public.stickies;
create policy stickies_update_own on public.stickies
  for update to authenticated
  using (owner = auth.uid())
  with check (
    owner = auth.uid()
    and team_id = public.current_team_id()
  );

drop policy if exists stickies_delete_own on public.stickies;
create policy stickies_delete_own on public.stickies
  for delete to authenticated
  using (owner = auth.uid());
