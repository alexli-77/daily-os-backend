import fs from 'node:fs';
import path from 'node:path';
import yaml from 'js-yaml';
import type { AppConfig } from '../config/schema.js';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { isCalendarDate } from '../countdown/store.js';

/**
 * A free-text daily journal (日记) — one Markdown file per day, kept entirely in
 * the app's own data dir.
 *
 * Deliberately the diary, not the task wrap-up (`wrapup.ts`) or the model's
 * 复盘: whatever the user felt like writing, and private. Nothing here feeds
 * team sync, the Feishu output, or the chat sandbox — the store lives under
 * `data/memory/`, which the chat workdir (the vault) cannot reach, and no
 * workflow reads it.
 *
 * Each day's weather and the time it was written are frozen into the file's
 * frontmatter the first time the day is created (LEO-351), so looking back at an
 * old page shows the weather it *was* that day, not today's.
 */
export interface JournalWeather {
  code: number;
  temp: number;
  high?: number;
  low?: number;
  isDay?: boolean;
  place: string;
}

export interface JournalMeta {
  /** ISO timestamp captured when the day's entry was first created. Frozen. */
  writtenAt?: string;
  /** The weather at that moment, frozen so a past day shows its own. */
  weather?: JournalWeather;
}

export interface JournalEntry extends JournalMeta {
  date: string;
  /** The body, with the frontmatter stripped off. */
  content: string;
  updated_at: string;
}

export interface JournalSummary {
  date: string;
  preview: string;
  updated_at: string;
}

function storeDir(config: AppConfig): string {
  return path.resolve(config.journal.store_dir);
}

function entryPath(config: AppConfig, date: string): string {
  return path.join(storeDir(config), `${date}.md`);
}

const FRONTMATTER = /^---\n([\s\S]*?)\n---\n?/;

/** Split a file into its frozen meta and its body. Forgiving: bad or absent
 *  frontmatter just yields empty meta and the whole file as the body. */
function parse(raw: string): { body: string; meta: JournalMeta } {
  const match = raw.match(FRONTMATTER);
  if (!match) return { body: raw, meta: {} };
  const body = raw.slice(match[0].length);
  try {
    return { body, meta: normalizeMeta(yaml.load(match[1])) };
  } catch {
    return { body, meta: {} };
  }
}

function normalizeMeta(data: unknown): JournalMeta {
  if (!data || typeof data !== 'object') return {};
  const row = data as Record<string, unknown>;
  const meta: JournalMeta = {};
  if (typeof row.written_at === 'string') meta.writtenAt = row.written_at;
  const raw = row.weather;
  if (raw && typeof raw === 'object') {
    const w = raw as Record<string, unknown>;
    if (typeof w.code === 'number' && typeof w.temp === 'number' && typeof w.place === 'string') {
      meta.weather = {
        code: w.code,
        temp: w.temp,
        place: w.place,
        ...(typeof w.high === 'number' ? { high: w.high } : {}),
        ...(typeof w.low === 'number' ? { low: w.low } : {}),
        ...(typeof w.is_day === 'boolean' ? { isDay: w.is_day } : {}),
      };
    }
  }
  return meta;
}

function serialize(body: string, meta: JournalMeta): string {
  const text = body.endsWith('\n') ? body : `${body}\n`;
  if (!meta.writtenAt && !meta.weather) return text;
  const front: Record<string, unknown> = {};
  if (meta.writtenAt) front.written_at = meta.writtenAt;
  if (meta.weather) {
    front.weather = {
      code: meta.weather.code,
      temp: meta.weather.temp,
      ...(meta.weather.high !== undefined ? { high: meta.weather.high } : {}),
      ...(meta.weather.low !== undefined ? { low: meta.weather.low } : {}),
      ...(meta.weather.isDay !== undefined ? { is_day: meta.weather.isDay } : {}),
      place: meta.weather.place,
    };
  }
  return `---\n${yaml.dump(front, { lineWidth: -1 }).trimEnd()}\n---\n${text}`;
}

/** The journal for a day, or null when nothing has been written for it. */
export function readJournal(config: AppConfig, date: string): JournalEntry | null {
  if (!isCalendarDate(date)) return null;
  const file = entryPath(config, date);
  if (!fs.existsSync(file)) return null;
  try {
    const { body, meta } = parse(fs.readFileSync(file, 'utf8'));
    return { date, content: body, updated_at: fs.statSync(file).mtime.toISOString(), ...meta };
  } catch (error) {
    console.warn(`[journal] could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Save a day's journal. Empty content deletes the file instead of writing a
 * blank one. The weather + written-at are frozen on first creation: an `incoming`
 * snapshot is only taken when the day has none yet, so editing the body later
 * never rewrites the weather the day was written under.
 */
export function writeJournal(config: AppConfig, date: string, content: string, incoming: JournalMeta = {}): JournalEntry | null {
  if (!isCalendarDate(date)) throw new Error(`不是合法日期：${date}`);
  if (!content.trim()) {
    deleteJournal(config, date);
    return null;
  }
  const file = entryPath(config, date);
  const existing = fs.existsSync(file) ? parse(fs.readFileSync(file, 'utf8')).meta : {};
  const meta: JournalMeta = {
    ...(existing.writtenAt ?? incoming.writtenAt ? { writtenAt: existing.writtenAt ?? incoming.writtenAt } : {}),
    ...(existing.weather ?? incoming.weather ? { weather: existing.weather ?? incoming.weather } : {}),
  };
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, serialize(content, meta));
  return { date, content, updated_at: new Date().toISOString(), ...meta };
}

/** Remove a day's journal. Returns whether there was one to remove. */
export function deleteJournal(config: AppConfig, date: string): boolean {
  if (!isCalendarDate(date)) return false;
  const file = entryPath(config, date);
  if (!fs.existsSync(file)) return false;
  fs.rmSync(file);
  return true;
}

/** Every day that has a journal, newest first, each with a one-line preview. */
export function listJournal(config: AppConfig): JournalSummary[] {
  const dir = storeDir(config);
  if (!fs.existsSync(dir)) return [];
  const entries: JournalSummary[] = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.md')) continue;
    const date = name.slice(0, -'.md'.length);
    if (!isCalendarDate(date)) continue;
    const file = path.join(dir, name);
    try {
      const { body } = parse(fs.readFileSync(file, 'utf8'));
      entries.push({ date, preview: previewOf(body), updated_at: fs.statSync(file).mtime.toISOString() });
    } catch {
      // A file that will not read drops out rather than blanking the whole list.
    }
  }
  return entries.sort((left, right) => right.date.localeCompare(left.date));
}

/** The first non-empty line, stripped of a leading markdown heading mark, clipped. */
function previewOf(content: string): string {
  const line = content.split('\n').map((value) => value.trim()).find((value) => value.length > 0) ?? '';
  const plain = line.replace(/^#+\s*/, '');
  return plain.length > 80 ? `${plain.slice(0, 80)}…` : plain;
}
