-- Daily plan sync: teammates can read each other's "today" list.
--
-- Same shape and same rules as `cycles` (see 20260907000000_init.sql and
-- supabase/README.md). The row is a snapshot of what /api/today/plan returns on
-- the owner's machine: the ranked todos plus the owner's own complete / defer
-- state for that day. Local files stay the source of truth; this table is a
-- transport, and nothing reads a row back into the owner's own data.
--
-- Keyed by (team_id, owner, plan_date): one row per person per day. `owner` is
-- auth.uid(), never a display label, for the reasons the README gives for
-- `cycles`. Idempotent — safe to re-run.

create table if not exists public.daily_plans (
  team_id    uuid not null references public.teams (id),
  owner      uuid not null default auth.uid(),
  plan_date  date not null,             -- the plan's own date, in the owner's timezone
  payload    jsonb not null,            -- { generated_at, todos: [...], feedback: {...} }
  updated_at timestamptz not null default now(),
  primary key (team_id, owner, plan_date)
);

-- Polled by updated_at within a team, exactly like cycles.
create index if not exists daily_plans_team_updated_at_idx
  on public.daily_plans (team_id, updated_at desc);

drop trigger if exists daily_plans_touch_updated_at on public.daily_plans;
create trigger daily_plans_touch_updated_at
  before update on public.daily_plans
  for each row execute function public.touch_updated_at();

alter table public.daily_plans enable row level security;

-- Read: every row in your team. Write: only your own rows, only inside your
-- team. Both write conditions are load-bearing; the cycles policies in the init
-- migration explain why each one is needed on its own.
drop policy if exists daily_plans_select_team on public.daily_plans;
create policy daily_plans_select_team on public.daily_plans
  for select to authenticated
  using (team_id = public.current_team_id());

drop policy if exists daily_plans_insert_own on public.daily_plans;
create policy daily_plans_insert_own on public.daily_plans
  for insert to authenticated
  with check (
    owner = auth.uid()
    and team_id = public.current_team_id()
  );

drop policy if exists daily_plans_update_own on public.daily_plans;
create policy daily_plans_update_own on public.daily_plans
  for update to authenticated
  using (owner = auth.uid())
  with check (
    owner = auth.uid()
    and team_id = public.current_team_id()
  );

drop policy if exists daily_plans_delete_own on public.daily_plans;
create policy daily_plans_delete_own on public.daily_plans
  for delete to authenticated
  using (owner = auth.uid());
