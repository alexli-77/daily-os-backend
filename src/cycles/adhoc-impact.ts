import type { AppConfig } from '../config/schema.js';
import { listTodoFeedback } from '../todo/feedback.js';
import { routineForDate } from '../user/routine.js';
import { timeInZone, todayInTimezone } from '../utils/date.js';
import { fixedScheduleFor } from './fixed-schedule.js';
import { scheduledSessionsFor, type ScheduleSession } from './schedule.js';
import { weeklyItemKey } from './schedule-writeback.js';

/**
 * Does something added today crowd out this 双周's 要务?
 *
 * 2026-11-02, the user: "新增任务一旦比较重要，或者需要投入时间，会影响到本期
 * weekly 任务的完成，应该给一个提醒机制，或者重新帮我去编排……现在就像一个写
 * 日历的工具。" Adding a 临时安排 cleared room in the 作息 and said nothing
 * about the 要务 sessions that room was for.
 *
 * The measure is deliberately plain: the work time left today (the 作息's work
 * slots from now on, after the new thing took its room) against the minutes of
 * today's 要务 sessions not yet done. When the new thing took work time and
 * the sessions no longer fit, the ones that do not fit are named — the last of
 * the day first, a big rock last — so the user can push them to tomorrow or
 * have the rest of the 双周 rearranged.
 */

export interface WorkBlock {
  id: string;
  start: string;
  end: string;
  kind: 'fixed' | 'slot';
  habit?: boolean;
  category?: string;
}

export interface Squeezed {
  itemKey: string;
  label: string;
  minutes: number;
}

export interface AdhocImpact {
  /** Minutes of 要务 today that no longer fit. */
  shortfall: number;
  /** Work minutes the new thing took. */
  taken: number;
  squeezed: Squeezed[];
  text: string;
}

const toMinutes = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5));

/** A slot that holds 要务 work: not a habit, not a calendar event or a one-day add. */
function isWorkSlot(block: WorkBlock): boolean {
  if (block.kind !== 'slot' || block.habit) return false;
  return !/^(cal|add|evt)-/.test(block.id);
}

/** Work minutes of `blocks` from `now` on. */
export function workMinutesFrom(blocks: WorkBlock[], now: string): number {
  const from = toMinutes(now);
  return blocks.filter(isWorkSlot).reduce((sum, block) => sum + Math.max(0, toMinutes(block.end) - Math.max(toMinutes(block.start), from)), 0);
}

/** Work minutes of `blocks` inside `start`…`end`, from `now` on. */
export function workMinutesIn(blocks: WorkBlock[], start: string, end: string, now: string): number {
  const from = Math.max(toMinutes(start), toMinutes(now));
  const to = toMinutes(end);
  return blocks.filter(isWorkSlot).reduce((sum, block) => sum + Math.max(0, Math.min(to, toMinutes(block.end)) - Math.max(from, toMinutes(block.start))), 0);
}

/**
 * The pure part. `before`: the day's blocks without the new thing; `after`:
 * with it. `sessions`: today's 要务 sessions not yet done.
 */
export function measureImpact(input: {
  before: WorkBlock[];
  after: WorkBlock[];
  sessions: Array<Pick<ScheduleSession, 'itemKey' | 'label' | 'minutes' | 'bigRock' | 'start'>>;
  window: { start: string; end: string };
  now: string;
}): AdhocImpact | null {
  const taken = workMinutesIn(input.before, input.window.start, input.window.end, input.now);
  if (taken <= 0) return null;
  const demand = input.sessions.reduce((sum, session) => sum + session.minutes, 0);
  const shortfall = demand - workMinutesFrom(input.after, input.now);
  if (shortfall <= 0) return null;
  // Push the least committed first: no reserved time, latest in the day.
  const order = [...input.sessions].sort((left, right) => Number(Boolean(left.bigRock)) - Number(Boolean(right.bigRock)) || (right.start ?? '99').localeCompare(left.start ?? '99'));
  const squeezed: Squeezed[] = [];
  let covered = 0;
  for (const session of order) {
    if (covered >= shortfall) break;
    const known = squeezed.find((entry) => entry.itemKey === session.itemKey);
    if (known) known.minutes += session.minutes;
    else squeezed.push({ itemKey: session.itemKey, label: session.label, minutes: session.minutes });
    covered += session.minutes;
  }
  const hours = (minutes: number) => (minutes >= 60 ? `${Math.round((minutes / 60) * 10) / 10}h` : `${minutes}m`);
  const names = squeezed.map((entry) => `「${entry.label.slice(0, 18)}」${hours(entry.minutes)}`).join('、');
  return {
    shortfall,
    taken,
    squeezed,
    text: `这条占了 ${hours(taken)} 的工作时间，今天排的要务还差 ${hours(shortfall)} 放不下：${names}。`,
  };
}

/** Today's 要务 sessions whose 要务 has not been ticked today. */
function openSessionsToday(config: AppConfig, date: string): ScheduleSession[] {
  const sessions = scheduledSessionsFor(config, date);
  if (sessions.length === 0) return [];
  const done = new Set<string>();
  const latest = new Map<string, string>();
  for (const entry of listTodoFeedback(config)) if (entry.date === date) latest.set(entry.candidateId, entry.event);
  for (const [candidateId, event] of latest) {
    if (event !== 'complete') continue;
    const key = weeklyItemKey(candidateId);
    if (key) done.add(key);
  }
  for (const row of fixedScheduleFor(config, date)) {
    if (latest.get(row.candidateId) === 'complete') row.itemKeys.forEach((key) => done.add(key));
  }
  return sessions.filter((session) => !done.has(session.itemKey));
}

/** The impact of a 临时安排 just placed today in `window`; `before` is the day's blocks read before it. */
export function adhocImpact(config: AppConfig, date: string, before: WorkBlock[], window: { start: string; end: string }): AdhocImpact | null {
  try {
    if (date !== todayInTimezone(config)) return null;
    const after = (routineForDate(config, date)?.blocks ?? []) as WorkBlock[];
    return measureImpact({ before, after, sessions: openSessionsToday(config, date), window, now: timeInZone(config.user.timezone) });
  } catch (error) {
    console.warn(`[adhoc] impact not measured: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}
