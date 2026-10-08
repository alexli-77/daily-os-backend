/**
 * Today → 双周排期: what is changed on the Today page lands in the schedule.
 *
 * The schedule is the one source of truth for which 要务 happens on which
 * day; Today is where plans meet the day. Without this, every change made on
 * Today (pushed to tomorrow, dropped, a game of badminton that came up) left
 * the schedule saying something else, and the next plan repeated it.
 *
 * Every change is reversible — the Today page offers 撤销 — so nothing is
 * deleted: a dropped session is marked `skipped`, a moved one remembers
 * `movedFrom`, a session an ad-hoc one replaced remembers `takenBy`.
 */
import type { AppConfig } from '../config/schema.js';
import { addDays } from '../utils/date.js';
import { currentCycle } from '../workflows/weekly-priorities.js';
import { cycleDays, readSchedule, writeSchedule, type CycleSchedule, type ScheduleSession } from './schedule.js';
import { idFragment } from '../todo/scorer.js';

/** The 8-hex 要务 key in a weekly candidate id, or null for any other row. */
export function weeklyItemKey(candidateId: string): string | null {
  const match = /^weekly:\d+:([0-9a-f]{8})$/.exec(candidateId);
  return match ? match[1]! : null;
}

interface Loaded {
  schedule: CycleSchedule;
  days: string[];
}

function load(config: AppConfig, date: string): Loaded | null {
  const doc = currentCycle(config, date);
  if (!doc) return null;
  const schedule = readSchedule(config, doc.id);
  return schedule ? { schedule, days: cycleDays(doc) } : null;
}

function short(date: string): string {
  return `${Number(date.slice(5, 7))}.${Number(date.slice(8, 10))}`;
}

/**
 * 顺到明天: today's sessions of the 要务 move to the next day of the cycle.
 * On the cycle's last day there is no tomorrow in it, so they are skipped.
 */
export function deferScheduled(config: AppConfig, date: string, itemKey: string): string | null {
  const loaded = load(config, date);
  if (!loaded) return null;
  const today = loaded.schedule.sessions.filter((session) => session.date === date && session.itemKey === itemKey && !session.skipped);
  if (today.length === 0) return null;
  const tomorrow = addDays(date, 1);
  const inCycle = loaded.days.includes(tomorrow);
  for (const session of today) {
    if (inCycle) {
      session.movedFrom = date;
      session.date = tomorrow;
      // Tomorrow's slot is not today's: a reserved time does not carry over.
      delete session.start;
      delete session.bigRock;
    } else {
      session.skipped = true;
    }
  }
  writeSchedule(config, loaded.schedule);
  return inCycle ? `排期也挪了：${today[0]!.label.slice(0, 16)} 移到 ${short(tomorrow)}` : '排期里这一次划掉了（这一期已经到最后一天）';
}

/** 这次不做了: today's sessions of the 要务 are skipped. */
export function skipScheduled(config: AppConfig, date: string, itemKey: string): string | null {
  const loaded = load(config, date);
  if (!loaded) return null;
  const today = loaded.schedule.sessions.filter((session) => session.date === date && session.itemKey === itemKey && !session.skipped);
  if (today.length === 0) return null;
  for (const session of today) session.skipped = true;
  writeSchedule(config, loaded.schedule);
  return `排期里今天这一次划掉了：${today[0]!.label.slice(0, 16)}`;
}

/**
 * Undo either of the above for this date: sessions moved away from it come
 * back, sessions skipped on it are restored. Ad-hoc sessions are left alone —
 * they have their own undo.
 */
export function restoreScheduled(config: AppConfig, date: string, itemKey: string): string | null {
  const loaded = load(config, date);
  if (!loaded) return null;
  let changed = 0;
  for (const session of loaded.schedule.sessions) {
    if (session.itemKey !== itemKey) continue;
    if (session.movedFrom === date) {
      session.date = date;
      delete session.movedFrom;
      changed += 1;
    } else if (session.date === date && session.skipped && !session.takenBy) {
      delete session.skipped;
      changed += 1;
    }
  }
  if (changed === 0) return null;
  writeSchedule(config, loaded.schedule);
  return '排期也恢复了';
}

/**
 * 临时安排 of a 要务 on `date`: a session is added there. Unless it is extra,
 * it counts as one of the cycle's — the nearest later session of the same
 * 要务 is taken by it (skipped, remembering which session took it).
 */
export function addAdhocSession(
  config: AppConfig,
  date: string,
  itemKey: string,
  session: { start: string; minutes: number; step: string },
  options: { extra?: boolean; id?: string } = {},
): { sessionId: string; takenDate?: string; text: string } | null {
  const loaded = load(config, date);
  if (!loaded) return null;
  const label = loaded.schedule.sessions.find((existing) => existing.itemKey === itemKey)?.label ?? session.step;
  const id = options.id && /^[a-z0-9-]{1,40}$/.test(options.id) ? options.id : `a-${idFragment(`${itemKey}|${date}|${session.start}|${Date.now()}`)}`;
  const added: ScheduleSession = { id, itemKey, label, date, start: session.start, minutes: session.minutes, bigRock: true, step: session.step, adhoc: true };
  let taken: ScheduleSession | undefined;
  if (!options.extra) {
    taken = loaded.schedule.sessions
      .filter((existing) => existing.itemKey === itemKey && existing.date > date && !existing.skipped)
      .sort((left, right) => left.date.localeCompare(right.date))[0];
    if (taken) {
      taken.skipped = true;
      taken.takenBy = id;
    }
  }
  loaded.schedule.sessions.push(added);
  loaded.schedule.sessions.sort((left, right) => (left.date + (left.start ?? '99')).localeCompare(right.date + (right.start ?? '99')));
  writeSchedule(config, loaded.schedule);
  return {
    sessionId: id,
    ...(taken ? { takenDate: taken.date } : {}),
    text: taken ? `排期记上了今天这一次，${short(taken.date)} 那次抵掉` : '排期记上了今天这一次（额外的）',
  };
}

/** Undo an ad-hoc session: it goes, and the session it took comes back. */
export function removeAdhocSession(config: AppConfig, date: string, sessionId: string): boolean {
  const loaded = load(config, date);
  if (!loaded) return false;
  const before = loaded.schedule.sessions.length;
  loaded.schedule.sessions = loaded.schedule.sessions.filter((session) => session.id !== sessionId);
  for (const session of loaded.schedule.sessions) {
    if (session.takenBy === sessionId) {
      delete session.skipped;
      delete session.takenBy;
    }
  }
  if (loaded.schedule.sessions.length === before) return false;
  writeSchedule(config, loaded.schedule);
  return true;
}

/** An ad-hoc session's time follows its row when the row is moved on Today. */
export function moveAdhocSession(config: AppConfig, date: string, sessionId: string, change: { start?: string; minutes?: number }): boolean {
  const loaded = load(config, date);
  if (!loaded) return false;
  const session = loaded.schedule.sessions.find((existing) => existing.id === sessionId);
  if (!session) return false;
  if (change.start) session.start = change.start;
  if (change.minutes && change.minutes > 0) session.minutes = change.minutes;
  writeSchedule(config, loaded.schedule);
  return true;
}
