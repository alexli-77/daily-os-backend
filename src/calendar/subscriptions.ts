import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { addDays, todayInTimezone, weekdayLabelZh } from '../utils/date.js';
import { occurrencesBetween, parseIcs, type IcsOccurrence } from './ics.js';

/**
 * Calendars subscribed by iCal address (`sources.ics_calendars`), as the day's
 * fixed blocks.
 *
 * 2026-10-26: the AG1 program lives in a Google calendar Daily OS could not
 * read, so its events reached the plan only through the chat — retold by the
 * user, converted to dates by the model, a day off (下周一 → 10/27) — and were
 * then written in a shape nothing read. Now the calendar itself is the source:
 * each event is a fixed block on its day (`routineForDate`), so the morning plan
 * works around it, the 日 view draws it and the 双周排期 sees it; the chat and
 * the weekly review are given the list (`upcomingCalendarLines`).
 *
 * The feed is fetched in the background (`refreshCalendarSubscriptions`) and
 * kept on disk, so reading a day never waits on the network and a day offline
 * still has yesterday's copy. Nothing is written back to the calendar.
 */

export const CALENDAR_CACHE_DIR = 'data/runtime/calendar-cache';
/** What an all-day event (a retreat, a demo day) occupies on the day's clock. */
export const ALL_DAY_START = '09:00';
export const ALL_DAY_END = '18:00';

type Subscription = AppConfig['sources']['ics_calendars'][number];

interface CacheMeta {
  url: string;
  fetchedAt: string;
  /** Last attempt's error, '' when it succeeded. */
  error: string;
  attemptedAt: string;
}

export interface CalendarEvent extends IcsOccurrence {
  /** The subscription's name. */
  calendar: string;
  /** The 作息 category its rows carry. */
  category: string;
  /** The title with the subscription's label in front ("AG1 Feedback Session"). */
  shownTitle: string;
}

function subscriptions(config: AppConfig): Subscription[] {
  return (config.sources?.ics_calendars ?? []).filter((subscription) => subscription.enabled);
}

function cacheKey(url: string): string {
  return crypto.createHash('sha256').update(url).digest('hex').slice(0, 16);
}

function cacheFiles(url: string): { ics: string; meta: string } {
  const base = path.resolve(CALENDAR_CACHE_DIR, cacheKey(url));
  return { ics: `${base}.ics`, meta: `${base}.json` };
}

function readMeta(url: string): CacheMeta | null {
  try {
    return JSON.parse(fs.readFileSync(cacheFiles(url).meta, 'utf8')) as CacheMeta;
  } catch {
    return null;
  }
}

/**
 * Fetch every subscription whose copy is older than its `refresh_minutes`
 * (all of them with `force`). Never throws; a failed fetch keeps the last good
 * copy and records why. Returns how many feeds were updated.
 */
export async function refreshCalendarSubscriptions(
  config: AppConfig,
  options: { force?: boolean; fetchImpl?: typeof fetch; now?: number } = {},
): Promise<{ updated: number; errors: string[] }> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const now = options.now ?? Date.now();
  let updated = 0;
  const errors: string[] = [];
  for (const subscription of subscriptions(config)) {
    const meta = readMeta(subscription.url);
    const last = Date.parse(meta?.attemptedAt ?? '') || 0;
    if (!options.force && now - last < subscription.refresh_minutes * 60_000) continue;
    const files = cacheFiles(subscription.url);
    const attemptedAt = new Date(now).toISOString();
    try {
      const response = await fetchImpl(subscription.url, { signal: AbortSignal.timeout(20_000) });
      const text = await response.text();
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      if (!text.includes('BEGIN:VCALENDAR')) throw new Error('不是 iCal 内容（地址可能需要登录，换成「公开地址」或「私密地址」）');
      fs.mkdirSync(path.dirname(files.ics), { recursive: true });
      writeFileAtomic(files.ics, text);
      writeFileAtomic(files.meta, `${JSON.stringify({ url: subscription.url, fetchedAt: attemptedAt, error: '', attemptedAt } satisfies CacheMeta, null, 2)}\n`);
      updated += 1;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${subscription.name}: ${message}`);
      fs.mkdirSync(path.dirname(files.meta), { recursive: true });
      writeFileAtomic(files.meta, `${JSON.stringify({ url: subscription.url, fetchedAt: meta?.fetchedAt ?? '', error: message, attemptedAt } satisfies CacheMeta, null, 2)}\n`);
    }
  }
  return { updated, errors };
}

/** Parsed feeds, kept while their file is unchanged — a day is read many times per request. */
const parsedCache = new Map<string, { mtimeMs: number; events: ReturnType<typeof parseIcs> }>();

function readFeed(url: string): ReturnType<typeof parseIcs> {
  const file = cacheFiles(url).ics;
  let mtimeMs: number;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    return [];
  }
  const cached = parsedCache.get(file);
  if (cached && cached.mtimeMs === mtimeMs) return cached.events;
  let events: ReturnType<typeof parseIcs> = [];
  try {
    events = parseIcs(fs.readFileSync(file, 'utf8'));
  } catch {
    events = [];
  }
  parsedCache.set(file, { mtimeMs, events });
  return events;
}

function shownTitle(subscription: Subscription, title: string): string {
  const label = subscription.label.trim();
  if (!label || title.toLowerCase().startsWith(label.toLowerCase())) return title;
  return `${label} ${title}`;
}

function excluded(subscription: Subscription, title: string): boolean {
  const lower = title.toLowerCase();
  return subscription.exclude.some((word) => word.trim() && lower.includes(word.trim().toLowerCase()));
}

/** Events from every subscription on `from`…`to`, in the user's timezone, minus the excluded ones. Never throws. */
export function calendarEvents(config: AppConfig, from: string, to: string): CalendarEvent[] {
  const out: CalendarEvent[] = [];
  for (const subscription of subscriptions(config)) {
    try {
      for (const occurrence of occurrencesBetween(readFeed(subscription.url), from, to, config.user.timezone)) {
        if (excluded(subscription, occurrence.title)) continue;
        out.push({ ...occurrence, calendar: subscription.name, category: subscription.category.trim() || CALENDAR_CATEGORY, shownTitle: shownTitle(subscription, occurrence.title) });
      }
    } catch (error) {
      console.warn(`[calendar] ${subscription.name} not read: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return out.sort((left, right) => `${left.date} ${left.start ?? ''}`.localeCompare(`${right.date} ${right.start ?? ''}`));
}

/** The built-in category of calendar rows, when the subscription names none of the 作息's. */
export const CALENDAR_CATEGORY = 'calendar';

export interface CalendarBlock {
  id: string;
  start: string;
  end: string;
  title: string;
  kind: 'slot';
  category: string;
}

/**
 * The day's events as 固定日程 of its 作息 — slots, so each is a row on the
 * day's sheet (`fixedScheduleFor` → `fixedRows`) that is ticked when done,
 * dragged or stretched when the day moves, deleted when it does not happen,
 * like any to-do. (They were fixed bands at first, 2026-10-26, and the user
 * pointed out a meeting is a to-do you cannot then touch.) The id is stable
 * for an occurrence (series + its planned start), so a tick, a move or a hide
 * keeps applying after the feed is fetched again.
 */
export function calendarBlocksFor(config: AppConfig, date: string): CalendarBlock[] {
  if (subscriptions(config).length === 0) return [];
  return calendarEvents(config, date, date).map((event) => ({
    id: `cal-${crypto.createHash('sha256').update(`${event.uid}|${event.originalStart}`).digest('hex').slice(0, 10)}`,
    start: event.allDay ? ALL_DAY_START : event.start!,
    end: event.allDay ? ALL_DAY_END : event.end!,
    title: event.allDay ? `${event.shownTitle}（全天）` : event.shownTitle,
    kind: 'slot' as const,
    category: event.category,
  })).filter((block) => block.end > block.start);
}

/**
 * The next `days` days of events, one line each with date and weekday — what
 * the chat and the weekly review are given. Also says how fresh the copy is,
 * so "the calendar has nothing" is not mistaken for "the calendar was not read".
 */
export function upcomingCalendarLines(config: AppConfig, days = 14, back = 0): { lines: string[]; status: string[] } {
  const today = todayInTimezone(config);
  const lines = calendarEvents(config, addDays(today, -back), addDays(today, days - 1)).map((event) => {
    const when = event.allDay ? '全天' : `${event.start}-${event.end}`;
    return `${event.date.slice(5).replace('-', '/')} ${weekdayLabelZh(event.date)} ${when} ${event.shownTitle}`;
  });
  const status = subscriptions(config).map((subscription) => {
    const meta = readMeta(subscription.url);
    if (!meta?.fetchedAt) return `${subscription.name}：还没拉到${meta?.error ? `（${meta.error}）` : ''}`;
    return `${subscription.name}：${meta.fetchedAt} 拉取${meta.error ? `，最近一次失败：${meta.error}` : ''}${subscription.exclude.length ? `；不含 ${subscription.exclude.join('、')}` : ''}`;
  });
  return { lines, status };
}
