/**
 * 固定日程: the slots of today's 作息, each one to-do on Today.
 *
 * A 作息 slot (作品集 redesign 13:00, Build in public 08:15, 看书, 画画, the
 * daily meeting) is something the user does every day at that time. What it
 * holds changes — today the homepage frame, tomorrow the banner — and comes
 * from the cycle's 要务 assigned to it (`CycleSchedule.fixed`): their sessions
 * today become the slot's content. So the slot is the to-do; the 要务 it
 * covers get no rows of their own, and two 要务 that are one daily action
 * become one line.
 *
 * Not every slot is a row. A later slot with the same title as an earlier one
 * the same day (作品集 redesign 14:30–18:00 after the 13:00 floor) is the
 * flexible pool: free time other to-dos may use, drawn as a band.
 */
import type { AppConfig } from '../config/schema.js';
import { resolveDayShape } from '../user/rhythm.js';
import { currentCycle } from '../workflows/weekly-priorities.js';
import { listTodoFeedback } from '../todo/feedback.js';
import { fixedTitleKey, readSchedule, type ScheduleSession } from './schedule.js';

export interface FixedScheduleRow {
  /** `rhythm:habit:<blockId>` for a habit slot, `rhythm:block:<blockId>` otherwise. */
  candidateId: string;
  blockId: string;
  title: string;
  start: string;
  end: string;
  minutes: number;
  habit: boolean;
  floor: boolean;
  category?: string;
  color?: string;
  /** Today's steps of the 要务 this slot covers, in schedule order. */
  steps: string[];
  /** The 要务 (item keys) this row stands for today. */
  itemKeys: string[];
  /** What the row says: the title, then today's content. */
  text: string;
}

function minutesBetween(start: string, end: string): number {
  const toMinutes = (clock: string): number => (clock === '24:00' ? 1440 : Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3, 5)));
  return toMinutes(end) - toMinutes(start);
}

/** Today's 固定日程, in time order. Empty without a 作息. */
export function fixedScheduleFor(config: AppConfig, date: string): FixedScheduleRow[] {
  const slots = [...(resolveDayShape(config, date).routine?.slots ?? [])].sort((left, right) => left.start.localeCompare(right.start));
  if (slots.length === 0) return [];
  const doc = currentCycle(config, date);
  const schedule = doc ? readSchedule(config, doc.id) : null;
  const sessions = (schedule?.sessions ?? []).filter((session) => session.date === date && !session.skipped);
  const assigned = new Map((schedule?.fixed ?? []).map((assignment) => [fixedTitleKey(assignment.title), assignment.itemKeys]));

  const seen = new Set<string>();
  const rows: FixedScheduleRow[] = [];
  for (const slot of slots) {
    const key = fixedTitleKey(slot.title);
    const first = !seen.has(key);
    seen.add(key);
    // A repeat of a title already on the day is that 固定日程's flexible pool.
    if (!first && !slot.habit) continue;
    const keys = first ? (assigned.get(key) ?? []) : [];
    const today = sessions.filter((session) => keys.includes(session.itemKey));
    const steps = [...new Set(today.map((session) => session.step?.trim() || session.label))];
    const itemKeys = [...new Set(today.map((session) => session.itemKey))];
    const content = steps.length > 0 ? steps.join('；') : slot.note;
    rows.push({
      candidateId: `rhythm:${slot.habit ? 'habit' : 'block'}:${slot.id}`,
      blockId: slot.id,
      title: slot.title,
      start: slot.start,
      end: slot.end,
      minutes: minutesBetween(slot.start, slot.end),
      habit: Boolean(slot.habit),
      floor: Boolean(slot.floor),
      ...(slot.category ? { category: slot.category } : {}),
      ...(slot.color ? { color: slot.color } : {}),
      steps,
      itemKeys,
      text: content ? `${slot.title}：${content}` : slot.title,
    });
  }
  return rows;
}

/** The 要务 today's 固定日程 stand for: they get no rows of their own. */
export function fixedCoverage(rows: FixedScheduleRow[]): Set<string> {
  return new Set(rows.flatMap((row) => row.itemKeys));
}

/** The 固定日程 row behind a candidate id, if it is one. */
export function fixedRowFor(config: AppConfig, date: string, candidateId: string): FixedScheduleRow | undefined {
  if (!candidateId.startsWith('rhythm:habit:') && !candidateId.startsWith('rhythm:block:')) return undefined;
  return fixedScheduleFor(config, date).find((row) => row.candidateId === candidateId);
}

/**
 * How each row was left on `date`: complete / partial / missed / defer, by
 * candidate id. A `reopen` takes a row back to untouched.
 */
export function rowStatesOn(config: AppConfig, date: string): Map<string, string> {
  const states = new Map<string, string>();
  for (const entry of listTodoFeedback(config)) {
    if (entry.date !== date) continue;
    if (entry.event === 'complete' || entry.event === 'partial' || entry.event === 'missed' || entry.event === 'defer') states.set(entry.candidateId, entry.event);
    if (entry.event === 'reopen') states.delete(entry.candidateId);
  }
  return states;
}

/**
 * One day of the 双周排期 as the calendar draws it: its 固定日程 with what
 * they hold and how they were left, and the state of each session that is not
 * inside one. Days after today have no states.
 */
export function scheduleDayView(config: AppConfig, date: string, today: string, sessions: ScheduleSession[]): {
  fixed: Array<{ candidateId: string; start: string; end: string; title: string; text: string; habit?: boolean; floor?: boolean; category?: string; color?: string; itemKeys: string[]; state?: string }>;
  states: Record<string, string>;
} {
  const rows = fixedScheduleFor(config, date);
  const recorded = date <= today ? rowStatesOn(config, date) : new Map<string, string>();
  const weeklyState = (itemKey: string): string | undefined =>
    [...recorded.entries()].find(([id]) => id.startsWith('weekly:') && id.split(':')[2] === itemKey)?.[1];
  const fixed = rows.map((row) => {
    const derived = row.itemKeys.length > 0 && row.itemKeys.every((key) => weeklyState(key) === 'complete') ? 'complete' : undefined;
    const state = recorded.get(row.candidateId) ?? derived;
    return {
      candidateId: row.candidateId,
      start: row.start,
      end: row.end,
      title: row.title,
      text: row.text,
      ...(row.habit ? { habit: true } : {}),
      ...(row.floor ? { floor: true } : {}),
      ...(row.category ? { category: row.category } : {}),
      ...(row.color ? { color: row.color } : {}),
      itemKeys: row.itemKeys,
      ...(state ? { state } : {}),
    };
  });
  const states: Record<string, string> = {};
  for (const session of sessions) {
    if (session.date !== date) continue;
    const inside = fixed.find((row) => row.itemKeys.includes(session.itemKey));
    const state = inside ? inside.state : weeklyState(session.itemKey);
    if (state) states[session.id] = state;
  }
  return { fixed, states };
}
