import crypto from 'node:crypto';
import type { AppConfig } from '../config/schema.js';
import { listCycles, parseCycleId, readCycle, serializeCycleMarkdown } from '../cycles/file.js';
import {
  isPlanDate,
  isUuid,
  listCachedCycles,
  listCachedDailyPlans,
  listCachedOwners,
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
    let plans = { changed: false, pulled: 0 };
    try {
      plansPushed = await pushTodayPlan(config, provider, session, state);
      plans = await pullTeammatePlans(config, provider, session, state, now);
    } catch (error) {
      planError = describePlanError(error);
    }
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
      syncedAt: state.syncedAt,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.lastCheckedAt = now.toISOString();
    state.lastError = message;
    writeTeamCacheState(state);
    return { status: 'error', reason: message, checked: true, changed: false, pulled: 0, pushed: 0, plansPulled: 0, plansPushed: 0, syncedAt: state.syncedAt };
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
    return { status: 'ok', reason: '', checked: true, changed: false, pulled: 0, pushed: pushed ? 1 : 0, plansPulled: 0, plansPushed: 0, syncedAt: state.syncedAt };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    state.lastError = message;
    writeTeamCacheState(state);
    return { status: 'error', reason: message, checked: true, changed: false, pulled: 0, pushed: 0, plansPulled: 0, plansPushed: 0, syncedAt: state.syncedAt };
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
    writeCachedCycle(config, session.userId, owner, cycleId, markdown);
    pulled += 1;
    if (updatedAt > highest) highest = updatedAt;
  }

  // Advance to what the cheap query reported, not to the max row we happened to
  // accept: a row skipped as malformed would otherwise be re-fetched forever.
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
    writeCachedDailyPlan(session.userId, owner, date, String(record.updated_at || ''), payload as Record<string, unknown>);
    pulled += 1;
  }

  state.planWatermark = watermark;
  state.syncedAt = now.toISOString();
  state.members = await readMembers(config, provider, state.members);
  return { changed: true, pulled };
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

// --- polling loop ------------------------------------------------------------

export const TEAM_SYNC_INTERVAL_MS = 60_000;

export interface TeamSyncLoop {
  /** Run a tick right now (what the console's 同步 button calls). */
  runNow: () => Promise<TeamSyncResult>;
  stop: () => void;
}

/**
 * Start the 60s poll. `loadConfigFn` is called per tick so a config change in
 * the console takes effect without a restart.
 *
 * The timer is `unref`'d: an idle poll must never be the reason a CLI process
 * refuses to exit.
 */
export function startTeamSync(loadConfigFn: () => AppConfig, deps: TeamSyncDeps & { intervalMs?: number } = {}): TeamSyncLoop {
  let running = false;
  const tick = async (): Promise<TeamSyncResult> => {
    // Overlapping ticks would double-push and race on state.json. A tick that
    // outlives its interval is a slow network, and skipping is the right answer.
    if (running) return idleResult('ok', 'sync already running');
    running = true;
    try {
      return await syncTeamOnce(loadConfigFn(), deps);
    } catch (error) {
      return idleResult('error', error instanceof Error ? error.message : String(error));
    } finally {
      running = false;
    }
  };

  if (process.env.DAILY_OS_DISABLE_TEAM_SYNC === '1') {
    return { runNow: tick, stop: () => {} };
  }

  void tick();
  const timer = setInterval(() => void tick(), deps.intervalMs ?? TEAM_SYNC_INTERVAL_MS);
  timer.unref?.();
  return { runNow: tick, stop: () => clearInterval(timer) };
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
  return { status, reason, checked: false, changed: false, pulled: 0, pushed: 0, plansPulled: 0, plansPushed: 0, syncedAt: '' };
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
