import type { AppConfig } from '../config/schema.js';

export function todayInTimezone(config: AppConfig): string {
  return todayInZone(config.user.timezone);
}

/** Today's calendar date in an arbitrary IANA zone. */
export function todayInZone(timeZone: string): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

/**
 * True when `timeZone` names a zone this runtime knows.
 *
 * Checked rather than trusted because the one caller takes it off the wire: a
 * client reports which zone its clock is in, and an identifier this Node does
 * not recognise would otherwise throw out of `Intl.DateTimeFormat` and fail a
 * read that has a perfectly good fallback.
 */
export function isKnownTimeZone(timeZone: string): boolean {
  if (!timeZone.trim()) return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone });
    return true;
  } catch {
    return false;
  }
}

/**
 * The calendar day an instant falls on, in the user's timezone.
 *
 * Timestamps are stored as UTC ISO strings, but every day boundary in the
 * product is the user's — `todayInTimezone` included. Slicing the first ten
 * characters off an ISO string compares a UTC day against a local one, which is
 * wrong for a fixed stretch of every evening: something captured at 20:00 in
 * Toronto is already tomorrow in UTC, so it would read as captured "today" for
 * one more day than it was.
 */
export function dayInTimezone(instant: string, config: AppConfig): string {
  const parsed = Date.parse(instant);
  if (Number.isNaN(parsed)) return '';
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.user.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date(parsed));
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Three-letter weekday codes, indexed so `WEEKDAY_CODES[getUTCDay()]` works directly. */
export const WEEKDAY_CODES = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'] as const;

export type WeekdayCode = (typeof WEEKDAY_CODES)[number];

const WEEKDAY_ZH: Record<WeekdayCode, string> = {
  SUN: '星期日',
  MON: '星期一',
  TUE: '星期二',
  WED: '星期三',
  THU: '星期四',
  FRI: '星期五',
  SAT: '星期六',
};

/**
 * Weekday of a `YYYY-MM-DD` calendar date.
 *
 * Read in UTC on purpose. The date string handed around by the workflows is
 * already the user's *local* calendar date (`todayInTimezone`), so re-projecting
 * it through a timezone would shift it: parsing "2026-09-13" as local midnight in
 * America/Toronto and then formatting it back lands on the 12th. The weekday of a
 * calendar date is a property of the date itself, not of any zone.
 */
export function weekdayCode(date: string): WeekdayCode {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) throw new Error(`weekdayCode: not a YYYY-MM-DD date: ${date}`);
  return WEEKDAY_CODES[parsed.getUTCDay()] as WeekdayCode;
}

/** Chinese weekday label ("星期六") for a `YYYY-MM-DD` date. */
export function weekdayLabelZh(date: string): string {
  return WEEKDAY_ZH[weekdayCode(date)];
}

/** True when `value` is one of the three-letter weekday codes. */
export function isWeekdayCode(value: string): value is WeekdayCode {
  return (WEEKDAY_CODES as readonly string[]).includes(value);
}


export interface CalendarDay {
  date: string;
  /** 星期一 … 星期日. */
  weekday: string;
  week: '上周' | '本周' | '下周';
  /** 前天 / 昨天 / 今天 / 明天 / 后天, when it is one of those. */
  relative?: string;
}

const RELATIVE_DAYS: Record<string, string> = { '-2': '前天', '-1': '昨天', '0': '今天', '1': '明天', '2': '后天' };

/**
 * Three weeks of dates around `today` — last week, this week, next week,
 * Monday first, as Chinese counts weeks — for a model to look dates up in.
 *
 * A model asked "下周一是几号" works the weekday out itself, and gets it wrong
 * often enough to matter: on Wednesday 2026-10-21 the chat filed "下周一下午
 * 3-5 点 feedback session" under 10/27 (a Tuesday), then on Monday 10/26
 * insisted that day was a Sunday and told the user to check their clock. The
 * dates here come from `weekdayCode`, never from the model.
 */
export function calendarAround(today: string): CalendarDay[] {
  const mondayOffset = (WEEKDAY_CODES.indexOf(weekdayCode(today)) + 6) % 7;
  const monday = addDays(today, -mondayOffset);
  return Array.from({ length: 21 }, (_, index) => {
    const date = addDays(monday, index - 7);
    const diff = Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
    const relative = RELATIVE_DAYS[String(diff)];
    return {
      date,
      weekday: weekdayLabelZh(date),
      week: index < 7 ? '上周' : index < 14 ? '本周' : '下周',
      ...(relative ? { relative } : {}),
    } satisfies CalendarDay;
  });
}

/** The wall-clock time (`HH:mm`, 24h) in an IANA zone. */
export function timeInZone(timeZone: string, now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-GB', { timeZone, hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).format(now);
}
