import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AppConfig } from '../config/schema.js';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { todayInTimezone } from '../utils/date.js';

/**
 * 提醒卡 / 便签墙 (LEO-355).
 *
 * A sticky is a small jotting — a todo, an idea — with no deadline. Instead of
 * alerting on a date, each note resurfaces on its own schedule: spaced
 * repetition decides which notes "float up" to the top of the board on a given
 * day, so they come find you when you next open Daily OS rather than nagging.
 *
 * The scheme is a fixed Leitner ladder, not Anki grading: a note lives in one
 * of five boxes whose intervals grow `2 → 4 → 8 → 16 → 30` days. When a surfaced
 * note is acknowledged it climbs a box (sleeps longer); when you say you are
 * still thinking about it, it drops back to the shortest interval; when you are
 * done, it is archived. A note you ignore stays overdue and keeps surfacing —
 * the only, gentle, pressure in the feature.
 *
 * Private by construction, like the journal: this store is never synced to the
 * team, sent to Feishu, or read by any workflow or the chat sandbox.
 */

export type StickyColor = 'yellow' | 'pink' | 'blue' | 'green' | 'gray';

const COLORS: readonly StickyColor[] = ['yellow', 'pink', 'blue', 'green', 'gray'];

/** Leitner intervals in days; `box` indexes into this ladder. */
export const SURFACE_INTERVALS = [2, 4, 8, 16, 30] as const;

const MAX_BOX = SURFACE_INTERVALS.length - 1;

/** What the user said when a surfaced note came up. */
export type SurfaceResponse = 'done' | 'keep' | 'ok';

export interface Sticky {
  id: string;
  text: string;
  color: StickyColor;
  /** 0..4, an index into `SURFACE_INTERVALS`. */
  box: number;
  /** `YYYY-MM-DD` in the user's timezone — the day this note next floats up. */
  nextSurface: string;
  created_at: string;
  updated_at: string;
  /** Set once the note is archived; archived notes drop off the active board. */
  archived_at?: string;
}

export interface ResolvedSticky extends Sticky {
  /** True when `nextSurface` has arrived — the note floats to the top today. */
  surfacing: boolean;
}

export interface StickyInput {
  id?: string;
  text: string;
  color?: StickyColor;
}

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** True for a real `YYYY-MM-DD`. */
function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** `date` plus `n` days, kept in the calendar-date domain at UTC midnight. */
function addDays(date: string, n: number): string {
  const base = Date.parse(`${date}T00:00:00Z`);
  if (Number.isNaN(base)) return date;
  return new Date(base + n * 86_400_000).toISOString().slice(0, 10);
}

function clampBox(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(Math.max(Math.round(value), 0), MAX_BOX);
}

function normalizeColor(value: unknown): StickyColor {
  return COLORS.includes(value as StickyColor) ? (value as StickyColor) : 'yellow';
}

// MARK: - Store

function storePath(config: AppConfig): string {
  return path.resolve(config.reminders.store_path);
}

/**
 * Forgiving on purpose, like the countdown/journal parsers: a hand-mangled row
 * drops out and a file that will not parse yields an empty list, so one bad
 * note never blanks the board.
 */
function normalizeStored(value: unknown, today: string): Sticky | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  const text = typeof row.text === 'string' ? row.text.trim() : '';
  if (!id || !text) return null;
  const now = new Date().toISOString();
  const nextSurface =
    typeof row.nextSurface === 'string' && isCalendarDate(row.nextSurface) ? row.nextSurface : today;
  return {
    id,
    text,
    color: normalizeColor(row.color),
    box: clampBox(typeof row.box === 'number' ? row.box : 0),
    nextSurface,
    created_at: typeof row.created_at === 'string' ? row.created_at : now,
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : now,
    ...(typeof row.archived_at === 'string' && row.archived_at ? { archived_at: row.archived_at } : {}),
  };
}

export function readStickies(config: AppConfig, today = todayInTimezone(config)): Sticky[] {
  const file = storePath(config);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map((row) => normalizeStored(row, today)).filter((item): item is Sticky => item !== null);
  } catch (error) {
    console.warn(`[reminders] could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function writeStickies(config: AppConfig, items: Sticky[]): void {
  writeFileAtomic(storePath(config), `${JSON.stringify(items, null, 2)}\n`);
}

/** Create when `input.id` is absent or unknown, otherwise edit text/colour in place. */
export function saveSticky(config: AppConfig, input: StickyInput, today = todayInTimezone(config)): Sticky {
  const text = input.text.trim();
  if (!text) throw new Error('便签需要一点内容');

  const items = readStickies(config, today);
  const now = new Date().toISOString();
  const index = input.id ? items.findIndex((item) => item.id === input.id) : -1;
  const existing = index >= 0 ? items[index] : undefined;

  const saved: Sticky = existing
    ? {
        ...existing,
        text,
        color: input.color ? normalizeColor(input.color) : existing.color,
        updated_at: now,
      }
    : {
        id: crypto.randomUUID(),
        text,
        color: normalizeColor(input.color),
        box: 0,
        // A note you just wrote does not need to resurface today — you just saw
        // it. Its first wake-up is one interval out.
        nextSurface: addDays(today, SURFACE_INTERVALS[0]),
        created_at: now,
        updated_at: now,
      };

  if (existing) items[index] = saved;
  else items.push(saved);
  writeStickies(config, items);
  return saved;
}

/**
 * Apply a response to a surfaced note and reschedule it:
 * - `done` archives it (it stops surfacing).
 * - `keep` ("还惦记") drops it to the shortest interval so it comes back soon.
 * - `ok` ("知道了") promotes it a box so it sleeps longer.
 */
export function surfaceSticky(
  config: AppConfig,
  id: string,
  response: SurfaceResponse,
  today = todayInTimezone(config),
): Sticky | null {
  const items = readStickies(config, today);
  const index = items.findIndex((item) => item.id === id);
  if (index < 0) return null;
  const now = new Date().toISOString();
  const current = items[index];

  let next: Sticky;
  if (response === 'done') {
    next = { ...current, archived_at: now, updated_at: now };
  } else if (response === 'keep') {
    next = { ...current, box: 0, nextSurface: addDays(today, SURFACE_INTERVALS[0]), updated_at: now };
  } else {
    const box = clampBox(current.box + 1);
    next = { ...current, box, nextSurface: addDays(today, SURFACE_INTERVALS[box]), updated_at: now };
  }

  items[index] = next;
  writeStickies(config, items);
  return next;
}

/** Archive a note by id — used by the board's delete/done control. */
export function archiveSticky(config: AppConfig, id: string, today = todayInTimezone(config)): boolean {
  const items = readStickies(config, today);
  const index = items.findIndex((item) => item.id === id);
  if (index < 0 || items[index].archived_at) return false;
  const now = new Date().toISOString();
  items[index] = { ...items[index], archived_at: now, updated_at: now };
  writeStickies(config, items);
  return true;
}

/**
 * The active board, ordered for the day: notes due to surface first (most
 * overdue at the very top), then sleeping notes by how soon they wake. Archived
 * notes are gone.
 */
export function listStickies(config: AppConfig, today = todayInTimezone(config)): ResolvedSticky[] {
  return readStickies(config, today)
    .filter((item) => !item.archived_at)
    .map((item) => ({ ...item, surfacing: item.nextSurface <= today }))
    .sort((a, b) => {
      if (a.surfacing !== b.surfacing) return a.surfacing ? -1 : 1;
      // ISO dates compare correctly as strings. Surfacing: oldest nextSurface
      // (most overdue) first. Sleeping: soonest to wake first. Both are ascending.
      if (a.nextSurface !== b.nextSurface) return a.nextSurface < b.nextSurface ? -1 : 1;
      return a.created_at < b.created_at ? -1 : 1;
    });
}

/** How many notes are floating up today — the number the Today-page hook shows. */
export function surfacingCount(items: ResolvedSticky[]): number {
  return items.filter((item) => item.surfacing).length;
}
