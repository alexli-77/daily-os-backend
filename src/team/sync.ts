import crypto from 'node:crypto';
import fs from 'node:fs';
import type { AppConfig } from '../config/schema.js';
import { cyclesDir, listCycles, parseCycleId, readCycle, serializeCycleMarkdown } from '../cycles/file.js';
import {
  cycleVersionKey,
  isNewerVersion,
  isPlanDate,
  isUuid,
  listCachedCycles,
  listCachedDailyPlans,
  listCachedOwners,
  pruneCachedDailyPlans,
  readCachedDailyPlan,
  readTeamCacheState,
  resetTeamCache,
  teamCacheDir,
  writeCachedCycle,
  writeCachedDailyPlan,
  writeTeamCacheState,
} from './cache.js';
import type { CachedCycle, CachedDailyPlan, TeamCacheState } from './cache.js';
import { buildTodayPlanSnapshot } from '../todo/today-plan.js';
import { addDays, todayInTimezone } from '../utils/date.js';
import { onLocalChange } from '../utils/change-events.js';
import type { LocalChangeKind } from '../utils/change-events.js';
import {
  resolveTeamSessionProvider,
  safeIsSupabaseConfigured,
  safeReadTeamSession,
} from './session-bridge.js';
import type { TeamMember, TeamSession, TeamSessionProvider } from './session-bridge.js';

/**
 * Cycle sync (LEO-284): local markdown out, teammates' markdown in.
 *
 * The whole design follows from one decision: **local markdown is the source of
 * truth, and the remote is a transport.** Not a database, not a merge point.
 * Consequences, all of them load-bearing:
 *
 *   * Own cycles are pushed, never pulled. There is no code path that writes a
 *     remote row into `20_CYCLES/`, so a stale row — from another machine, from
 *     a failed write, from a rollback — cannot overwrite what the user just
 *     typed. The read query filters `owner=neq.<me>` and the cache writer
 *     refuses own uuids on top of that.
 *   * Teammates' cycles are cached (see cache.ts), never merged.
 *   * Every remote step is optional. No network, no login, no team: the local
 *     editor is unaffected and the console says so instead of failing.
 *
 * ## Why polling, and why 60s
 *
 * Two people write about seven cycle sections a day between them. A 60s poll is
 * 1440 requests/day of a single-row query, which no free tier notices, and it
 * keeps the project from being paused for inactivity as a side effect. Under a
 * biweekly review rhythm, one-minute freshness and instant push are the same
 * product.
 *
 * Realtime over websockets is free on Supabase and the table needs no change to
 * adopt it later. It is not worth it *first*, because it adds connection
 * lifecycle, reconnect-with-backoff, and one failure mode polling does not have:
 * a socket that has quietly died while the UI still claims to be in sync. A poll
 * that fails, fails visibly and retries a minute later.
 *
 * ## The cheap check
 *
 * A tick reads one column of one row:
 *
 *     GET /cycles?select=updated_at&owner=neq.<me>&order=updated_at.desc&limit=1
 *
 * No join, no bodies. Only when that value differs from the stored watermark do
 * we fetch markdown. Excluding our own rows matters: pushing a cycle bumps the
 * team's max `updated_at`, so a watermark computed over the whole team would
 * make every one of our own saves trigger a full teammate re-download.
 * `members` is joined at read time from a separate, tiny table — cycles has no
 * `member_id` column on purpose.
 *
 * ## Daily plans ride the same tick
 *
 * `daily_plans` is a second table with the same key shape and the same
 * policies, carrying a snapshot of the owner's "today" list (the todos plus
 * their own complete / defer state). It is pushed and pulled by the same tick,
 * with its own watermark and its own probe, so the cost of an idle minute is two
 * single-row requests instead of one. Only the last two days are fetched: the
 * point is "what is she doing today", not a history.
 *
 * ## Push on change, not on tick
 *
 * The 60s tick made a local edit take up to a minute to *leave* the machine and
 * up to another minute to arrive — two minutes of nothing happening for a save
 * that took 8ms. The console already pushed straight after its own saves
 * (`pushLocalCycle`); everything else — Obsidian, the planner subprocess, a
 * `git checkout` — had to wait for the poll.
 *
 * So the cycles directory is watched (`fs.watch`) and the today-plan snapshot
 * subscribes to an in-process change bus (`src/utils/change-events.ts`, emitted
 * by the todo ledger and the workflow-output writer). Three properties make
 * that safe rather than chatty:
 *
 *   * **Debounced 500ms, trailing, per key.** One editor save fires 2-4 fs
 *     events; a drag-reorder writes several ledger rows; a branch switch
 *     touches every file. Each collapses to one push per cycle id.
 *   * **Content is read at send time**, never carried on the event. Five edits
 *     inside the window produce one push of the fifth state, and the existing
 *     content-hash gate still drops it entirely if the bytes did not move.
 *   * **Single-flight.** Every path — tick, watcher, change bus, the console's
 *     manual button — goes through one queue, so `state.json` has exactly one
 *     writer. Work that arrives mid-run is coalesced into the next run instead
 *     of starting a second one or being dropped.
 *
 * The tick stays, unchanged, as the backstop: it is what catches the edits made
 * while the process was not running, while the network was down, or while a
 * watcher that failed to start was not watching. Everything here is an
 * optimisation on top of a loop that already worked.
 *
 * ## Applying a pulled row: last writer wins, by the server's clock
 *
 * Arrival order is not authorship order. A retried request, a slow response
 * overtaken by a fast one, and (in phase 2) a Realtime frame racing a poll can
 * all deliver an older row after a newer one. So applying is *versioned*: a
 * pulled row is written to the cache only when its server `updated_at` is
 * strictly newer than the version of what is already cached, which makes a
 * duplicate or out-of-order delivery a no-op instead of a rollback.
 *
 * The version has to be the server's, not the author's. `CachedCycle.updatedAt`
 * comes out of the teammate's frontmatter — their laptop's clock — and two
 * machines do not agree on that. `cycles.updated_at` is stamped by the
 * `touch_updated_at` trigger and cannot be backdated by a client, so it is the
 * one ordering both ends share. Cached cycles carry no server column, so the
 * versions live in `state.cycleVersions`; daily plans already store theirs in
 * the cached json.
 */

/** Where a sync attempt got to. Anything but `ok` means sync is paused. */
export type TeamSyncStatus = 'disabled' | 'signed_out' | 'no_team' | 'ok' | 'error';

export interface TeamSyncResult {
  status: TeamSyncStatus;
  /** Human-readable, shown in the console verbatim. */
  reason: string;
  /** Did we reach the remote watermark query at all. */
  checked: boolean;
  /** Did the watermark move, i.e. did we fetch bodies. */
  changed: boolean;
  /** Teammate cycles written to the cache this tick. */
  pulled: number;
  /** Own cycles uploaded this tick. */
  pushed: number;
  /** Teammate daily plans written to the cache this tick. */
  plansPulled: number;
  /** Own daily plan uploaded this tick (0 or 1). */
  plansPushed: number;
  /** Cached teammate daily-plan files deleted by local retention this tick. */
  plansPruned: number;
  /** Did this tick run the once-a-day remote daily-plan retention delete. */
  plansPurged: boolean;
  syncedAt: string;
}

export interface TeamSyncDeps {
  /** Injected in tests. Defaults to the real `src/team/session.ts`. */
  provider?: TeamSessionProvider | null;
  /** Injected in tests so timestamps are assertable. */
  now?: () => Date;
}

/** PostgREST paths, in one place: `supabaseFetch` only prefixes the origin. */
const CYCLES_PATH = '/rest/v1/cycles';
const DAILY_PLANS_PATH = '/rest/v1/daily_plans';

/**
 * Retention, in two windows for two different costs.
 *
 * Locally a teammate's old "today" list is dead weight the moment the day is
 * over — the Today page only ever reads the newest one — so a week is already
 * generous and only exists so a Monday morning still has Friday in it.
 * Remotely the row costs somebody else's free-tier storage, but deleting it
 * eagerly would race a teammate who is offline and has not pulled it yet, so
 * 30 days. Cycles are exempt from both: they are the review history this whole
 * feature exists to share.
 */
const LOCAL_PLAN_RETENTION_DAYS = 7;
const REMOTE_PLAN_RETENTION_DAYS = 30;

// --- one sync tick -----------------------------------------------------------

/**
 * Push what changed locally, then pull what changed remotely. One round trip
 * when nothing moved on either side.
 *
 * Never throws. A transport failure is reported as `status: 'error'` with the
 * message, and leaves the cache exactly as it was — a half-applied pull is
 * indistinguishable from a stale one to a reader, and a stale one is honest.
 */
export async function syncTeamOnce(config: AppConfig, deps: TeamSyncDeps = {}): Promise<TeamSyncResult> {
  const now = deps.now ? deps.now() : new Date();
  const gate = await resolveSyncGate(config, deps);
  if (!gate.ok) return idleResult(gate.status, gate.reason);

  const { provider, session } = gate;
  const teamId = session.teamId as string;

  let state = readTeamCacheState();
  // A different team means the cached markdown belongs to people we can no
  // longer see. Showing it under whatever labels we happen to still hold would
  // be worse than showing nothing.
  if (state.teamId && state.teamId !== teamId) state = resetTeamCache(teamId);
  state.teamId = teamId;

  try {
    const pushed = await pushChangedCycles(config, provider, session, state);
    const { checked, changed, pulled } = await pullTeammateCycles(config, provider, session, state, now);
    // Daily plans are a later addition on a table the project may not have
    // yet. A failure there is reported, not allowed to stop cycles syncing:
    // someone who has not applied the second migration keeps what they had.
    let planError = '';
    let plansPushed = 0;
    let plansPurged = false;
    let plans = { changed: false, pulled: 0 };
    try {
      plansPushed = await pushTodayPlan(config, provider, session, state);
      plans = await pullTeammatePlans(config, provider, session, state, now);
      plansPurged = await purgeOwnRemotePlans(config, provider, session, state);
    } catch (error) {
      planError = describePlanError(error);
    }
    // Local retention runs outside that try on purpose: it touches no network,
    // so a project without the daily_plans table must not be the reason a
    // teammate's stale files pile up forever.
    const plansPruned = pruneCachedDailyPlans(addDays(todayInTimezone(config), -LOCAL_PLAN_RETENTION_DAYS));
    state.lastCheckedAt = now.toISOString();
    state.lastError = planError;
    if (changed || plans.changed || pushed > 0 || plansPushed > 0) state.syncedAt = now.toISOString();
    if (!state.syncedAt) state.syncedAt = now.toISOString();
    writeTeamCacheState(state);
    return {
      status: 'ok',
      reason: planError,
      checked,
      changed: changed || plans.changed,
      pulled,
      pushed,
      plansPulled: plans.pulled,
      plansPushed,
      plansPruned,
      plansPurged,
      syncedAt: state.syncedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.lastCheckedAt = now.toISOString();
    state.lastError = message;
    writeTeamCacheState(state);
    return { ...idleResult('error', message), checked: true, syncedAt: state.syncedAt };
  }
}

/**
 * Upload one local cycle now. Called right after the console saves a section so
 * the teammate sees it inside a minute instead of at the next poll.
 *
 * Deliberately separate from `syncTeamOnce` and deliberately quiet: the local
 * write has already succeeded and been reported to the user by the time this
 * runs, so a failure here must not turn a saved file into an error message. It
 * is recorded and retried by the next tick.
 */
export async function pushLocalCycle(config: AppConfig, cycleId: string, deps: TeamSyncDeps = {}): Promise<TeamSyncResult> {
  const now = deps.now ? deps.now() : new Date();
  const gate = await resolveSyncGate(config, deps);
  if (!gate.ok) return idleResult(gate.status, gate.reason);
  if (!parseCycleId(cycleId)) return idleResult('error', `Invalid cycle id: ${cycleId}`);

  const state = readTeamCacheState();
  state.teamId = gate.session.teamId as string;
  try {
    const pushed = await pushOne(config, gate.provider, gate.session, state, cycleId);
    state.lastError = '';
    if (pushed) state.syncedAt = now.toISOString();
    writeTeamCacheState(state);
    return { ...idleResult('ok', ''), checked: true, pushed: pushed ? 1 : 0, syncedAt: state.syncedAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.lastError = message;
    writeTeamCacheState(state);
    return { ...idleResult('error', message), checked: true, syncedAt: state.syncedAt };
  }
}

/**
 * Upload today's plan snapshot now, for the same reason and with the same
 * manners as `pushLocalCycle`: the ledger write has already succeeded, so a
 * transport failure here is recorded and retried by the next tick, never
 * raised at whoever ticked the checkbox.
 *
 * The snapshot is rebuilt here rather than passed in, so three checkboxes
 * ticked inside one debounce window send the state after the third, not three
 * times, and never the state as of the first.
 */
export async function pushLocalTodayPlan(config: AppConfig, deps: TeamSyncDeps = {}): Promise<TeamSyncResult> {
  const now = deps.now ? deps.now() : new Date();
  const gate = await resolveSyncGate(config, deps);
  if (!gate.ok) return idleResult(gate.status, gate.reason);

  const state = readTeamCacheState();
  state.teamId = gate.session.teamId as string;
  try {
    const pushed = await pushTodayPlan(config, gate.provider, gate.session, state);
    state.lastError = '';
    if (pushed) state.syncedAt = now.toISOString();
    writeTeamCacheState(state);
    return { ...idleResult('ok', ''), checked: true, plansPushed: pushed, syncedAt: state.syncedAt };
  } catch (error) {
    // The same translation the tick does: a project without the second
    // migration should be told which file to run, not shown a PostgREST code.
    const message = describePlanError(error);
    state.lastError = message;
    writeTeamCacheState(state);
    return { ...idleResult('error', message), checked: true, syncedAt: state.syncedAt };
  }
}

// --- push --------------------------------------------------------------------

async function pushChangedCycles(
  config: AppConfig,
  provider: TeamSessionProvider,
  session: TeamSession,
  state: TeamCacheState,
): Promise<number> {
  let pushed = 0;
  for (const doc of listCycles(config)) {
    // A file we cannot parse is a file we cannot serialize without losing its
    // frontmatter. Sending a lossy copy would publish damage.
    if (doc.frontmatterError) continue;
    if (await pushOne(config, provider, session, state, doc.id)) pushed += 1;
  }
  return pushed;
}

/** Returns false when the file is already up to date remotely. */
async function pushOne(
  config: AppConfig,
  provider: TeamSessionProvider,
  session: TeamSession,
  state: TeamCacheState,
  cycleId: string,
): Promise<boolean> {
  const doc = readCycle(config, cycleId);
  if (!doc || doc.frontmatterError) return false;

  const markdown = serializeCycleMarkdown(doc);
  const hash = crypto.createHash('sha256').update(markdown).digest('hex');
  if (state.pushed[cycleId] === hash) return false;

  // The row we are about to write is keyed by `owner`. Assert we are writing
  // our own coordinate before the request, not only in the RLS policy that will
  // reject it: a client that computes ownership wrong should fail here, where
  // the message says what happened, rather than as an opaque 403.
  assertOwnedBySelf(session, session.userId);

  const response = await provider.supabaseFetch(
    config,
    `${CYCLES_PATH}?on_conflict=team_id,owner,cycle_id`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // merge-duplicates makes this an upsert; return=minimal keeps the
        // response body empty, since we already have the content.
        prefer: 'resolution=merge-duplicates,return=minimal',
      },
      body: JSON.stringify([
        {
          team_id: session.teamId,
          owner: session.userId,
          cycle_id: cycleId,
          mode: doc.mode || '',
          markdown,
        },
      ]),
    },
  );
  await assertOk(response, `push ${cycleId}`);
  state.pushed[cycleId] = hash;
  return true;
}

// --- pull --------------------------------------------------------------------

async function pullTeammateCycles(
  config: AppConfig,
  provider: TeamSessionProvider,
  session: TeamSession,
  state: TeamCacheState,
  now: Date,
): Promise<{ checked: boolean; changed: boolean; pulled: number }> {
  const watermark = await readRemoteWatermark(config, provider, session);
  if (watermark === state.watermark) return { checked: true, changed: false, pulled: 0 };

  const response = await provider.supabaseFetch(
    config,
    `${CYCLES_PATH}?select=owner,cycle_id,mode,markdown,updated_at&owner=neq.${encodeURIComponent(session.userId)}&order=updated_at.desc`,
  );
  await assertOk(response, 'pull cycles');
  const rows = await readJsonArray(response);

  let pulled = 0;
  let highest = state.watermark;
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    const owner = String(record.owner || '');
    const cycleId = String(record.cycle_id || '');
    const markdown = typeof record.markdown === 'string' ? record.markdown : '';
    const updatedAt = String(record.updated_at || '');
    // A row we cannot place is skipped, not fatal: one malformed row must not
    // stop the other person's other twelve cycles from arriving.
    if (!isUuid(owner) || owner === session.userId) continue;
    if (!parseCycleId(cycleId) || !markdown) continue;
    // `highest` tracks what we have *seen*, before deciding whether to apply
    // it, so a row that loses the version check below still cannot drag the
    // fallback watermark backwards and get itself re-fetched forever.
    if (updatedAt > highest) highest = updatedAt;
    // Last writer wins, and the server decides who that was. Equal or older
    // than what is cached means this delivery is a duplicate or arrived out of
    // order, and the honest response to both is to do nothing.
    const versionKey = cycleVersionKey(owner, cycleId);
    if (!isNewerVersion(updatedAt, state.cycleVersions[versionKey] || '')) continue;
    writeCachedCycle(config, session.userId, owner, cycleId, markdown);
    // Recorded only after the write succeeded: a throw here must not leave us
    // believing we hold a version we never wrote.
    state.cycleVersions[versionKey] = updatedAt;
    pulled += 1;
  }

  // Advance to what the cheap query reported, not to the max row we happened to
  // accept: a row skipped as malformed would otherwise be re-fetched forever.
  //
  // That still holds now that the version check can skip rows too, because the
  // two answer different questions and never feed each other. The watermark is
  // "how far has the *table* moved", read from the probe and independent of
  // what we did with the bodies; the version map is "what do I hold for this
  // row". A pull that applies nothing therefore still advances, and the next
  // tick goes back to costing one single-row request — while a row whose
  // version did not move stays out of the cache no matter how often it is
  // re-delivered.
  state.watermark = watermark || highest;
  state.syncedAt = now.toISOString();
  state.members = await readMembers(config, provider, state.members);
  return { checked: true, changed: true, pulled };
}

/**
 * The single-row change probe. Teammates only, newest first, one column.
 * `''` when the team has no teammate rows yet.
 */
async function readRemoteWatermark(config: AppConfig, provider: TeamSessionProvider, session: TeamSession): Promise<string> {
  const response = await provider.supabaseFetch(
    config,
    `${CYCLES_PATH}?select=updated_at&owner=neq.${encodeURIComponent(session.userId)}&order=updated_at.desc&limit=1`,
  );
  await assertOk(response, 'poll updated_at');
  const rows = await readJsonArray(response);
  const first = rows[0] as Record<string, unknown> | undefined;
  return first ? String(first.updated_at || '') : '';
}

/** Labels are a nicety: keep the cached ones when the members read fails. */
async function readMembers(config: AppConfig, provider: TeamSessionProvider, fallback: TeamMember[]): Promise<TeamMember[]> {
  try {
    const members = await provider.listTeamMembers(config);
    if (!Array.isArray(members)) return fallback;
    return members
      .filter((member) => isUuid(member?.userId))
      .map((member) => ({
        userId: member.userId,
        memberId: String(member.memberId || ''),
        displayName: String(member.displayName || ''),
      }));
  } catch {
    return fallback;
  }
}

// --- daily plans -------------------------------------------------------------

/**
 * Upload today's plan snapshot when it differs from what we last sent. One row
 * per day, keyed by the plan's own date, so a stale plan (yesterday's, because
 * today's run hasn't happened) is pushed under yesterday and the teammate's
 * view says so rather than showing it as today's.
 */
async function pushTodayPlan(
  config: AppConfig,
  provider: TeamSessionProvider,
  session: TeamSession,
  state: TeamCacheState,
): Promise<number> {
  const snapshot = buildTodayPlanSnapshot(config);
  if (!snapshot || !isPlanDate(snapshot.date)) return 0;

  const payload = { generated_at: snapshot.generated_at, todos: snapshot.todos, feedback: snapshot.feedback };
  const hash = crypto.createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  if (state.pushedPlans[snapshot.date] === hash) return 0;

  assertOwnedBySelf(session, session.userId);
  const response = await provider.supabaseFetch(config, `${DAILY_PLANS_PATH}?on_conflict=team_id,owner,plan_date`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      prefer: 'resolution=merge-duplicates,return=minimal',
    },
    body: JSON.stringify([{ team_id: session.teamId, owner: session.userId, plan_date: snapshot.date, payload }]),
  });
  await assertOk(response, `push daily plan ${snapshot.date}`);
  // Only today's hash matters; a date that has rolled over is never pushed again.
  state.pushedPlans = { [snapshot.date]: hash };
  return 1;
}

/**
 * PostgREST answers a query against a table it does not know with 404 and
 * `PGRST205`. For this table that means one thing — the second migration has
 * not been run on this project — so say that instead of quoting the response.
 */
function describePlanError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  if (/PGRST205|Could not find the table/i.test(message)) {
    return '今日计划同步未启用：Supabase 里还没有 daily_plans 表。在项目的 SQL Editor 里执行 supabase/migrations/20260919000000_daily_plans.sql 即可，周期同步不受影响。';
  }
  return message;
}

async function pullTeammatePlans(
  config: AppConfig,
  provider: TeamSessionProvider,
  session: TeamSession,
  state: TeamCacheState,
  now: Date,
): Promise<{ changed: boolean; pulled: number }> {
  const probe = await provider.supabaseFetch(
    config,
    `${DAILY_PLANS_PATH}?select=updated_at&owner=neq.${encodeURIComponent(session.userId)}&order=updated_at.desc&limit=1`,
  );
  await assertOk(probe, 'poll daily plans updated_at');
  const first = (await readJsonArray(probe))[0] as Record<string, unknown> | undefined;
  const watermark = first ? String(first.updated_at || '') : '';
  if (watermark === state.planWatermark) return { changed: false, pulled: 0 };

  // Yesterday too, so a teammate whose morning run hasn't happened yet still
  // shows their last plan, flagged stale, instead of nothing.
  const since = addDays(todayInTimezone(config), -1);
  const response = await provider.supabaseFetch(
    config,
    `${DAILY_PLANS_PATH}?select=owner,plan_date,payload,updated_at&owner=neq.${encodeURIComponent(session.userId)}&plan_date=gte.${since}&order=updated_at.desc`,
  );
  await assertOk(response, 'pull daily plans');
  const rows = await readJsonArray(response);

  let pulled = 0;
  for (const row of rows) {
    const record = row as Record<string, unknown>;
    const owner = String(record.owner || '');
    const date = String(record.plan_date || '');
    const payload = record.payload;
    if (!isUuid(owner) || owner === session.userId) continue;
    if (!isPlanDate(date) || !payload || typeof payload !== 'object' || Array.isArray(payload)) continue;
    // Same rule as cycles, reading the version off the cached file instead of
    // out of `state`: a daily plan already stores the server `updated_at` it
    // was written from, so there is nothing to duplicate into state.json.
    const updatedAt = String(record.updated_at || '');
    const cached = readCachedDailyPlan(owner, date);
    if (cached && !isNewerVersion(updatedAt, cached.updatedAt)) continue;
    writeCachedDailyPlan(session.userId, owner, date, updatedAt, payload as Record<string, unknown>);
    pulled += 1;
  }

  state.planWatermark = watermark;
  state.syncedAt = now.toISOString();
  state.members = await readMembers(config, provider, state.members);
  return { changed: true, pulled };
}

/**
 * Remote retention: delete our OWN `daily_plans` rows older than 30 days, at
 * most once a day. Returns whether the delete was attempted.
 *
 * Only our own rows, and the filter says so as well as the policy
 * (`daily_plans_delete_own`) — a client that computed the filter wrong should
 * delete nothing rather than rely on RLS to catch it. Cycles are never purged.
 *
 * The date is recorded *before* the request, not after, so a remote that keeps
 * failing costs one attempt a day rather than one a minute. Losing a day of
 * retention to a transient error is not worth a DELETE per tick, and tomorrow's
 * pass covers the same rows anyway.
 */
async function purgeOwnRemotePlans(
  config: AppConfig,
  provider: TeamSessionProvider,
  session: TeamSession,
  state: TeamCacheState,
): Promise<boolean> {
  const today = todayInTimezone(config);
  if (state.lastPlanPurgeDate === today) return false;
  state.lastPlanPurgeDate = today;

  const cutoff = addDays(today, -REMOTE_PLAN_RETENTION_DAYS);
  assertOwnedBySelf(session, session.userId);
  const response = await provider.supabaseFetch(
    config,
    `${DAILY_PLANS_PATH}?owner=eq.${encodeURIComponent(session.userId)}&plan_date=lt.${cutoff}`,
    { method: 'DELETE', headers: { prefer: 'return=minimal' } },
  );
  await assertOk(response, 'prune daily plans');
  return true;
}

// --- read-only view for the console -----------------------------------------

export interface TeamViewMember {
  userId: string;
  memberId: string;
  displayName: string;
  /** What the switcher shows: display name, else member id, else short uuid. */
  label: string;
  cycles: CachedCycle[];
}

export interface TeamViewState {
  /** `ready` is the only state in which teammate cycles can be shown. */
  status: 'disabled' | 'signed_out' | 'no_team' | 'ready';
  reason: string;
  cacheDir: string;
  self: { userId: string; memberId: string; displayName: string } | null;
  /** Teammates only. The page renders "我" from the local cycle list. */
  members: TeamViewMember[];
  syncedAt: string;
  lastCheckedAt: string;
  lastError: string;
}

/**
 * Everything the Cycles page needs to render the member switcher, read from
 * disk only. No network: a page render must not be able to hang on a poll, and
 * the cache is what a teammate view shows anyway.
 */
export async function readTeamViewState(config: AppConfig, deps: TeamSyncDeps = {}): Promise<TeamViewState> {
  const cacheDir = teamCacheDir();
  const gate = await resolveSyncGate(config, deps);
  if (!gate.ok) {
    return {
      status: gate.status === 'error' ? 'disabled' : gate.status,
      reason: gate.reason,
      cacheDir,
      self: null,
      members: [],
      syncedAt: '',
      lastCheckedAt: '',
      lastError: '',
    };
  }

  const { session } = gate;
  const state = readTeamCacheState();
  const members: TeamViewMember[] = listTeammates(session, state).map((member) => ({ ...member, cycles: listCachedCycles(member.userId) }));
  const self = state.members.find((member) => member.userId === session.userId);
  return {
    status: 'ready',
    reason: '',
    cacheDir,
    self: {
      userId: session.userId,
      memberId: self?.memberId || session.memberId || '',
      displayName: self?.displayName || '',
    },
    members,
    syncedAt: state.syncedAt,
    lastCheckedAt: state.lastCheckedAt,
    lastError: state.lastError,
  };
}

export interface TeamTodayMember {
  userId: string;
  memberId: string;
  displayName: string;
  label: string;
  /** Newest cached plan, or null when nothing has arrived for this teammate. */
  plan: CachedDailyPlan | null;
  /** The cached plan is from an earlier day than our today. */
  stale: boolean;
}

export interface TeamTodayState {
  status: TeamViewState['status'];
  reason: string;
  today: string;
  /** Teammates only; the page renders "我" from the local plan. */
  members: TeamTodayMember[];
  syncedAt: string;
  lastCheckedAt: string;
  lastError: string;
}

/**
 * Teammates' "today" lists for the Today page, from disk only, same contract
 * as `readTeamViewState`. A teammate who has joined but not pushed a plan yet
 * is listed with `plan: null` so the page can say so instead of hiding them.
 */
export async function readTeamTodayState(config: AppConfig, deps: TeamSyncDeps = {}): Promise<TeamTodayState> {
  const today = todayInTimezone(config);
  const gate = await resolveSyncGate(config, deps);
  if (!gate.ok) {
    return {
      status: gate.status === 'error' ? 'disabled' : gate.status,
      reason: gate.reason,
      today,
      members: [],
      syncedAt: '',
      lastCheckedAt: '',
      lastError: '',
    };
  }

  const state = readTeamCacheState();
  const members = listTeammates(gate.session, state).map((member) => {
    const plan = listCachedDailyPlans(member.userId)[0] || null;
    return { ...member, plan, stale: Boolean(plan && plan.date !== today) };
  });
  return {
    status: 'ready',
    reason: '',
    today,
    members,
    syncedAt: state.syncedAt,
    lastCheckedAt: state.lastCheckedAt,
    lastError: state.lastError,
  };
}

/**
 * Union of "in the team" and "has cached data": a teammate who left is still
 * worth rendering as long as we hold their files, and a teammate who just
 * joined should appear before their first cycle arrives.
 */
function listTeammates(session: TeamSession, state: TeamCacheState): Array<Omit<TeamViewMember, 'cycles'>> {
  const byId = new Map(state.members.map((member) => [member.userId, member]));
  const ids = new Set<string>([...state.members.map((member) => member.userId), ...listCachedOwners()]);
  ids.delete(session.userId);
  const members = [...ids].map((userId) => {
    const member = byId.get(userId);
    const displayName = member?.displayName || '';
    const memberId = member?.memberId || '';
    return { userId, memberId, displayName, label: displayName || memberId || `成员 ${userId.slice(0, 8)}` };
  });
  return members.sort((left, right) => left.label.localeCompare(right.label));
}

// --- write guard -------------------------------------------------------------

/**
 * The second half of "teammate views are read-only".
 *
 * Hiding the save buttons is a UI convenience; this is the rule. Any write that
 * names an owner must name the signed-in user, so a stale page, a scripted
 * request, or a future caller that forgets which member is selected is rejected
 * here rather than writing a teammate's text into the local vault under their
 * name. Writes that name no owner are writes to `20_CYCLES/`, which is the
 * local user's own directory by definition.
 */
export async function assertLocalCycleWriteTarget(config: AppConfig, ownerId: unknown, deps: TeamSyncDeps = {}): Promise<void> {
  const target = String(ownerId ?? '').trim();
  if (!target) return;

  const lookup = await resolveTeamSessionProvider();
  const session = lookup.provider ? safeReadTeamSession(lookup.provider, config) : null;
  if (!session) {
    throw new Error('只读：当前没有登录团队账号，无法按成员身份写入周期。');
  }
  assertOwnedBySelf(session, target);
}

function assertOwnedBySelf(session: TeamSession, ownerId: string): void {
  if (!ownerId || ownerId !== session.userId) {
    throw new Error('只读：队友的周期不能在本机编辑，只有本人能修改自己的周期。');
  }
}

// --- the sync loop -----------------------------------------------------------

export const TEAM_SYNC_INTERVAL_MS = 60_000;

/**
 * How long to wait for the watched directory to answer before giving up on the
 * watcher for this run.
 *
 * Generous on purpose: the thing being waited on is usually a one-off
 * permission check, and losing file-watching for a whole session to save a few
 * seconds at startup is the wrong trade. Nothing is blocked while this runs —
 * the HTTP server is already serving and the 60s tick is already ticking.
 */
export const WATCH_WARMUP_MS = 10_000;

/**
 * How long a key stays quiet before its push goes out. Long enough to swallow
 * the 2-4 events one editor save produces and the several ledger rows one
 * drag-reorder writes; short enough that "within a second" is still true.
 */
export const TEAM_SYNC_DEBOUNCE_MS = 500;

export interface TeamSyncLoop {
  /** Run a tick right now (what the console's 同步 button calls). */
  runNow: () => Promise<TeamSyncResult>;
  /**
   * Push one cycle through the same queue as everything else. The console's
   * save handler uses this instead of calling `pushLocalCycle` directly, so a
   * save landing mid-tick cannot write `state.json` underneath it.
   */
  pushCycle: (cycleId: string) => Promise<TeamSyncResult>;
  /**
   * Fire every waiting debounce timer now and wait for the queue to drain.
   * A test seam, and a way to force pending work out before shutting down —
   * `stop()` deliberately does not call it, because a push abandoned at exit
   * is picked up by the next process's first tick anyway.
   */
  flush: () => Promise<void>;
  stop: () => void;
}

export interface TeamSyncLoopDeps extends TeamSyncDeps {
  intervalMs?: number;
  debounceMs?: number;
  /** Injected in tests. Defaults to a thin `fs.watch` wrapper. */
  watchDir?: (dir: string, onChange: (filename: string) => void) => { close: () => void };
  /** Injected in tests. Defaults to `WATCH_WARMUP_MS`. */
  watchWarmupMs?: number;
  /** Injected in tests. Defaults to the process-wide local-change bus. */
  subscribe?: (listener: (kind: LocalChangeKind) => void) => () => void;
}

/**
 * Start the sync loop: the 60s backstop poll, a watcher on the cycles
 * directory, and a subscription to the local-change bus. `loadConfigFn` is
 * called per job so a config change in the console takes effect without a
 * restart.
 *
 * Every timer is `unref`'d and the watcher is non-persistent: none of this may
 * ever be the reason a CLI process refuses to exit.
 */
export function startTeamSync(loadConfigFn: () => AppConfig, deps: TeamSyncLoopDeps = {}): TeamSyncLoop {
  const debounceMs = deps.debounceMs ?? TEAM_SYNC_DEBOUNCE_MS;

  // --- the single-flight queue ----------------------------------------------
  //
  // One job per key, at most one job running at a time, and the loop keeps
  // going until the queue is empty. Two consequences, both required:
  //   * a second request for a key that has not started yet is *coalesced* —
  //     the two callers wait on one run, so a burst is one push;
  //   * a request that arrives while that key is running is *queued* — it
  //     becomes a fresh entry and runs after, so nothing is lost. That is the
  //     dirty flag, expressed as a map instead of a boolean.
  interface QueuedJob {
    run: () => Promise<TeamSyncResult>;
    waiters: Array<(result: TeamSyncResult) => void>;
  }
  const queued = new Map<string, QueuedJob>();
  // `running` and `draining` are two variables rather than one nullable promise
  // on purpose, and the reason is a bug this had: when the queue is already
  // empty the async body below runs to completion *synchronously*, so its
  // `finally` fires before the assignment that stores the promise. A single
  // `draining: Promise | null` therefore ended up holding a resolved promise
  // that nothing ever cleared, and every later push was silently swallowed.
  // `running` is set before the body starts, so the ordering cannot invert.
  let running = false;
  let draining: Promise<void> = Promise.resolve();

  function drain(): Promise<void> {
    if (running) return draining;
    running = true;
    draining = (async () => {
      try {
        while (queued.size > 0) {
          const [key, job] = queued.entries().next().value as [string, QueuedJob];
          // Delete before running, not after: work that arrives during the run
          // must land in a *new* entry rather than joining the one in flight.
          queued.delete(key);
          let result: TeamSyncResult;
          try {
            result = await job.run();
          } catch (error) {
            // Belt and braces. Every job already swallows its own failures —
            // a push that fails must never surface as a failed local save.
            result = idleResult('error', error instanceof Error ? error.message : String(error));
          }
          for (const waiter of job.waiters) waiter(result);
        }
      } finally {
        running = false;
      }
    })();
    return draining;
  }

  function enqueue(key: string, run: () => Promise<TeamSyncResult>): Promise<TeamSyncResult> {
    const existing = queued.get(key);
    if (existing) return new Promise((resolve) => existing.waiters.push(resolve));
    const job: QueuedJob = { run, waiters: [] };
    queued.set(key, job);
    const result = new Promise<TeamSyncResult>((resolve) => job.waiters.push(resolve));
    void drain();
    return result;
  }

  // --- trailing debounce, per key -------------------------------------------
  const timers = new Map<string, { timer: ReturnType<typeof setTimeout>; fire: () => void }>();
  let stopped = false;

  function debounce(key: string, run: () => Promise<TeamSyncResult>): void {
    if (stopped) return;
    clearTimeout(timers.get(key)?.timer);
    const fire = (): void => {
      timers.delete(key);
      void enqueue(key, run);
    };
    const timer = setTimeout(fire, debounceMs);
    timer.unref?.();
    timers.set(key, { timer, fire });
  }

  // --- the jobs themselves ---------------------------------------------------
  //
  // Each reads its content at send time — `syncTeamOnce` re-lists the cycles,
  // `pushLocalCycle` re-reads the file, `pushLocalTodayPlan` rebuilds the
  // snapshot — so what goes out is the final state after a burst, never the
  // state the event was fired about.
  const tickJob = (): Promise<TeamSyncResult> => guard(() => syncTeamOnce(loadConfigFn(), deps));
  const cycleJob = (cycleId: string) => (): Promise<TeamSyncResult> => guard(() => pushLocalCycle(loadConfigFn(), cycleId, deps));
  const planJob = (): Promise<TeamSyncResult> => guard(() => pushLocalTodayPlan(loadConfigFn(), deps));

  const runNow = (): Promise<TeamSyncResult> => enqueue('tick', tickJob);
  const pushCycle = (cycleId: string): Promise<TeamSyncResult> => enqueue(`cycle:${cycleId}`, cycleJob(cycleId));
  let watcherReady: Promise<void> = Promise.resolve();

  const flush = async (): Promise<void> => {
    // The watcher starts asynchronously (see `startWatching`), so "everything
    // pending has happened" has to include it — otherwise a caller that starts
    // the loop and immediately flushes can find no watcher registered yet.
    await watcherReady;
    for (const entry of [...timers.values()]) {
      clearTimeout(entry.timer);
      entry.fire();
    }
    await drain();
  };

  if (process.env.DAILY_OS_DISABLE_TEAM_SYNC === '1') {
    return { runNow, pushCycle, flush, stop: () => {} };
  }

  // --- change sources --------------------------------------------------------
  const unsubscribe = (deps.subscribe ?? onLocalChange)((kind) => {
    if (kind === 'today_plan') debounce('plan', planJob);
  });

  let watcher: { close: () => void } | null = null;

  /**
   * Start the directory watcher without letting it take the process down.
   *
   * `fs.watch` looks asynchronous and is not: libuv's `uv_fs_event_start` opens
   * the watched directory with a **synchronous** `open()`, on the main thread.
   * Normally that returns in microseconds. When it does not — a first-run
   * TCC/Gatekeeper check on a freshly signed bundle watching a folder under
   * ~/Desktop, a stalled network volume — the Node event loop stops for as long
   * as the kernel takes, and with it every HTTP request. Observed in the wild:
   * the service alive, the port listening, and not one request answered; a
   * `sample` of the process showed 2582 of 2582 samples parked in that `open`.
   *
   * So the path is warmed through the *async* fs API first. That open runs on
   * the libuv threadpool, where blocking costs one worker instead of the whole
   * loop, and it resolves whatever the slow thing was (a permission decision is
   * cached per process) before the synchronous call is made. If the warm-up
   * does not come back in time, the watcher is skipped: the 60s tick is still
   * the backstop, so the cost is latency, not correctness.
   */
  const startWatching = async (): Promise<void> => {
    const dir = cyclesDir(loadConfigFn());
    if (!(await warmPath(dir, deps.watchWarmupMs ?? WATCH_WARMUP_MS))) {
      console.warn(
        `[team-sync] 拿不到周期目录的访问权（${dir}），暂时不装文件监听，改用 ${Math.round((deps.intervalMs ?? TEAM_SYNC_INTERVAL_MS) / 1000)} 秒轮询。` +
          '如果这是第一次启动新版本，去「系统设置 → 隐私与安全性」确认 Daily OS 能访问这个目录。'
      );
      return;
    }
    if (stopped) return;
    try {
      watcher = (deps.watchDir ?? watchDirectory)(dir, (filename) => {
        const id = filename.endsWith('.md') ? filename.slice(0, -3) : '';
        if (id && parseCycleId(id)) {
          debounce(`cycle:${id}`, cycleJob(id));
          return;
        }
        // No filename: some platforms report the event without one. A full tick
        // pushes whatever changed — slower than one row, never wrong. Anything
        // else (an atomic write's `.<name>.<pid>.<ts>.tmp` sibling, an editor's
        // swap file) is not a cycle and is ignored.
        if (!filename) debounce('tick', tickJob);
      });
    } catch {
      // A cycles directory that does not exist yet, a platform without inotify,
      // an fd limit. The 60s tick is still the backstop, so degrade to tick-only
      // rather than taking down the console with it.
      watcher = null;
    }
  };

  watcherReady = startWatching();

  void runNow();
  const timer = setInterval(() => void runNow(), deps.intervalMs ?? TEAM_SYNC_INTERVAL_MS);
  timer.unref?.();
  return {
    runNow,
    pushCycle,
    flush,
    stop: () => {
      stopped = true;
      clearInterval(timer);
      for (const entry of timers.values()) clearTimeout(entry.timer);
      timers.clear();
      unsubscribe();
      watcher?.close();
    },
  };
}

/** Never throws: a job's failure is a status, not an exception. */
async function guard(run: () => Promise<TeamSyncResult>): Promise<TeamSyncResult> {
  try {
    return await run();
  } catch (error) {
    return idleResult('error', error instanceof Error ? error.message : String(error));
  }
}

/**
 * Touch `dir` through the async fs API, with a deadline.
 *
 * The point is *where* the work happens, not what it returns: `fsp.access` is
 * serviced by the libuv threadpool, so a permission prompt or a wedged volume
 * blocks a worker while the event loop keeps serving HTTP. Resolving it here
 * also means the synchronous `open()` inside `fs.watch` finds an answer already
 * cached.
 *
 * `false` on either failure or timeout — the caller treats both the same way,
 * because "cannot read this directory" and "cannot read it yet" both mean the
 * watcher must not be installed right now.
 */
async function warmPath(dir: string, timeoutMs: number): Promise<boolean> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([
      fs.promises.access(dir, fs.constants.R_OK).then(
        () => true,
        () => false
      ),
      deadline,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * `fs.watch` on one directory, non-recursive (cycle files are flat) and
 * non-persistent. An `error` event is swallowed by closing the watcher: the
 * loop carries on polling, which is exactly the degraded mode we want.
 */
function watchDirectory(dir: string, onChange: (filename: string) => void): { close: () => void } {
  const watcher = fs.watch(dir, { persistent: false }, (_event, filename) => {
    onChange(typeof filename === 'string' ? filename : '');
  });
  watcher.on('error', () => {
    try {
      watcher.close();
    } catch {
      // Already closed. Nothing to do and nothing to report.
    }
  });
  return {
    close: () => {
      try {
        watcher.close();
      } catch {
        // Same.
      }
    },
  };
}

// --- internals ---------------------------------------------------------------

type SyncGate =
  | { ok: true; provider: TeamSessionProvider; session: TeamSession }
  | { ok: false; status: Exclude<TeamSyncStatus, 'ok'>; reason: string };

/**
 * The three ways sync can be switched off, in the order the user can fix them.
 * All of them are normal states, not errors: the local editor works in each.
 */
async function resolveSyncGate(config: AppConfig, deps: TeamSyncDeps): Promise<SyncGate> {
  const lookup = deps.provider ? { provider: deps.provider } : await resolveTeamSessionProvider();
  const provider = lookup.provider;
  if (!provider) {
    const detail = 'detail' in lookup ? String(lookup.detail || '') : '';
    return { ok: false, status: 'disabled', reason: detail || '团队同步未启用。' };
  }
  if (!safeIsSupabaseConfigured(provider, config)) {
    return { ok: false, status: 'disabled', reason: '未配置 Supabase（SUPABASE_URL / SUPABASE_ANON_KEY），同步已关闭，本地读写不受影响。' };
  }
  const session = safeReadTeamSession(provider, config);
  if (!session) {
    return { ok: false, status: 'signed_out', reason: '尚未登录团队账号，同步已暂停，本地读写不受影响。' };
  }
  if (!session.teamId) {
    return { ok: false, status: 'no_team', reason: '账号还没有加入团队，暂时看不到队友的周期，本地读写不受影响。' };
  }
  return { ok: true, provider, session };
}

function idleResult(status: TeamSyncStatus, reason: string): TeamSyncResult {
  return {
    status,
    reason,
    checked: false,
    changed: false,
    pulled: 0,
    pushed: 0,
    plansPulled: 0,
    plansPushed: 0,
    plansPruned: 0,
    plansPurged: false,
    syncedAt: '',
  };
}

async function assertOk(response: Response, what: string): Promise<void> {
  if (response.ok) return;
  let detail = '';
  try {
    detail = (await response.text()).slice(0, 300);
  } catch {
    detail = '';
  }
  throw new Error(`Supabase ${what} failed: ${response.status}${detail ? ` ${detail}` : ''}`);
}

async function readJsonArray(response: Response): Promise<unknown[]> {
  const parsed = (await response.json()) as unknown;
  return Array.isArray(parsed) ? parsed : [];
}
