import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { isCalendarDate } from '../countdown/store.js';

/**
 * A free-text daily journal (日记) — one Markdown file per day, kept entirely in
 * the app's own data dir.
 *
 * Deliberately the diary, not the task wrap-up (`wrapup.ts`) or the model's
 * 复盘: it is whatever the user felt like writing, and it is private. Nothing
 * here feeds team sync, the Feishu output, or the chat assistant's sandbox — the
 * store lives under `data/memory/`, which the chat workdir (the vault) cannot
 * reach, and no workflow reads it.
 */
export interface JournalEntry {
  date: string;
  content: string;
  /** ISO timestamp of the file's last write, so the client can show "edited". */
  updated_at: string;
}

/** One row of the browse list: the date and a short preview of the entry. */
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

/** The journal for a day, or null when nothing has been written for it. */
export function readJournal(config: AppConfig, date: string): JournalEntry | null {
  if (!isCalendarDate(date)) return null;
  const file = entryPath(config, date);
  if (!fs.existsSync(file)) return null;
  try {
    const content = fs.readFileSync(file, 'utf8');
    return { date, content, updated_at: fs.statSync(file).mtime.toISOString() };
  } catch (error) {
    console.warn(`[journal] could not read ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Save a day's journal. Empty content deletes the file instead of writing a
 * blank one — an entry the user cleared is not an entry, and a blank file would
 * sit in the browse list saying nothing.
 */
export function writeJournal(config: AppConfig, date: string, content: string): JournalEntry | null {
  if (!isCalendarDate(date)) throw new Error(`不是合法日期：${date}`);
  if (!content.trim()) {
    deleteJournal(config, date);
    return null;
  }
  const file = entryPath(config, date);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, content.endsWith('\n') ? content : `${content}\n`);
  return { date, content, updated_at: new Date().toISOString() };
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
      const content = fs.readFileSync(file, 'utf8');
      entries.push({ date, preview: previewOf(content), updated_at: fs.statSync(file).mtime.toISOString() });
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
