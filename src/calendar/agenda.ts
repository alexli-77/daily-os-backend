/**
 * Feishu calendar events across a date range, for the 双周排期 board.
 *
 * The daily plan reads one day of agenda as evidence; the cycle schedule needs
 * every day of the cycle — to draw the meetings beside the 要务, and so the
 * schedule is not generated straight across them (it was: a big rock on top of
 * a meeting the user had already accepted).
 *
 * Times are converted to the user's timezone: Feishu returns each event in its
 * creator's zone, and the board is drawn in the user's.
 */
import type { AppConfig } from '../config/schema.js';
import { runCommand } from '../utils/command.js';

export interface AgendaEvent {
  /** `YYYY-MM-DD` in the user's timezone. */
  date: string;
  /** `HH:mm`, absent for an all-day event. */
  start?: string;
  /** `HH:mm`; `24:00` when it runs to midnight or past it. */
  end?: string;
  title: string;
}

type Runner = (command: string, args: string[], options: { timeoutMs: number }) => Promise<{ ok: boolean; stdout: string; stderr: string }>;

const CACHE_MS = 5 * 60 * 1000;
const cache = new Map<string, { at: number; events: AgendaEvent[] }>();

/**
 * Events between `start` and `end` (inclusive) from every enabled Feishu
 * profile with its calendar on. Declined events are left out. Never throws:
 * a calendar that cannot be read yields no events, and the board says nothing
 * rather than failing.
 */
export async function fetchAgenda(
  config: AppConfig,
  start: string,
  end: string,
  options: { run?: Runner; now?: number } = {},
): Promise<AgendaEvent[]> {
  const profiles = (config.sources.feishu?.enabled ? config.sources.feishu.profiles : []).filter((profile) => profile.enabled && profile.calendar?.enabled);
  if (profiles.length === 0) return [];
  const key = `${start}|${end}|${profiles.map((profile) => profile.identity).join(',')}`;
  const now = options.now ?? Date.now();
  const cached = cache.get(key);
  if (!options.run && cached && now - cached.at < CACHE_MS) return cached.events;

  const run = options.run ?? ((command, args, runOptions) => runCommand(command, args, runOptions));
  const events: AgendaEvent[] = [];
  const seen = new Set<string>();
  for (const profile of profiles) {
    const result = await run('lark-cli', ['calendar', '+agenda', '--start', start, '--end', nextDay(end), '--format', 'json', '--as', profile.identity], { timeoutMs: 30000 }).catch(() => null);
    if (!result?.ok) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      continue;
    }
    for (const event of parseAgenda(parsed, config.user.timezone)) {
      if (event.date < start || event.date > end) continue;
      const id = `${event.date}|${event.start ?? ''}|${event.title}`;
      if (seen.has(id)) continue;
      seen.add(id);
      events.push(event);
    }
  }
  events.sort((left, right) => `${left.date}${left.start ?? ''}`.localeCompare(`${right.date}${right.start ?? ''}`));
  if (!options.run) cache.set(key, { at: now, events });
  return events;
}

/** `lark-cli calendar +agenda --format json` → events in `timeZone`. */
export function parseAgenda(parsed: unknown, timeZone: string): AgendaEvent[] {
  const list = isRecord(parsed) && Array.isArray(parsed.data) ? parsed.data : Array.isArray(parsed) ? parsed : [];
  const out: AgendaEvent[] = [];
  for (const raw of list) {
    if (!isRecord(raw)) continue;
    if (raw.self_rsvp_status === 'decline') continue;
    const title = typeof raw.summary === 'string' && raw.summary.trim() ? raw.summary.trim() : '（无标题日程）';
    const startTime = isRecord(raw.start_time) ? raw.start_time : {};
    const endTime = isRecord(raw.end_time) ? raw.end_time : {};
    if (typeof startTime.date === 'string' && !startTime.datetime) {
      out.push({ date: startTime.date, title });
      continue;
    }
    if (typeof startTime.datetime !== 'string') continue;
    const begin = localParts(startTime.datetime, timeZone);
    if (!begin) continue;
    const finish = typeof endTime.datetime === 'string' ? localParts(endTime.datetime, timeZone) : null;
    // Past midnight is drawn to the end of the day it started on.
    const end = !finish ? undefined : finish.date > begin.date ? '24:00' : finish.clock;
    out.push({ date: begin.date, start: begin.clock, ...(end ? { end } : {}), title });
  }
  return out;
}

function localParts(iso: string, timeZone: string): { date: string; clock: string } | null {
  const instant = new Date(iso);
  if (Number.isNaN(instant.getTime())) return null;
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })
      .formatToParts(instant)
      .map((part) => [part.type, part.value]),
  );
  return { date: `${parts.year}-${parts.month}-${parts.day}`, clock: `${parts.hour}:${parts.minute}` };
}

function nextDay(date: string): string {
  const day = new Date(`${date}T00:00:00Z`);
  day.setUTCDate(day.getUTCDate() + 1);
  return day.toISOString().slice(0, 10);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
