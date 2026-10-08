/**
 * 作息 — the frame a period of the user's life runs on.
 *
 * The rhythm settings say when the work day starts and when lunch is. That was
 * not enough to hold a day still: the user's real days have shapes ("06:30
 * up, English at 07:00, the 11:00 meeting decides whether the afternoon is
 * portfolio or Cutto, portfolio gets at least 1.5h"), and those shapes change
 * with the period — a residency in Tokyo is not a normal month at home — while
 * the frame itself does not.
 *
 * So: a **period** (from–to, wake, sleep, rules) has **day types** (workday,
 * weekend…), each with one or more **modes** (作品集日 / Cutto 日), each a list
 * of **blocks**. A block is either `fixed` (meals, meetings, getting up — time
 * nothing else can use) or a `slot` (a stretch of time kept for one category,
 * which the day's to-dos of that category go into). A slot can be a `floor`:
 * the least that category gets even on a busy day.
 *
 * Stored in the vault as `00_System/routines.json`, beside the user's other
 * system notes, so it travels with them.
 */
import fs from 'node:fs';
import path from 'node:path';

import type { AppConfig } from '../config/schema.js';
import { isWeekdayCode, weekdayCode, type WeekdayCode } from '../utils/date.js';
import { resolveMemoryRepositoryPath } from '../storage/memory.js';

export interface RoutineBlock {
  id: string;
  start: string;
  end: string;
  title: string;
  note?: string;
  /** A `RoutineCategory.key`. */
  category?: string;
  kind: 'fixed' | 'slot';
  /** The least this slot's category gets, even on a busy day. */
  floor?: boolean;
}

export interface RoutineMode {
  id: string;
  label: string;
  blocks: RoutineBlock[];
}

export interface RoutineDayType {
  id: string;
  label: string;
  weekdays: WeekdayCode[];
  /** The mode a day starts in until the user picks another. */
  defaultMode: string;
  modes: RoutineMode[];
}

export interface RoutineCategory {
  key: string;
  label: string;
  /** One of `PLAN_ROW_COLORS`. */
  color: string;
}

export interface RoutinePeriod {
  id: string;
  name: string;
  subtitle?: string;
  /** `YYYY-MM-DD`, inclusive. */
  from: string;
  to: string;
  wake?: string;
  sleep?: string;
  summary?: string;
  categories: RoutineCategory[];
  dayTypes: RoutineDayType[];
  rules: string[];
}

export interface RoutineFile {
  periods: RoutinePeriod[];
  /** The mode picked for a date, when it is not the day type's default. */
  dayModes: Record<string, string>;
}

/** What the routine says about one date. */
export interface ResolvedRoutineDay {
  date: string;
  period: { id: string; name: string; wake?: string; sleep?: string; rules: string[] };
  dayType: { id: string; label: string };
  mode: { id: string; label: string };
  /** Every mode this day could be in, to switch between. */
  modes: Array<{ id: string; label: string }>;
  blocks: Array<RoutineBlock & { categoryLabel?: string; color?: string }>;
}

export function routinesPath(config: AppConfig): string {
  return path.join(resolveMemoryRepositoryPath(config), '00_System', 'routines.json');
}

export function readRoutines(config: AppConfig): RoutineFile {
  try {
    return normalizeRoutines(JSON.parse(fs.readFileSync(routinesPath(config), 'utf8')) as unknown).routines;
  } catch {
    return { periods: [], dayModes: {} };
  }
}

export function writeRoutines(config: AppConfig, raw: unknown): { routines: RoutineFile; problems: string[] } {
  const result = normalizeRoutines(raw);
  const file = routinesPath(config);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(temp, `${JSON.stringify(result.routines, null, 2)}\n`);
  fs.renameSync(temp, file);
  return result;
}

/** Pick a mode for one date; an unknown mode for that day is refused. */
export function setDayMode(config: AppConfig, date: string, modeId: string): ResolvedRoutineDay {
  const routines = readRoutines(config);
  const day = resolveRoutine(routines, date);
  if (!day) throw new Error(`${date} 不在任何作息时期里。`);
  if (!day.modes.some((mode) => mode.id === modeId)) throw new Error(`这一天没有「${modeId}」这个模式。`);
  const dayModes = { ...routines.dayModes, [date]: modeId };
  writeRoutines(config, { ...routines, dayModes });
  return resolveRoutine({ ...routines, dayModes }, date)!;
}

export function routineForDate(config: AppConfig, date: string): ResolvedRoutineDay | null {
  return resolveRoutine(readRoutines(config), date);
}

/**
 * The period covering `date` (the latest-starting one when two overlap), the
 * day type for its weekday, and the mode picked for the date or the default.
 */
export function resolveRoutine(routines: RoutineFile, date: string): ResolvedRoutineDay | null {
  const period = routines.periods
    .filter((candidate) => candidate.from <= date && date <= candidate.to)
    .sort((left, right) => right.from.localeCompare(left.from))[0];
  if (!period) return null;
  const weekday = weekdayCode(date);
  const dayType = period.dayTypes.find((type) => type.weekdays.includes(weekday));
  if (!dayType || dayType.modes.length === 0) return null;
  const picked = routines.dayModes[date];
  const mode = dayType.modes.find((candidate) => candidate.id === picked)
    ?? dayType.modes.find((candidate) => candidate.id === dayType.defaultMode)
    ?? dayType.modes[0]!;
  const categories = new Map(period.categories.map((category) => [category.key, category]));
  return {
    date,
    period: { id: period.id, name: period.name, ...(period.wake ? { wake: period.wake } : {}), ...(period.sleep ? { sleep: period.sleep } : {}), rules: period.rules },
    dayType: { id: dayType.id, label: dayType.label },
    mode: { id: mode.id, label: mode.label },
    modes: dayType.modes.map((candidate) => ({ id: candidate.id, label: candidate.label })),
    blocks: mode.blocks.map((block) => {
      const category = block.category ? categories.get(block.category) : undefined;
      return { ...block, ...(category ? { categoryLabel: category.label, color: category.color } : {}) };
    }),
  };
}

/**
 * Make anything into a routine file that only says things that can be true.
 * Invalid pieces are dropped and reported, never repaired into something the
 * user did not write.
 */
export function normalizeRoutines(raw: unknown): { routines: RoutineFile; problems: string[] } {
  const problems: string[] = [];
  const record = isRecord(raw) ? raw : {};
  const periods: RoutinePeriod[] = [];
  const periodIds = new Set<string>();
  for (const entry of Array.isArray(record.periods) ? record.periods : []) {
    if (!isRecord(entry)) continue;
    const name = text(entry.name);
    const from = text(entry.from);
    const to = text(entry.to);
    if (!name || !DATE.test(from) || !DATE.test(to) || from > to) {
      problems.push(`时期「${name || '（无名）'}」的名字或起止日期不对，没有保存。`);
      continue;
    }
    const id = uniqueId(slug(entry.id) || `p-${from}`, periodIds);
    const categories: RoutineCategory[] = [];
    for (const category of Array.isArray(entry.categories) ? entry.categories : []) {
      if (!isRecord(category)) continue;
      const key = slug(category.key);
      const label = text(category.label);
      if (!key || !label || categories.some((existing) => existing.key === key)) continue;
      const color = (PLAN_ROW_COLORS as readonly string[]).includes(text(category.color)) ? text(category.color) : 'gray';
      categories.push({ key, label, color });
    }
    const dayTypes: RoutineDayType[] = [];
    const dayTypeIds = new Set<string>();
    for (const type of Array.isArray(entry.dayTypes) ? entry.dayTypes : []) {
      if (!isRecord(type)) continue;
      const label = text(type.label);
      const weekdays = (Array.isArray(type.weekdays) ? type.weekdays : []).map(text).filter(isWeekdayCode);
      if (!label || weekdays.length === 0) {
        problems.push(`「${name}」里有一个日型没有名字或没有选星期几，没有保存。`);
        continue;
      }
      const modes: RoutineMode[] = [];
      const modeIds = new Set<string>();
      for (const mode of Array.isArray(type.modes) ? type.modes : []) {
        if (!isRecord(mode)) continue;
        const modeLabel = text(mode.label);
        if (!modeLabel) continue;
        const blocks: RoutineBlock[] = [];
        const blockIds = new Set<string>();
        for (const block of Array.isArray(mode.blocks) ? mode.blocks : []) {
          if (!isRecord(block)) continue;
          const start = text(block.start);
          const end = text(block.end);
          const title = text(block.title);
          if (!CLOCK.test(start) || !(CLOCK.test(end) || end === '24:00') || end <= start || !title) {
            problems.push(`「${name} · ${modeLabel}」里「${title || '（无名）'}」的时间不对，没有保存。`);
            continue;
          }
          const category = slug(block.category);
          blocks.push({
            id: uniqueId(slug(block.id) || `b-${start.replace(':', '')}`, blockIds),
            start,
            end,
            title,
            ...(text(block.note) ? { note: text(block.note) } : {}),
            ...(category && categories.some((known) => known.key === category) ? { category } : {}),
            kind: block.kind === 'slot' ? 'slot' : 'fixed',
            ...(block.floor === true && block.kind === 'slot' ? { floor: true } : {}),
          });
        }
        blocks.sort((left, right) => left.start.localeCompare(right.start));
        modes.push({ id: uniqueId(slug(mode.id) || 'mode', modeIds), label: modeLabel, blocks });
      }
      if (modes.length === 0) modes.push({ id: 'default', label: label, blocks: [] });
      const defaultMode = modes.some((mode) => mode.id === text(type.defaultMode)) ? text(type.defaultMode) : modes[0]!.id;
      dayTypes.push({ id: uniqueId(slug(type.id) || 'day', dayTypeIds), label, weekdays: [...new Set(weekdays)], defaultMode, modes });
    }
    periods.push({
      id,
      name,
      ...(text(entry.subtitle) ? { subtitle: text(entry.subtitle) } : {}),
      from,
      to,
      ...(CLOCK.test(text(entry.wake)) ? { wake: text(entry.wake) } : {}),
      ...(CLOCK.test(text(entry.sleep)) ? { sleep: text(entry.sleep) } : {}),
      ...(text(entry.summary) ? { summary: text(entry.summary) } : {}),
      categories,
      dayTypes,
      rules: (Array.isArray(entry.rules) ? entry.rules : []).map(text).filter(Boolean),
    });
  }
  const dayModes: Record<string, string> = {};
  if (isRecord(record.dayModes)) {
    for (const [date, mode] of Object.entries(record.dayModes)) {
      if (DATE.test(date) && slug(mode)) dayModes[date] = slug(mode);
    }
  }
  return { routines: { periods: periods.sort((left, right) => left.from.localeCompare(right.from)), dayModes }, problems };
}

/** Same names as the plan rows' colours (`PLAN_ROW_COLORS`). */
const PLAN_ROW_COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'gray'] as const;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const CLOCK = /^([01]\d|2[0-3]):[0-5]\d$/;

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

/** Ids are written by the client and kept short and plain. */
function slug(value: unknown): string {
  const raw = text(value).toLowerCase();
  return /^[a-z0-9][a-z0-9-]{0,39}$/.test(raw) ? raw : '';
}

function uniqueId(base: string, taken: Set<string>): string {
  let id = base;
  for (let n = 2; taken.has(id); n += 1) id = `${base}-${n}`;
  taken.add(id);
  return id;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
