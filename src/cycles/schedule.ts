/**
 * 双周排期: the cycle's 要务 laid out over its days, before any day is planned.
 *
 * The daily plan used to re-derive the whole cycle every morning from a flat
 * list of 要务, so the same mistakes came back daily — a deadline found out on
 * the day, a big piece of work never given a slot, a meeting ranked as the MIT.
 * After Covey's "schedule your priorities": the big rocks of each role (the
 * cycle's OKR headings) get concrete slots first, everything else a day, and
 * the daily plan becomes a slice of this rather than a fresh guess.
 *
 * Stored beside the cycle as `<cycleId>.schedule.json`, so it travels with the
 * vault. A session names its 要务 by `itemKey` — the same 8-hex fragment the
 * weekly candidate id ends in — so the plan can find "today's sessions" by id.
 * `label` keeps the text it was made for, so a session whose 要务 was later
 * reworded still says what it was.
 */
import fs from 'node:fs';
import path from 'node:path';

import { runAgent } from '../agent/index.js';
import { fetchAgenda, type AgendaEvent } from '../calendar/agenda.js';
import type { AppConfig } from '../config/schema.js';
import { idFragment } from '../todo/scorer.js';
import { resolveDayShape } from '../user/rhythm.js';
import { addDays } from '../utils/date.js';
import { extractJsonObject } from '../workflows/summary.js';
import { currentCycle, labelSpanCoveringDate, parseCyclePriorities } from '../workflows/weekly-priorities.js';
import { cyclesDir, parseCycleId, readCycle, type CycleDoc } from './file.js';

export interface ScheduleSession {
  id: string;
  itemKey: string;
  label: string;
  /** `YYYY-MM-DD`. */
  date: string;
  /** `HH:mm`. Only big rocks carry one; the rest only have a day. */
  start?: string;
  minutes: number;
  /** A slot reserved before anything else is planned around it. */
  bigRock?: boolean;
  /**
   * What this session does — one step of the 要务, not the 要务 again. A 要务
   * worked over several days is a sequence ("整理回访表格", then "海外邮件引流
   * 进 Discord"); the day's to-do is written from this.
   */
  step?: string;
  /**
   * Not happening — dropped from Today, or taken by an ad-hoc session. Kept
   * rather than deleted so undoing it on Today can put it back.
   */
  skipped?: boolean;
  /** Set when Today pushed this session here from that date (顺到明天). */
  movedFrom?: string;
  /** Added from Today (临时安排), not by the schedule. */
  adhoc?: boolean;
  /** The ad-hoc session that took this one's place. */
  takenBy?: string;
}

export interface ScheduleDeadline {
  itemKey: string;
  label: string;
  date: string;
}

export interface CycleSchedule {
  cycleId: string;
  generatedAt: string;
  /** Set once the user has changed it by hand. */
  editedAt?: string;
  sessions: ScheduleSession[];
  deadlines: ScheduleDeadline[];
  note?: string;
  /**
   * Which 要务 belong to which 固定日程 — a 作息 slot by its title ("作品集
   * redesign"). On a day that has that slot, Today shows the slot itself as the
   * to-do, with the day's steps of these 要务 as its content, instead of a
   * separate row per 要务. Two 要务 that are one daily action share a slot.
   */
  fixed?: FixedAssignment[];
}

export interface FixedAssignment {
  /** The 作息 slot's title, as the user named it. */
  title: string;
  itemKeys: string[];
}

/** One schedulable 要务: its key, text, role (the OKR heading) and MIT mark. */
export interface ScheduleItem {
  key: string;
  text: string;
  okr: string;
  mit: boolean;
}

export const SCHEDULE_MIN_MINUTES = 15;
export const SCHEDULE_MAX_MINUTES = 240;
/** Longest step text, in characters — one line on a calendar block. */
export const SCHEDULE_STEP_MAX = 80;

export function scheduleFilePath(config: AppConfig, cycleId: string): string {
  if (!parseCycleId(cycleId)) throw new Error(`Invalid cycle id: ${cycleId}`);
  return path.join(cyclesDir(config), `${cycleId}.schedule.json`);
}

export function readSchedule(config: AppConfig, cycleId: string): CycleSchedule | null {
  try {
    const raw = JSON.parse(fs.readFileSync(scheduleFilePath(config, cycleId), 'utf8')) as unknown;
    return isRecord(raw) && Array.isArray(raw.sessions) ? (raw as unknown as CycleSchedule) : null;
  } catch {
    return null;
  }
}

export function writeSchedule(config: AppConfig, schedule: CycleSchedule): CycleSchedule {
  const file = scheduleFilePath(config, schedule.cycleId);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(schedule, null, 2)}\n`);
  fs.renameSync(temp, file);
  return schedule;
}

/** The cycle's days, first to last. Empty when its label has no readable span. */
export function cycleDays(doc: CycleDoc): string[] {
  if (!doc.startDate) return [];
  const span = labelSpanCoveringDate(doc.cycle, doc.startDate);
  if (!span) return [];
  return Array.from({ length: span }, (_, index) => addDays(doc.startDate, index));
}

/** The 要务 a schedule can refer to: every open bullet, ✅ ones left out. */
export function cycleScheduleItems(doc: CycleDoc): ScheduleItem[] {
  const seen = new Set<string>();
  const items: ScheduleItem[] = [];
  for (const entry of parseCyclePriorities(doc.sections['要务']?.content || '', doc.cycle, doc.id)) {
    const text = entry.item.trim();
    if (!text || /✅/.test(text)) continue;
    const key = idFragment(text);
    if (seen.has(key)) continue;
    seen.add(key);
    items.push({ key, text, okr: entry.okr, mit: /\bMIT\b/.test(text) });
  }
  return items;
}

/**
 * Make anything — the model's output or a client's edit — into a schedule
 * that only says things that can be true: sessions for known 要务, on the
 * cycle's days, with sane lengths and clock times. Whatever does not qualify
 * is dropped rather than repaired; `dropped` says how much.
 */
export function normalizeSchedule(
  raw: unknown,
  context: { cycleId: string; items: ScheduleItem[]; days: string[]; generatedAt: string; editedAt?: string },
): { schedule: CycleSchedule; dropped: number } {
  const record = isRecord(raw) ? raw : {};
  const byKey = new Map(context.items.map((item) => [item.key, item]));
  const days = new Set(context.days);
  let dropped = 0;

  const sessions: ScheduleSession[] = [];
  for (const entry of Array.isArray(record.sessions) ? record.sessions : []) {
    if (!isRecord(entry)) { dropped += 1; continue; }
    const itemKey = String(entry.itemKey ?? '').trim();
    const date = String(entry.date ?? '').trim();
    const item = byKey.get(itemKey);
    // A session the user kept for a 要务 that was later reworded keeps its label.
    const label = item?.text ?? (typeof entry.label === 'string' ? entry.label.trim() : '');
    if (!label || !days.has(date)) { dropped += 1; continue; }
    if (!item && !context.editedAt) { dropped += 1; continue; }
    const minutes = clampMinutes(entry.minutes);
    if (minutes === null) { dropped += 1; continue; }
    const start = typeof entry.start === 'string' && CLOCK.test(entry.start.trim()) ? entry.start.trim() : undefined;
    const id = typeof entry.id === 'string' && /^[a-z0-9-]{1,40}$/.test(entry.id) ? entry.id : `s-${idFragment(`${itemKey}|${date}|${sessions.length}`)}`;
    const step = typeof entry.step === 'string' ? Array.from(entry.step.trim()).slice(0, SCHEDULE_STEP_MAX).join('') : '';
    sessions.push({
      id,
      itemKey,
      label,
      date,
      ...(start ? { start } : {}),
      minutes,
      // A big rock is a reserved slot: without a time it is just a day.
      ...(entry.bigRock === true && start ? { bigRock: true } : {}),
      ...(step ? { step } : {}),
      ...(entry.skipped === true ? { skipped: true } : {}),
      ...(typeof entry.movedFrom === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.movedFrom) ? { movedFrom: entry.movedFrom } : {}),
      ...(entry.adhoc === true ? { adhoc: true } : {}),
      ...(typeof entry.takenBy === 'string' && /^[a-z0-9-]{1,40}$/.test(entry.takenBy) ? { takenBy: entry.takenBy } : {}),
    });
  }
  sessions.sort((left, right) => (left.date + (left.start ?? '99')).localeCompare(right.date + (right.start ?? '99')));

  const deadlines: ScheduleDeadline[] = [];
  for (const entry of Array.isArray(record.deadlines) ? record.deadlines : []) {
    if (!isRecord(entry)) { dropped += 1; continue; }
    const itemKey = String(entry.itemKey ?? '').trim();
    const date = String(entry.date ?? '').trim();
    const item = byKey.get(itemKey);
    if (!item || !/^\d{4}-\d{2}-\d{2}$/.test(date)) { dropped += 1; continue; }
    if (deadlines.some((deadline) => deadline.itemKey === itemKey)) continue;
    deadlines.push({ itemKey, label: item.text, date });
  }

  const note = typeof record.note === 'string' ? record.note.trim().slice(0, 400) : '';
  // One 固定日程 per title, one 固定日程 per 要务: the first claim wins.
  const fixed: FixedAssignment[] = [];
  const claimed = new Set<string>();
  for (const entry of Array.isArray(record.fixed) ? record.fixed : []) {
    if (!isRecord(entry)) { dropped += 1; continue; }
    const title = typeof entry.title === 'string' ? entry.title.trim().slice(0, 40) : '';
    if (!title || fixed.some((assignment) => fixedTitleKey(assignment.title) === fixedTitleKey(title))) { dropped += 1; continue; }
    const itemKeys = (Array.isArray(entry.itemKeys) ? entry.itemKeys : [])
      .map((key) => String(key).trim())
      .filter((key) => byKey.has(key) && !claimed.has(key));
    if (itemKeys.length === 0) { dropped += 1; continue; }
    for (const key of itemKeys) claimed.add(key);
    fixed.push({ title, itemKeys });
  }
  return {
    schedule: {
      cycleId: context.cycleId,
      generatedAt: context.generatedAt,
      ...(context.editedAt ? { editedAt: context.editedAt } : {}),
      sessions,
      deadlines,
      ...(note ? { note } : {}),
      ...(fixed.length > 0 ? { fixed } : {}),
    },
    dropped,
  };
}

/** A 固定日程 title as compared: case and spacing do not make a new one. */
export function fixedTitleKey(title: string): string {
  // A note added for one day — 「画画（补今天的，多画半小时）」 — is still 画画.
  return title.replace(/\s*[（(][^（）()]*[）)]\s*$/, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** The model's reply, parsed; null when it holds no JSON object. */
export function parseScheduleOutput(text: string): unknown {
  const json = extractJsonObject(text);
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

/** Whether the cycle covering `date` has a schedule at all. */
export function hasCycleSchedule(config: AppConfig, date: string): boolean {
  const doc = currentCycle(config, date);
  return Boolean(doc && readSchedule(config, doc.id));
}

/**
 * What the schedule says about `date`: its sessions, by item key. Empty when
 * no cycle covers the date or the cycle has no schedule — the daily plan then
 * works the way it always has.
 */
export function scheduledSessionsFor(config: AppConfig, date: string): ScheduleSession[] {
  const doc = currentCycle(config, date);
  if (!doc) return [];
  return (readSchedule(config, doc.id)?.sessions ?? []).filter((session) => session.date === date && !session.skipped);
}

/**
 * The item keys the schedule places on some day other than `date` and not on
 * `date` itself — 要务 the plan should leave for their own day.
 */
export function scheduledElsewhere(config: AppConfig, date: string): Set<string> {
  const doc = currentCycle(config, date);
  if (!doc) return new Set();
  const sessions = (readSchedule(config, doc.id)?.sessions ?? []).filter((session) => !session.skipped);
  const today = new Set(sessions.filter((session) => session.date === date).map((session) => session.itemKey));
  return new Set(sessions.filter((session) => session.date !== date && !today.has(session.itemKey)).map((session) => session.itemKey));
}

/**
 * The evidence the cycle_schedule prompt plans from: the 要务 with their keys
 * and roles, the days still to plan with their day type and fixed blocks, and
 * the sessions already behind us (kept as they were).
 */
export function buildScheduleEvidence(
  config: AppConfig,
  doc: CycleDoc,
  today: string,
  existing: CycleSchedule | null,
  nowClock?: string,
  events: AgendaEvent[] = [],
) {
  const days = cycleDays(doc).filter((day) => day >= today);
  return {
    cycle: { id: doc.id, label: doc.cycle, first: cycleDays(doc)[0] ?? doc.startDate, last: cycleDays(doc).at(-1) ?? '' },
    today,
    // Generated mid-day, today's slots before now are already gone.
    ...(nowClock ? { nowClock } : {}),
    items: cycleScheduleItems(doc).map((item) => ({ itemKey: item.key, text: item.text, role: item.okr, mit: item.mit })),
    days: days.map((day) => {
      const shape = resolveDayShape(config, day);
      return {
        date: day,
        weekday: shape.weekdayLabel,
        dayType: shape.dayTypeLabel,
        workingHours: shape.workingHours,
        meals: shape.mealBlocks.map((block) => `${block.start}-${block.end} ${block.label}`),
        fixed: shape.fixedBlocks.map((block) => `${block.start}-${block.end} ${block.label}`),
        // The 作息's time kept per category, when one covers the day.
        ...(shape.routine
          ? { routine: { mode: shape.routine.mode.label, slots: shape.routine.slots.map((slot) => `${slot.start}-${slot.end} ${slot.title}${slot.category ? `〔${slot.category}${slot.floor ? '·保底' : ''}〕` : ''}`) } }
          : {}),
        // The user's calendar: meetings already accepted are not free time.
        events: events
          .filter((event) => event.date === day)
          .map((event) => (event.start ? `${event.start}-${event.end ?? ''} ${event.title}` : `全天 ${event.title}`)),
      };
    }),
    pastSessions: (existing?.sessions ?? []).filter((session) => session.date < today),
    // Which 要务 already belong to which 固定日程, as last settled.
    ...(existing?.fixed ? { settledFixed: existing.fixed } : {}),
  };
}

export function readCycleOrThrow(config: AppConfig, cycleId: string): CycleDoc {
  if (!parseCycleId(cycleId)) throw new Error(`Invalid cycle id: ${cycleId || '(empty)'}`);
  const doc = readCycle(config, cycleId);
  if (!doc) throw new Error(`Cycle not found: ${cycleId}`);
  return doc;
}

const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

function clampMinutes(value: unknown): number | null {
  const minutes = Math.round(Number(value));
  if (!Number.isFinite(minutes) || minutes <= 0) return null;
  return Math.min(SCHEDULE_MAX_MINUTES, Math.max(SCHEDULE_MIN_MINUTES, Math.round(minutes / 15) * 15));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Lay the cycle out from today to its last day with the model, keep whatever
 * was scheduled before today as it was, and save. Throws when the cycle has
 * no 要务 or the model's reply is not a schedule.
 */
export async function generateCycleSchedule(
  config: AppConfig,
  cycleId: string,
  options: {
    today: string;
    nowClock?: string;
    now?: string;
    run?: (input: Parameters<typeof runAgent>[0]) => Promise<string>;
    /** The calendar over the cycle; fetched from Feishu when not given. */
    events?: AgendaEvent[];
  },
): Promise<{ schedule: CycleSchedule; dropped: number }> {
  const doc = readCycleOrThrow(config, cycleId);
  const items = cycleScheduleItems(doc);
  if (items.length === 0) throw new Error(`周期 ${doc.cycle || cycleId} 还没有要务，没有可以排的东西。`);
  const allDays = cycleDays(doc);
  if (allDays.length === 0) throw new Error(`周期 ${doc.cycle || cycleId} 的标签读不出起止日期。`);
  const existing = readSchedule(config, cycleId);
  const events = options.events ?? (await fetchAgenda(config, options.today, allDays.at(-1)!));
  const input = buildScheduleEvidence(config, doc, options.today, existing, options.nowClock, events);
  if (input.days.length === 0) throw new Error(`周期 ${doc.cycle || cycleId} 已经过完了。`);

  const text = await (options.run ?? runAgent)({
    config,
    workflow: 'cycle_schedule',
    date: options.today,
    evidence: {
      generated_at: options.now ?? new Date().toISOString(),
      date: options.today,
      sources: { cycle_schedule_input: { state: 'available', data: input } },
    },
    // The schedule plans from the cycle alone; yesterday's plans and memory
    // are exactly the context the daily plan kept borrowing details from.
    memory: { repositoryPath: '', repository: [], longTerm: '', recentDaily: [] },
    runId: `cycle_schedule-${cycleId}`,
  });
  const raw = parseScheduleOutput(text);
  if (!isRecord(raw)) throw new Error('排期没有生成成功：模型没有返回可以读的 JSON。再试一次。');

  const generatedAt = options.now ?? new Date().toISOString();
  const fresh = normalizeSchedule(raw, { cycleId, items, days: input.days.map((day) => day.date), generatedAt });
  const past = (existing?.sessions ?? []).filter((session) => session.date < options.today);
  const schedule: CycleSchedule = {
    ...fresh.schedule,
    sessions: [...past, ...fresh.schedule.sessions],
    // The 固定日程 the user already settled stay unless the model gave new ones.
    ...(!fresh.schedule.fixed && existing?.fixed ? { fixed: existing.fixed } : {}),
  };
  return { schedule: writeSchedule(config, schedule), dropped: fresh.dropped };
}
