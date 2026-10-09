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
import { fixedTitleKey, readSchedule } from './schedule.js';

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
