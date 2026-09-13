import type { AppConfig } from '../config/schema.js';

export function todayInTimezone(config: AppConfig): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: config.user.timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
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

