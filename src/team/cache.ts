import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { cyclesDir, parseCycleId, parseCycleMarkdown } from '../cycles/file.js';
import type { CycleDoc } from '../cycles/file.js';
import { writeFileAtomic } from '../utils/atomic-write.js';
import type { TeamMember } from './session-bridge.js';

/**
 * Local cache of teammates' cycle files (LEO-284).
 *
 * Two rules give this module its shape.
 *
 * **Teammate cycles never land in `20_CYCLES/`.** That directory means "my
 * cycles": every local tool — the planner, the Cycles editor, `listCycles` —
 * treats a file there as something the user owns and may rewrite. Dropping a
 * read-only copy of someone else's week in there would make it eligible for a
 * write-back the moment any of those paths ran, and there is no version history
 * in the vault to undo it with. So the cache is a separate tree, and
 * `writeCachedCycle` asserts the resolved path is inside it and outside
 * `cyclesDir(config)` before every write, rather than trusting the callers.
 *
 * **Directories are named by the owner uuid, not by `member_id`.** `member_id`
 * is a display label the teammate can change whenever they like, and the schema
 * deliberately keeps it out of every key for that reason. A cache keyed by the
 * label would silently split in two on a rename: the rows still arrive under the
 * same uuid, but they would be filed under a new directory, and the old one
 * would linger as a stale copy nothing ever refreshes. Keyed by uuid, a rename
 * is a label change in `state.json` and nothing else moves.
 *
 * Everything here is best-effort: a corrupt cache must degrade to "no teammate
 * data yet", never take down the local editor. Reads swallow their errors and
 * return empty.
 */

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function isUuid(value: unknown): value is string {
  return typeof value === 'string' && UUID_PATTERN.test(value.trim());
}

/** `<cwd>/data/team-cache`. Sits under `data/`, which is gitignored. */
export function teamCacheDir(): string {
  return path.resolve('data', 'team-cache');
}

export function teamCacheOwnerDir(ownerId: string): string {
  return path.join(teamCacheDir(), ownerId);
}

function teamCacheStatePath(): string {
  return path.join(teamCacheDir(), 'state.json');
}

/** What we know about one teammate cycle, as cached. */
export interface CachedCycle {
  id: string;
  startDate: string;
  cycle: string;
  mode: string;
  /** From the file's own frontmatter, i.e. when the *author* last wrote it. */
  updatedAt: string;
  sections: CycleDoc['sections'];
  frontmatterError: string;
}

export interface TeamCacheState {
  teamId: string;
  /**
   * Highest `cycles.updated_at` among teammates that we have already pulled the
   * bodies for. The next poll compares against this and fetches nothing when it
   * has not moved. Own rows are excluded, so our own writes cannot invalidate
   * it (see sync.ts).
   */
  watermark: string;
  /** Last time a poll reached the remote at all, successful or not. */
  lastCheckedAt: string;
  /** Last time teammate bodies actually landed in the cache. */
  syncedAt: string;
  /** Last transport error, cleared on the next success. */
  lastError: string;
  /** Members as of the last successful pull, so labels render offline. */
  members: TeamMember[];
  /**
   * `cycle id -> content hash` of what we last uploaded. Push compares the
   * local file's hash against this, so an unchanged file is not re-sent every
   * minute and an edit made while offline is still pending on the next tick.
   */
  pushed: Record<string, string>;
  /** Same as `watermark`, over teammates' `daily_plans` rows. */
  planWatermark: string;
  /** `plan date -> payload hash` of the daily plans we last uploaded. */
  pushedPlans: Record<string, string>;
}

const EMPTY_STATE: TeamCacheState = {
  teamId: '',
  watermark: '',
  lastCheckedAt: '',
  syncedAt: '',
  lastError: '',
  members: [],
  pushed: {},
  planWatermark: '',
  pushedPlans: {},
};

export function readTeamCacheState(): TeamCacheState {
  try {
    const parsed = JSON.parse(fs.readFileSync(teamCacheStatePath(), 'utf8')) as Partial<TeamCacheState>;
    return {
      teamId: asString(parsed.teamId),
      watermark: asString(parsed.watermark),
      lastCheckedAt: asString(parsed.lastCheckedAt),
      syncedAt: asString(parsed.syncedAt),
      lastError: asString(parsed.lastError),
      members: Array.isArray(parsed.members) ? parsed.members.filter((member) => isUuid((member as TeamMember)?.userId)) : [],
      pushed: asRecord(parsed.pushed),
      planWatermark: asString(parsed.planWatermark),
      pushedPlans: asRecord(parsed.pushedPlans),
    };
  } catch {
    return { ...EMPTY_STATE, members: [], pushed: {}, pushedPlans: {} };
  }
}

export function writeTeamCacheState(state: TeamCacheState): void {
  writeFileAtomic(teamCacheStatePath(), `${JSON.stringify(state, null, 2)}\n`);
}

/**
 * Drop the cache for a team we are no longer looking at. Called when the signed
 * in account's team changes: keeping the old team's markdown around would show
 * a stranger's week under a stale label.
 */
export function resetTeamCache(teamId: string): TeamCacheState {
  try {
    fs.rmSync(teamCacheDir(), { recursive: true, force: true });
  } catch {
    // Best effort. A cache we cannot clear is stale data, not lost data, and
    // the next successful pull overwrites it.
  }
  const next: TeamCacheState = { ...EMPTY_STATE, teamId, members: [], pushed: {}, pushedPlans: {} };
  writeTeamCacheState(next);
  return next;
}

/**
 * Cache one teammate cycle. Throws — loudly, and before touching the disk — if
 * the write would land anywhere but this teammate's cache directory.
 *
 * `selfUserId` is passed in so the "this is not my row" check happens here, at
 * the only place that writes, instead of only in the caller that filters the
 * query. The remote filter can be got wrong; this cannot be bypassed.
 */
export function writeCachedCycle(
  config: AppConfig,
  selfUserId: string,
  ownerId: string,
  cycleId: string,
  markdown: string,
): string {
  if (!isUuid(ownerId)) throw new Error(`Refusing to cache a cycle for a non-uuid owner: ${ownerId}`);
  if (selfUserId && ownerId === selfUserId) {
    throw new Error('Refusing to cache your own cycle: 20_CYCLES is the source of truth for your own files.');
  }
  if (!parseCycleId(cycleId)) throw new Error(`Refusing to cache an invalid cycle id: ${cycleId}`);

  const root = teamCacheDir();
  const filePath = path.resolve(root, ownerId, `${cycleId}.md`);
  if (!isInside(root, filePath)) throw new Error(`Refusing to write outside the team cache: ${filePath}`);
  // The one invariant a future refactor is most likely to break, asserted
  // against the directory it must never reach rather than inferred.
  if (isInside(cyclesDir(config), filePath)) {
    throw new Error(`Refusing to write teammate data into 20_CYCLES: ${filePath}`);
  }

  writeFileAtomic(filePath, markdown);
  return filePath;
}

/** Owner uuids that have at least one cached cycle. */
export function listCachedOwners(): string[] {
  try {
    return fs
      .readdirSync(teamCacheDir(), { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && isUuid(entry.name))
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

/** One teammate's cached cycles, newest start date first. Never throws. */
export function listCachedCycles(ownerId: string): CachedCycle[] {
  if (!isUuid(ownerId)) return [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(teamCacheOwnerDir(ownerId));
  } catch {
    return [];
  }
  const docs: CachedCycle[] = [];
  for (const name of names) {
    if (!name.endsWith('.md')) continue;
    const id = name.slice(0, -3);
    if (!parseCycleId(id)) continue;
    let markdown: string;
    try {
      markdown = fs.readFileSync(path.join(teamCacheOwnerDir(ownerId), name), 'utf8');
    } catch {
      continue;
    }
    const doc = parseCycleMarkdown(markdown, id);
    docs.push({
      id: doc.id,
      startDate: doc.startDate,
      cycle: doc.cycle,
      mode: doc.mode,
      updatedAt: doc.updatedAt,
      sections: doc.sections,
      frontmatterError: doc.frontmatterError || '',
    });
  }
  return docs.sort((left, right) => (left.id < right.id ? 1 : left.id > right.id ? -1 : 0));
}

// --- daily plans -------------------------------------------------------------

/**
 * A teammate's "today" list, as cached. `payload` is the owner's
 * `TodayPlanSnapshot` verbatim; it is stored as JSON and not re-validated
 * beyond being an object, because the reader (the console, the native clients)
 * already tolerates every field being absent.
 */
export interface CachedDailyPlan {
  date: string;
  /** Remote `updated_at`: when the owner's machine last pushed this day. */
  updatedAt: string;
  payload: Record<string, unknown>;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

export function isPlanDate(value: unknown): value is string {
  return typeof value === 'string' && DATE_PATTERN.test(value);
}

function teamCachePlanDir(ownerId: string): string {
  return path.join(teamCacheOwnerDir(ownerId), 'daily');
}

/**
 * Cache one teammate daily plan under `<owner>/daily/<date>.json`. Same guards
 * as `writeCachedCycle`: never our own row, never outside the cache tree. The
 * `daily/` subdirectory keeps `listCachedCycles` (which only reads `*.md` in
 * the owner directory) from ever seeing these files.
 */
export function writeCachedDailyPlan(
  selfUserId: string,
  ownerId: string,
  date: string,
  updatedAt: string,
  payload: Record<string, unknown>,
): string {
  if (!isUuid(ownerId)) throw new Error(`Refusing to cache a daily plan for a non-uuid owner: ${ownerId}`);
  if (selfUserId && ownerId === selfUserId) {
    throw new Error('Refusing to cache your own daily plan: the local workflow output is the source of truth.');
  }
  if (!isPlanDate(date)) throw new Error(`Refusing to cache an invalid plan date: ${date}`);

  const root = teamCacheDir();
  const filePath = path.resolve(root, ownerId, 'daily', `${date}.json`);
  if (!isInside(root, filePath)) throw new Error(`Refusing to write outside the team cache: ${filePath}`);

  const record: CachedDailyPlan = { date, updatedAt, payload };
  writeFileAtomic(filePath, `${JSON.stringify(record, null, 2)}\n`);
  return filePath;
}

/** One teammate's cached daily plans, newest date first. Never throws. */
export function listCachedDailyPlans(ownerId: string): CachedDailyPlan[] {
  if (!isUuid(ownerId)) return [];
  let names: string[] = [];
  try {
    names = fs.readdirSync(teamCachePlanDir(ownerId));
  } catch {
    return [];
  }
  const plans: CachedDailyPlan[] = [];
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const date = name.slice(0, -5);
    if (!isPlanDate(date)) continue;
    try {
      const parsed = JSON.parse(fs.readFileSync(path.join(teamCachePlanDir(ownerId), name), 'utf8')) as Partial<CachedDailyPlan>;
      const payload = parsed.payload && typeof parsed.payload === 'object' && !Array.isArray(parsed.payload) ? parsed.payload : null;
      if (!payload) continue;
      plans.push({ date, updatedAt: asString(parsed.updatedAt), payload });
    } catch {
      continue;
    }
  }
  return plans.sort((left, right) => (left.date < right.date ? 1 : left.date > right.date ? -1 : 0));
}

function isInside(root: string, candidate: string): boolean {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function asRecord(value: unknown): Record<string, string> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, string>) : {};
}
