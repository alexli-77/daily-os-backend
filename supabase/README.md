# Supabase remote (LEO-281)

Local markdown stays the source of truth. This Supabase project is only a
transport channel so teammates can read each other's cycle files. Nothing in
Daily OS should require the remote to be reachable in order to work.

## Identity is a uuid, not a name

`cycles` is keyed by `(team_id, owner, cycle_id)`, where `owner` is `auth.uid()`
— the uuid auth issues once and never changes. `members.member_id` (`leon`,
`penguin`) is a **display label**. It is not identity, nothing keys off it, and
the person it belongs to can change it whenever they like.

The alternative — keying cycles on the short name — was tried first and is worse
in a way that is not obvious until you try to rename someone. The name lives in
two tables at once, so a rename either orphans every existing cycle or needs a
coordinated multi-table update. The only way to make that safe in RLS is to
forbid renaming outright, which trades a normal user action away for an
implementation detail. A uuid key removes the trade: rename freely, the rows are
still yours because they were never filed under your name to begin with.

`cycles` therefore has **no `member_id` column**. To show "penguin's week",
resolve `owner` against `members` at read time — the whole team's `members` rows
are readable, so this is a local join, not a round trip.

## The one rule that must never be broken

> **The client may only ever hold the `anon` key. Never ship, embed, commit, or
> paste the `service_role` key into anything that runs on a laptop.**

`service_role` has `BYPASSRLS`. Every policy in this directory becomes a no-op
the moment a client holds that key: any user could read every team's data and
overwrite anybody's rows. The whole point of enforcing read-only access in the
database rather than in client code is that client code is exactly what tends to
get ownership wrong. Handing the client `service_role` throws that away.

`service_role` belongs in two places only: the Supabase dashboard (which already
runs as a privileged role) and a server you control. Neither exists in this
project today.

## Files

| File | What it is |
| --- | --- |
| `migrations/20260907000000_init.sql` | Tables, helper functions, triggers, and every RLS policy. Idempotent — safe to re-run. |
| `migrations/20260919000000_daily_plans.sql` | The `daily_plans` table: each member's "today" list, same key shape and policies as `cycles`. Run it after the init migration. Idempotent. |
| `../scripts/verify-supabase-schema.mjs` | Asserts the policies actually hold, against a real project. |

## Applying the migration

Using the dashboard (what you want for a two-person setup):

1. Open the Supabase project → **SQL Editor** → **New query**.
2. Paste the entire contents of `migrations/20260907000000_init.sql`.
3. **Run**. It should finish with no errors.
4. Re-running it later is safe; the script drops and recreates its own policies
   and triggers rather than failing on conflicts.

If you applied an **earlier draft** of this file to a scratch project — the one
where `cycles` had a `member_id` column and was keyed `(team_id, member_id,
cycle_id)` — re-running is not enough, and it fails *silently*: `create table if
not exists` leaves the old table untouched, the run reports success, and you end
up with the new policies bolted onto the old key. Drop the table first and
re-run. Nothing is deployed, so there is nothing to preserve:

```sql
drop table if exists public.cycles;
```

The rest of the file upgrades in place, including dropping the now-unused
`public.current_member_id()`.

Using the Supabase CLI instead, if you already have it linked:

```bash
supabase db push
```

The migration is intentionally plain SQL with no CLI-only syntax, so both paths
produce the same schema.

### Daily plans (second migration)

`daily_plans` is keyed `(team_id, owner, plan_date)` and holds a JSON snapshot
of what `/api/today/plan` returns on the owner's machine: the ranked todos plus
that person's own complete / defer state for the day. The client pushes it
within about a second of the snapshot changing — ticking a row, or a finished
`daily_plan` run — and again on the 60 s tick as a backstop, in both cases only
when the snapshot's hash has actually moved. It pulls teammates' rows for today
and yesterday into `data/team-cache/<owner uuid>/daily/<date>.json`. The Today
page and `GET /api/team/today` read that cache; nothing reads a row back into
the owner's own data.

Cycle rows are pushed the same way, driven by an `fs.watch` on the cycles
directory, so an edit made in Obsidian or by the planner leaves the machine as
quickly as one made in the console.

A pulled row is applied only when its server `updated_at` is strictly newer than
the version already cached, so a duplicate or out-of-order delivery is a no-op
rather than a rollback. That version is the one the `touch_updated_at` trigger
stamps: client clocks do not participate, which is also why the trigger must not
be removed.

### Retention

`daily_plans` is a rolling window, not a history:

- locally, cached **teammate** plan files older than 7 days are deleted on each
  tick;
- remotely, the client deletes its **own** rows older than 30 days, at most once
  a day, using `daily_plans_delete_own`.

`cycles` has no retention on either side, deliberately — those rows are the
team's shared review history.

Until this migration has been run, PostgREST answers the table with `PGRST205`.
The client treats that as "daily plan sync not enabled": cycles keep syncing and
the Today page says which file to run.

## Creating the first team and its members

Since LEO-283 this is **self-service, from the Daily OS console** (Setup → Team).
It is not a console-only SQL operation any more, and it is deliberately still not
an ordinary table write — see "Why joining is an RPC" below.

1. Each person signs up from Setup → Team (email + password + display name).
   The display name is passed as signup metadata:

   ```json
   { "member_id": "leon", "display_name": "Leon" }
   ```

   If the metadata is missing, the trigger falls back to the email local part.

   The user controls this metadata, and that is fine. `member_id` is a label,
   grants nothing, and is not a key — the account's identity is the uuid auth
   assigns. The worst a chosen value can do is collide with a teammate's label
   when joining and raise a unique violation, which is a rejected statement
   rather than something to clean up. Either person can then just rename.

2. The first person clicks **创建团队**. That calls:

   ```sql
   select public.create_team('daily-os');   -- returns the new team uuid
   ```

3. They copy the invite code the panel shows and send it to the second person,
   who pastes it into **用邀请码加入**:

   ```sql
   select public.join_team('<invite code>'); -- returns the team uuid
   ```

4. Leaving and rotating the invite code are the same shape:

   ```sql
   select public.leave_team();
   select public.rotate_invite_code();       -- returns the new code
   ```

Adding a third person later is just another invite code. **Renaming** stays a
plain client update: anyone can change their own `member_id` at any time, and
their cycles follow them, because those rows are filed under `owner`.

### Why joining is an RPC and not a policy

Neither operation can be expressed as a client write under the policies below,
and that is the design, not a gap:

* **Creating** a team needs two writes — insert into `teams`, then set the
  creator's `members.team_id`. Adding an insert policy to `teams` does not help,
  because the second write is exactly what RLS pins: the creator would end up
  with a team they cannot join. Both halves have to happen in one transaction as
  a privileged role.
* **Joining** needs to change `members.team_id`, which is the input to
  `current_team_id()` and therefore to every read policy. Any policy permissive
  enough to allow a real join is permissive enough to let someone who guesses a
  team uuid read that team's cycles. The invite code is what tells the two cases
  apart, and a policy cannot check a code the client is also free to write around.

The four functions are `security definer` with `set search_path = public,
pg_temp` (an unpinned search_path on a definer function lets the caller swap in
their own `members` table), take no "on behalf of" argument — the subject is
always `auth.uid()` — and have `EXECUTE` revoked from `PUBLIC` and granted only
to `authenticated`. `join_team` acts only while the caller's `team_id is null`,
so it cannot be used to hop between teams, and it locks the caller's own row
before checking, so two concurrent calls cannot both see "no team yet". Invite
codes come from `gen_random_uuid()` (pg_strong_random, 128 bits, no ordering),
never from a sequence or anything derived from the team name.

## What the policies guarantee

| Table | Read | Write |
| --- | --- | --- |
| `teams` | Only your own team's row. | Nobody, directly. `create_team()` / `rotate_invite_code()` only. |
| `members` | Your own row, plus everyone in your team. | Your own row: `member_id` and `display_name` are yours to change. `team_id` is pinned — only `join_team()` / `leave_team()` move it. No deletes. |
| `cycles` | Every row belonging to your team. | Only rows where `owner = auth.uid()` **and** `team_id` is your team. |
| `daily_plans` | Every row belonging to your team. | Same as `cycles`. |

Both conditions on `cycles` writes are load-bearing, and they cover different
things.

`owner = auth.uid()` is what makes primary-key squatting impossible. Under the
old text key `(team_id, member_id, cycle_id)`, `owner` was not part of the key,
so a client with a broken ownership calculation could insert a row it genuinely
owned at a coordinate a teammate was about to use — and that teammate's own
write would then fail on a unique violation. Now `owner` *is* in the key, and the
policy forces it to the caller's uid, so the set of keys a user can write is
exactly the set containing their own uid. Two users' key spaces cannot intersect.
The third condition that used to close this hole is gone because the hole is
gone, not because it was relaxed.

`team_id = public.current_team_id()` does not follow from the owner check and is
still required. Without it a user could insert rows they legitimately own into a
team they do not belong to. They could not read them back — `cycles_select_team`
is scoped to their own team — but that team's members could: an injection channel
into somebody else's read surface. On `UPDATE` the same condition stops a user
dragging their own row out of the team.

`WITH CHECK` also blocks rewriting `owner` on an existing row, so a user can
neither hand a row to a teammate nor take one.

`team_id` on `members` stays pinned for a separate reason: `current_team_id()`
is the input to every read policy, so letting a user set it is letting them read
any team. Unpinning `member_id` does not weaken that — the two columns were
pinned in the same clause but never for the same reason.

Unauthenticated requests match no policy at all: every policy is scoped to the
`authenticated` role, so a bare anon key with no session reads and writes
nothing.

### What renaming still cannot do

`unique (team_id, member_id)` means you cannot rename yourself onto a label a
teammate is currently using. It does **not** stop you taking a label a teammate
used to have. That is a UI-level confusion at worst — no row changes hands,
because nothing is filed under the label — but it is a reason for the client to
render from `owner` and treat `member_id` as presentation.

## Running the verification script

The script uses nothing but the anon key and two ordinary user sessions, so it
exercises the same surface a client has. It has no npm dependencies.

```bash
export SUPABASE_URL="https://<project-ref>.supabase.co"
export SUPABASE_ANON_KEY="<anon key>"
export SUPABASE_TEST_A_EMAIL="leon@example.com"
export SUPABASE_TEST_A_PASSWORD="..."
export SUPABASE_TEST_B_EMAIL="penguin@example.com"
export SUPABASE_TEST_B_PASSWORD="..."

# Optional but recommended: a team that user A is NOT a member of.
# Without it the cross-team read check is skipped, not passed.
export SUPABASE_TEST_OTHER_TEAM_ID="<uuid of a second team>"

# Optional: a third account that belongs to NO team. Without it the whole
# create_team / join_team / leave_team lifecycle is skipped, not passed.
export SUPABASE_TEST_C_EMAIL="spare@example.com"
export SUPABASE_TEST_C_PASSWORD="..."
# Optional: also verify create_team's success path. Off by default because
# `teams` has no delete policy, so each run leaves an orphan team row behind.
export SUPABASE_TEST_ALLOW_TEAM_CREATE=1

npm run verify:supabase
```

It checks that:

- the signup trigger produced `members` rows from the signup metadata;
- A and B are in the same team and can read each other;
- A can write and delete their own cycle, and `owner` defaults to A's uuid;
- `updated_at` is refreshed by the trigger and cannot be backdated by the client;
- **A can rename their own `member_id`, and afterwards still owns and can still
  write every cycle they had before the rename** — the check the old text key
  could not have passed;
- A cannot rename onto B's current label;
- A cannot update B's cycle, insert into B's key space, forge `owner`, or hand
  one of their own rows to B;
- A cannot move themselves into another team, nor edit B's `members` row;
- A reads nothing from a foreign team, and cannot insert or move a cycle into one
  (all three only when `SUPABASE_TEST_OTHER_TEAM_ID` is set);
- the same round against `daily_plans`, on its `(team_id, owner, plan_date)` key:
  A reads B's row but can neither update nor delete it (and the row is read back
  afterwards to prove the refused delete was not a silent success), A cannot
  forge `owner`, and — with `SUPABASE_TEST_OTHER_TEAM_ID` set — reads nothing
  from a foreign team and can neither insert into one nor move their own row
  there;
- A, who is already in a team, is refused by both `join_team` and `create_team`,
  and is still in their original team afterwards — the anti-hopping guard;
- the invite code A can read is at least 24 characters;
- with `SUPABASE_TEST_C_*` set: a wrong invite code is an explicit error and
  **leaves `team_id` null** rather than silently succeeding, an empty code and an
  empty team name are refused, the real code joins and makes the whole roster
  readable, a second join is refused, `leave_team` puts C back to reading
  nothing, and `rotate_invite_code` is refused for someone with no team;
- with `SUPABASE_TEST_ALLOW_TEAM_CREATE=1`: `create_team` returns a uuid **and
  leaves the creator inside that team**, and rotating changes the code;
- a bare anon key with no session reads no cycles and no daily_plans, and cannot
  execute any of the four RPCs.

**When the required variables are absent the script exits 0 and prints `SKIPPED`
with the exact list of missing variables.** A skip is not a pass — nothing about
the remote has been checked. Do not read a green exit code as verification
unless the output says `passed` with zero skips.

**"A reads nothing from a foreign team" is only worth something if that team has
rows.** The assertion is `length === 0`, which is also what an empty table
returns with RLS switched off entirely. `cycles` in an established team is
usually populated; `daily_plans` is newer, so a foreign team that has never
synced a plan makes that half of the check vacuous. Point
`SUPABASE_TEST_OTHER_TEAM_ID` at a team that actually holds a `daily_plans` row,
or read that one line as unverified. The script cannot seed the row itself: it
has no session in that team, and the alternative is a `service_role` key, which
is not worth introducing here for one assertion.

The script writes one throwaway cycle row under user A's own identity and deletes
it afterwards, and it renames user A's `member_id` and puts it back. For
`daily_plans` it uses two sentinel dates no real plan can occupy: `1970-01-02`
for the row each of A and B writes under their own session, and `1970-01-03` for
the two inserts that are *supposed* to be refused — owner-forging and
cross-team. Everything is written by the session that owns it, but point the
script at a scratch project if that bothers you. If it dies between the two
rename steps, A is left with a `-renamed-<suffix>` label; set it back by hand.

Before and after the `daily_plans` block, each session deletes every row it owns
on either sentinel date, in any team — not just the row it wrote. The wider
sweep matters because the rows that need collecting are the ones a *broken*
policy created: a forged row lands under B's uuid, so only B's session can
remove it, and a row that got moved into the foreign team is no longer found by
any query pinned to A's own team. A run that dies mid-block leaves those rows
behind; the next run's opening sweep takes them. If one survives even that, the
two refused inserts now report the resulting `409` as a failure instead of
counting it as proof the policy held.

## Open questions left after LEO-282/283

* **Nothing rate-limits `join_team`.** A wrong code is rejected, but a caller can
  try again immediately. 128 bits of entropy makes that hopeless in practice; if
  it ever stops feeling hopeless, the fix is a counter table keyed by
  `auth.uid()`, not a shorter code.
* **`leave_team()` leaves your cycles behind.** They stay readable by the team
  you left, because they are that team's shared history. Deleting them on the
  way out is a destructive default; deleting them by hand first
  (`cycles_delete_own` allows it) is the deliberate one.
* **`rotate_invite_code()` may be called by any member of the team**, not only by
  `created_by`. For two people that is the right trade; a bigger team probably
  wants it restricted to the creator, which is a one-line change to the function.
* **Email confirmation.** If the Supabase project has it enabled, sign-up returns
  no session and the console says so rather than pretending to be logged in.
