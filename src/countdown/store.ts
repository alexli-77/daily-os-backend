import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import type { AppConfig } from '../config/schema.js';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { todayInTimezone } from '../utils/date.js';

/**
 * `until` counts down to a date that has not arrived — a deadline, a flight.
 * `since` counts up from one that has — "读博第 517 天".
 *
 * The distinction is not only cosmetic. Both directions use the same signed
 * day arithmetic, but a `since` entry is never "upcoming", so it stays out of
 * the morning card's 30-day window unless it was pinned on purpose.
 */
export type CountdownDirection = 'until' | 'since';

/** No monthly. Nothing in this product recurs monthly on a calendar date. */
export type CountdownRepeat = 'none' | 'yearly';

export interface Countdown {
  id: string;
  title: string;
  /** `YYYY-MM-DD` in the user's timezone. For `yearly`, the first occurrence. */
  date: string;
  direction: CountdownDirection;
  repeat: CountdownRepeat;
  pinned: boolean;
  note?: string;
  created_at: string;
  updated_at: string;
}

export interface ResolvedCountdown extends Countdown {
  /** The occurrence this entry currently points at. Equals `date` unless yearly. */
  occurrence: string;
  /** Calendar days from today to `occurrence`. Negative once it is past. */
  daysLeft: number;
  /** Which anniversary `occurrence` is. Only set for `yearly`. */
  ordinal?: number;
}

export interface CountdownInput {
  id?: string;
  title: string;
  date: string;
  direction?: CountdownDirection;
  repeat?: CountdownRepeat;
  pinned?: boolean;
  note?: string;
}

/** How far ahead an unpinned entry has to be before the morning card mentions it. */
const CARD_HORIZON_DAYS = 30;

/** How many lines of countdown the morning card will carry. */
const CARD_LIMIT = 3;

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

// MARK: - Date arithmetic
//
// Every date here is a calendar date in the user's timezone, and every
// comparison is between two such dates. Both sides are parsed at UTC midnight
// before subtracting, which keeps the span free of daylight-saving: an
// `America/Toronto` March that is 23 hours long would otherwise round a
// 1-day gap down to 0.

/** True for a real `YYYY-MM-DD` — "2026-02-30" parses nowhere and fails here. */
export function isCalendarDate(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Signed calendar days from `from` to `to`. Both are `YYYY-MM-DD`. */
export function diffCalendarDays(from: string, to: string): number {
  const a = Date.parse(`${from}T00:00:00Z`);
  const b = Date.parse(`${to}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.round((b - a) / 86_400_000);
}

/**
 * The given month/day inside `year`, clamped to the last day of the month.
 *
 * The clamp exists for one date: a yearly entry anchored on 29 February has no
 * occurrence in three years out of four. Clamping to the 28th is what a paper
 * calendar does; the alternative — `2027-02-29` — is not a date, and would come
 * back from `Date.parse` as NaN and poison the day count.
 */
function occurrenceInYear(year: number, month: number, day: number): string {
  const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const safeDay = Math.min(day, lastDayOfMonth);
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(safeDay).padStart(2, '0')}`;
}

/** The next yearly occurrence on or after `today`, and which anniversary it is. */
function resolveYearly(date: string, today: string): { occurrence: string; ordinal: number } {
  const anchorYear = Number(date.slice(0, 4));
  const month = Number(date.slice(5, 7));
  const day = Number(date.slice(8, 10));
  const thisYear = occurrenceInYear(Number(today.slice(0, 4)), month, day);
  // ISO dates compare correctly as strings, which is the whole reason this
  // module passes `YYYY-MM-DD` around instead of `Date`.
  const occurrence = thisYear >= today ? thisYear : occurrenceInYear(Number(today.slice(0, 4)) + 1, month, day);
  return { occurrence, ordinal: Number(occurrence.slice(0, 4)) - anchorYear };
}

/** Attach today's day count to one entry. `today` is a `YYYY-MM-DD` in the user's zone. */
export function resolveCountdown(item: Countdown, today: string): ResolvedCountdown {
  if (item.repeat === 'yearly') {
    const { occurrence, ordinal } = resolveYearly(item.date, today);
    return { ...item, occurrence, daysLeft: diffCalendarDays(today, occurrence), ordinal };
  }
  return { ...item, occurrence: item.date, daysLeft: diffCalendarDays(today, item.date) };
}

// MARK: - Store

function storePath(config: AppConfig): string {
  return path.resolve(config.countdown.store_path);
}

function normalizeStored(value: unknown): Countdown | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const id = typeof row.id === 'string' ? row.id.trim() : '';
  const title = typeof row.title === 'string' ? row.title.trim() : '';
  const date = typeof row.date === 'string' ? row.date.trim() : '';
  if (!id || !title || !isCalendarDate(date)) return null;
  const now = new Date().toISOString();
  return {
    id,
    title,
    date,
    direction: row.direction === 'since' ? 'since' : 'until',
    repeat: row.repeat === 'yearly' ? 'yearly' : 'none',
    pinned: row.pinned === true,
    ...(typeof row.note === 'string' && row.note.trim() ? { note: row.note.trim() } : {}),
    created_at: typeof row.created_at === 'string' ? row.created_at : now,
    updated_at: typeof row.updated_at === 'string' ? row.updated_at : now,
  };
}

/**
 * Every countdown on file.
 *
 * Forgiving on purpose, in the same spirit as the cycles parser: one row somebody
 * hand-edited into nonsense drops out, and a file that will not parse at all
 * yields an empty list. This feeds `/api/state`, and a screen that goes blank
 * over one bad row is worse than a screen missing that row.
 */
export function readCountdowns(config: AppConfig): Countdown[] {
  const file = storePath(config);
  if (!fs.existsSync(file)) return [];
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(normalizeStored).filter((item): item is Countdown => item !== null);
  } catch (error) {
    console.warn(`[countdown] could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return [];
  }
}

function writeCountdowns(config: AppConfig, items: Countdown[]): void {
  writeFileAtomic(storePath(config), `${JSON.stringify(items, null, 2)}\n`);
}

/** Create when `input.id` is absent or unknown, otherwise update in place. */
export function saveCountdown(config: AppConfig, input: CountdownInput): Countdown {
  const title = input.title.trim();
  const date = input.date.trim();
  if (!title) throw new Error('倒数日需要一个标题');
  if (!isCalendarDate(date)) throw new Error(`不是合法日期：${input.date}`);

  const items = readCountdowns(config);
  const now = new Date().toISOString();
  const index = input.id ? items.findIndex((item) => item.id === input.id) : -1;
  const existing = index >= 0 ? items[index] : undefined;

  const saved: Countdown = {
    id: existing?.id || crypto.randomUUID(),
    title,
    date,
    direction: input.direction ?? existing?.direction ?? 'until',
    repeat: input.repeat ?? existing?.repeat ?? 'none',
    pinned: input.pinned ?? existing?.pinned ?? false,
    ...(input.note?.trim() ? { note: input.note.trim() } : {}),
    created_at: existing?.created_at || now,
    updated_at: now,
  };

  if (existing) items[index] = saved;
  else items.push(saved);
  writeCountdowns(config, items);
  return saved;
}

/** False when no entry carried that id — the caller can say so instead of lying. */
export function deleteCountdown(config: AppConfig, id: string): boolean {
  const items = readCountdowns(config);
  const remaining = items.filter((item) => item.id !== id);
  if (remaining.length === items.length) return false;
  writeCountdowns(config, remaining);
  return true;
}

/**
 * Everything on file, resolved against today and ordered for the page: pinned
 * first, then what is still coming by how soon, then what has passed by how
 * recently.
 */
export function listCountdowns(config: AppConfig, today = todayInTimezone(config)): ResolvedCountdown[] {
  return readCountdowns(config)
    .map((item) => resolveCountdown(item, today))
    .sort((a, b) => {
      if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
      const aPast = a.daysLeft < 0 ? 1 : 0;
      const bPast = b.daysLeft < 0 ? 1 : 0;
      if (aPast !== bPast) return aPast - bPast;
      return Math.abs(a.daysLeft) - Math.abs(b.daysLeft);
    });
}

/**
 * The few entries the morning card is allowed to mention: pinned ones, plus
 * anything arriving inside the next 30 days.
 *
 * A one-off `until` that has already passed drops out — a deadline nobody
 * deleted would otherwise sit in the card forever, which is how an ambient line
 * turns into noise you stop reading. Pinning it keeps it; that is the deliberate act.
 */
export function cardCountdowns(items: ResolvedCountdown[], limit = CARD_LIMIT): ResolvedCountdown[] {
  return items
    .filter((item) => {
      if (item.direction === 'since') return item.pinned;
      if (item.daysLeft < 0) return false;
      return item.pinned || item.daysLeft <= CARD_HORIZON_DAYS;
    })
    .slice(0, limit);
}

/** "还有 23 天" / "就是今天" / "已经 517 天". */
export function countdownDaysLabel(item: ResolvedCountdown): string {
  if (item.daysLeft === 0) return '就是今天';
  if (item.daysLeft > 0) return `还有 ${item.daysLeft} 天`;
  return item.direction === 'since' ? `已经 ${-item.daysLeft} 天` : `已过去 ${-item.daysLeft} 天`;
}

/**
 * The single line the daily card carries, or `''` when there is nothing worth
 * saying. Rendered here rather than asked of the model: a day count the LLM got
 * wrong by one reads exactly like a day count it got right.
 */
export function renderCountdownCardLine(config: AppConfig, today = todayInTimezone(config)): string {
  const picked = cardCountdowns(listCountdowns(config, today));
  if (picked.length === 0) return '';
  return `⏳ ${picked.map((item) => `${item.title} ${countdownDaysLabel(item)}`).join(' · ')}`;
}
