/**
 * A reader for iCalendar (.ics) feeds — enough of RFC 5545 for what Google
 * Calendar publishes, with no dependency.
 *
 * What it handles, because Google's feeds use all of it: folded lines, escaped
 * text, times in UTC (`…Z`), in a named zone (`TZID=Asia/Tokyo`) or floating,
 * all-day dates (`VALUE=DATE`, end exclusive), and recurrence — `RRULE` with
 * DAILY / WEEKLY (BYDAY, INTERVAL) / MONTHLY (BYMONTHDAY) and UNTIL / COUNT,
 * `EXDATE`, and `RECURRENCE-ID` instances that move or cancel one occurrence.
 * A rule it does not understand yields the first occurrence only, rather than
 * a guess.
 *
 * Output is in the reader's timezone: a Tokyo event read in Tokyo stays at
 * its wall time, the same event read in Toronto lands where it lands there.
 */

export interface IcsEvent {
  uid: string;
  summary: string;
  status: string;
  allDay: boolean;
  /** UTC milliseconds of the start; for an all-day event, midnight UTC of its date. */
  start: number;
  end: number;
  /** The zone the start was written in, for expanding recurrence on wall time. */
  tzid?: string;
  rrule?: Record<string, string>;
  exdates: number[];
  /** For an instance that replaces one occurrence: that occurrence's original start. */
  recurrenceId?: number;
}

export interface IcsOccurrence {
  uid: string;
  title: string;
  /** `YYYY-MM-DD` in the reader's zone. */
  date: string;
  /** `HH:mm`; absent for an all-day event. */
  start?: string;
  /** `HH:mm`, `24:00` when it runs to midnight or past it. */
  end?: string;
  allDay: boolean;
  /** UTC ms of the occurrence as the series planned it — stable across edits to one instance. */
  originalStart: number;
}

const DAY_MS = 86_400_000;
const WEEKDAYS = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
/** Never walk a rule further than this many steps, whatever it says. */
const MAX_STEPS = 5_000;

export function parseIcs(text: string): IcsEvent[] {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const unfolded: string[] = [];
  for (const line of lines) {
    if ((line.startsWith(' ') || line.startsWith('\t')) && unfolded.length > 0) unfolded[unfolded.length - 1] += line.slice(1);
    else unfolded.push(line);
  }
  const events: IcsEvent[] = [];
  let current: Map<string, Array<{ params: Record<string, string>; value: string }>> | null = null;
  for (const line of unfolded) {
    if (line === 'BEGIN:VEVENT') {
      current = new Map();
      continue;
    }
    if (line === 'END:VEVENT') {
      const event = current ? toEvent(current) : null;
      if (event) events.push(event);
      current = null;
      continue;
    }
    if (!current) continue;
    const parsed = parseLine(line);
    if (!parsed) continue;
    const list = current.get(parsed.name) ?? [];
    list.push({ params: parsed.params, value: parsed.value });
    current.set(parsed.name, list);
  }
  return events;
}

function parseLine(line: string): { name: string; params: Record<string, string>; value: string } | null {
  const colon = findValueColon(line);
  if (colon < 0) return null;
  const head = line.slice(0, colon);
  const value = line.slice(colon + 1);
  const [name, ...rest] = head.split(';');
  const params: Record<string, string> = {};
  for (const part of rest) {
    const eq = part.indexOf('=');
    if (eq > 0) params[part.slice(0, eq).toUpperCase()] = part.slice(eq + 1).replace(/^"|"$/g, '');
  }
  return { name: (name ?? '').toUpperCase(), params, value };
}

/** The colon that ends the name and parameters — not one inside a quoted parameter. */
function findValueColon(line: string): number {
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') quoted = !quoted;
    else if (char === ':' && !quoted) return index;
  }
  return -1;
}

function toEvent(props: Map<string, Array<{ params: Record<string, string>; value: string }>>): IcsEvent | null {
  const first = (name: string) => props.get(name)?.[0];
  const dtstart = first('DTSTART');
  if (!dtstart) return null;
  const start = parseDateValue(dtstart.value, dtstart.params);
  if (!start) return null;
  const dtend = first('DTEND');
  const end = dtend ? parseDateValue(dtend.value, dtend.params) : null;
  const duration = first('DURATION');
  const endMs = end?.ms ?? (duration ? start.ms + parseDuration(duration.value) : start.ms + (start.allDay ? DAY_MS : 0));
  const rruleText = first('RRULE')?.value;
  const exdates: number[] = [];
  for (const entry of props.get('EXDATE') ?? []) {
    for (const value of entry.value.split(',')) {
      const parsed = parseDateValue(value.trim(), entry.params);
      if (parsed) exdates.push(parsed.ms);
    }
  }
  const recurrence = first('RECURRENCE-ID');
  const recurrenceId = recurrence ? parseDateValue(recurrence.value, recurrence.params)?.ms : undefined;
  return {
    uid: first('UID')?.value ?? '',
    summary: unescapeText(first('SUMMARY')?.value ?? '').trim(),
    status: (first('STATUS')?.value ?? 'CONFIRMED').toUpperCase(),
    allDay: start.allDay,
    start: start.ms,
    end: endMs,
    ...(start.tzid ? { tzid: start.tzid } : {}),
    ...(rruleText ? { rrule: parseRule(rruleText) } : {}),
    exdates,
    ...(recurrenceId !== undefined ? { recurrenceId } : {}),
  };
}

function unescapeText(value: string): string {
  return value.replace(/\\n/gi, '\n').replace(/\\([,;\\])/g, '$1');
}

function parseRule(text: string): Record<string, string> {
  return Object.fromEntries(
    text.split(';').map((part) => {
      const eq = part.indexOf('=');
      return [part.slice(0, eq).toUpperCase(), part.slice(eq + 1)];
    }),
  );
}

function parseDuration(value: string): number {
  const match = value.match(/^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/);
  if (!match) return 0;
  const [, sign, weeks, days, hours, minutes, seconds] = match;
  const ms = ((Number(weeks || 0) * 7 + Number(days || 0)) * 24 * 3600 + Number(hours || 0) * 3600 + Number(minutes || 0) * 60 + Number(seconds || 0)) * 1000;
  return sign === '-' ? -ms : ms;
}

/** A DTSTART-style value → UTC ms, and how it was written. */
function parseDateValue(value: string, params: Record<string, string>): { ms: number; allDay: boolean; tzid?: string } | null {
  const date = value.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (date || params.VALUE === 'DATE') {
    const parts = value.match(/^(\d{4})(\d{2})(\d{2})/);
    if (!parts) return null;
    return { ms: Date.UTC(Number(parts[1]), Number(parts[2]) - 1, Number(parts[3])), allDay: true };
  }
  const time = value.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/);
  if (!time) return null;
  const fields = time.slice(1, 7).map(Number) as [number, number, number, number, number, number];
  if (time[7]) return { ms: Date.UTC(fields[0], fields[1] - 1, fields[2], fields[3], fields[4], fields[5]), allDay: false };
  const tzid = params.TZID;
  if (!tzid) return { ms: Date.UTC(fields[0], fields[1] - 1, fields[2], fields[3], fields[4], fields[5]), allDay: false };
  return { ms: zonedToUtc(fields, tzid), allDay: false, tzid };
}

/** Wall time in `timeZone` → UTC ms. Two passes, so a DST change between guess and answer is caught. */
export function zonedToUtc(fields: [number, number, number, number, number, number], timeZone: string): number {
  const asUtc = Date.UTC(fields[0], fields[1] - 1, fields[2], fields[3], fields[4], fields[5]);
  let guess = asUtc - offsetMs(asUtc, timeZone);
  guess = asUtc - offsetMs(guess, timeZone);
  return guess;
}

/** How far `timeZone`'s wall clock is ahead of UTC at `instant`. */
function offsetMs(instant: number, timeZone: string): number {
  const wall = wallParts(instant, timeZone);
  return Date.UTC(wall.year, wall.month - 1, wall.day, wall.hour, wall.minute, wall.second) - Math.floor(instant / 1000) * 1000;
}

function wallParts(instant: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number; second: number } {
  let parts: Record<string, string>;
  try {
    parts = Object.fromEntries(
      new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
      })
        .formatToParts(new Date(instant))
        .map((part) => [part.type, part.value]),
    );
  } catch {
    return wallParts(instant, 'UTC');
  }
  return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), second: Number(parts.second) };
}

function localDate(instant: number, timeZone: string): string {
  const wall = wallParts(instant, timeZone);
  return `${wall.year}-${String(wall.month).padStart(2, '0')}-${String(wall.day).padStart(2, '0')}`;
}

function localClock(instant: number, timeZone: string): string {
  const wall = wallParts(instant, timeZone);
  return `${String(wall.hour).padStart(2, '0')}:${String(wall.minute).padStart(2, '0')}`;
}

/**
 * Every occurrence of every event that falls on a day from `from` to `to`
 * (inclusive, `YYYY-MM-DD` in `timeZone`), sorted by date and time. Cancelled
 * events and cancelled instances are left out.
 */
export function occurrencesBetween(events: IcsEvent[], from: string, to: string, timeZone: string): IcsOccurrence[] {
  // Instances that replace one occurrence of a series, by series uid.
  const moved = new Map<string, Map<number, IcsEvent>>();
  for (const event of events) {
    if (event.recurrenceId === undefined) continue;
    const byStart = moved.get(event.uid) ?? new Map<number, IcsEvent>();
    byStart.set(event.recurrenceId, event);
    moved.set(event.uid, byStart);
  }
  // A window a day wider on both sides, so zone conversion cannot drop an edge.
  const windowStart = Date.parse(`${from}T00:00:00Z`) - DAY_MS;
  const windowEnd = Date.parse(`${to}T00:00:00Z`) + 2 * DAY_MS;

  const out: IcsOccurrence[] = [];
  const push = (event: IcsEvent, start: number, end: number, originalStart: number) => {
    if (event.status === 'CANCELLED' || !event.summary) return;
    if (event.allDay) {
      // An all-day event covers every date up to its (exclusive) end: a
      // two-day retreat is on both days.
      for (let day = start; day < Math.max(end, start + DAY_MS); day += DAY_MS) {
        const date = new Date(day).toISOString().slice(0, 10);
        if (date >= from && date <= to) out.push({ uid: event.uid, title: event.summary, date, allDay: true, originalStart });
      }
      return;
    }
    const occurrence = toOccurrence(event, start, end, originalStart, timeZone);
    if (occurrence.date >= from && occurrence.date <= to) out.push(occurrence);
  };

  for (const event of events) {
    if (event.recurrenceId !== undefined) {
      // A moved instance stands on its own; its series skips the original slot below.
      push(event, event.start, event.end, event.recurrenceId);
      continue;
    }
    const length = event.end - event.start;
    const overrides = moved.get(event.uid);
    const excluded = new Set(event.exdates);
    for (const start of expand(event, windowStart, windowEnd)) {
      if (excluded.has(start) || overrides?.has(start)) continue;
      push(event, start, start + length, start);
    }
  }
  return out.sort((left, right) => `${left.date} ${left.start ?? ''}`.localeCompare(`${right.date} ${right.start ?? ''}`));
}

function toOccurrence(event: IcsEvent, start: number, end: number, originalStart: number, timeZone: string): IcsOccurrence {
  const date = localDate(start, timeZone);
  const endDate = localDate(Math.max(end, start), timeZone);
  const endClock = endDate > date ? '24:00' : localClock(end, timeZone);
  return { uid: event.uid, title: event.summary, date, start: localClock(start, timeZone), end: endClock, allDay: false, originalStart };
}

/** Start instants of a series inside the window (the first one too, if it is inside). */
function expand(event: IcsEvent, windowStart: number, windowEnd: number): number[] {
  const rule = event.rrule;
  if (!rule) return event.start < windowEnd && event.end > windowStart - DAY_MS ? [event.start] : [];
  const freq = rule.FREQ;
  const interval = Math.max(1, Number(rule.INTERVAL || 1));
  const count = rule.COUNT ? Number(rule.COUNT) : Infinity;
  const until = rule.UNTIL ? parseDateValue(rule.UNTIL, {})?.ms ?? Infinity : Infinity;
  if (freq !== 'DAILY' && freq !== 'WEEKLY' && freq !== 'MONTHLY') return event.start < windowEnd ? [event.start] : [];

  // Recurrence walks the wall clock of the zone the event was written in, so
  // "every Monday 15:00 Tokyo" stays 15:00 there across any DST elsewhere.
  const zone = event.allDay ? 'UTC' : event.tzid ?? 'UTC';
  const wall = wallParts(event.start, zone);
  const atWall = (year: number, month: number, day: number): number =>
    event.allDay ? Date.UTC(year, month - 1, day) : zonedToUtc([year, month, day, wall.hour, wall.minute, wall.second], zone);
  const byDay = (rule.BYDAY ?? '').split(',').map((code) => code.replace(/^[+-]?\d+/, '')).filter((code) => WEEKDAYS.includes(code));
  const byMonthDay = (rule.BYMONTHDAY ?? '').split(',').map(Number).filter((day) => day >= 1 && day <= 31);

  const starts: number[] = [];
  let emitted = 0;
  const consider = (instant: number): boolean => {
    if (instant < event.start) return true;
    if (instant > until || emitted >= count) return false;
    emitted += 1;
    if (instant >= windowStart && instant < windowEnd) starts.push(instant);
    return instant < windowEnd;
  };

  const base = new Date(Date.UTC(wall.year, wall.month - 1, wall.day));
  for (let step = 0; step < MAX_STEPS; step += 1) {
    if (freq === 'DAILY') {
      const day = new Date(base.getTime() + step * interval * DAY_MS);
      if (!consider(atWall(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()))) break;
    } else if (freq === 'WEEKLY') {
      // Weeks start on WKST (Monday unless said); the days of each are BYDAY, or the start's own weekday.
      const weekStartIndex = WEEKDAYS.indexOf(rule.WKST || 'MO');
      const offset = (base.getUTCDay() - weekStartIndex + 7) % 7;
      const weekStart = base.getTime() - offset * DAY_MS + step * interval * 7 * DAY_MS;
      const days = byDay.length > 0 ? byDay : [WEEKDAYS[base.getUTCDay()]!];
      const ordered = days.map((code) => (WEEKDAYS.indexOf(code) - weekStartIndex + 7) % 7).sort((left, right) => left - right);
      let keepGoing = true;
      for (const dayOffset of ordered) {
        const day = new Date(weekStart + dayOffset * DAY_MS);
        if (!consider(atWall(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate()))) {
          keepGoing = false;
          break;
        }
      }
      if (!keepGoing) break;
    } else {
      const month = new Date(Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + step * interval, 1));
      const days = byMonthDay.length > 0 ? byMonthDay : [base.getUTCDate()];
      let keepGoing = true;
      for (const dayOfMonth of [...days].sort((left, right) => left - right)) {
        const candidate = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), dayOfMonth));
        if (candidate.getUTCMonth() !== month.getUTCMonth()) continue;
        if (!consider(atWall(candidate.getUTCFullYear(), candidate.getUTCMonth() + 1, candidate.getUTCDate()))) {
          keepGoing = false;
          break;
        }
      }
      if (!keepGoing) break;
    }
  }
  return starts;
}
