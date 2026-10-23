import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { moveScheduledTo, weeklyItemKey } from '../cycles/schedule-writeback.js';
import { readDailyPlanOutput, rewriteDailyPlanOutput } from '../storage/memory.js';
import { addDays } from '../utils/date.js';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { parseDailyPlanTodoPlan, type DailyPlanTodo } from '../workflows/summary.js';
import { readDailyMemorySections, readDayHistory } from './day-history.js';
import { recordTodoFeedback } from './feedback.js';
import { isRhythmRow } from './today-plan.js';

/**
 * 回收 — closing out a day.
 *
 * The evening `daily_review` is the day's close: it reconciles the plan row by
 * row and decides what carries over. It runs on the user's Mac at its set
 * time, and a Mac that is asleep or off then simply never runs it — the
 * scheduler catches a missed run up only on the same day. On 2026-10-19 that
 * left a day with three unticked rows that nothing ever looked at again.
 *
 * So a day that ended without a review is *pending*, and the Mac app asks
 * about it before it shows today: 回收 (settle each unticked row — done, not
 * done, or move it to today — then run the review late) or 跳过 (leave the
 * day as it is, on purpose). Either answer is recorded here, and the day is
 * not asked about again.
 */

export const WRAPUP_PATH = 'data/runtime/day-wrapups.json';
/** Rows moved to a day whose plan does not exist yet, merged in when it is generated. */
export const MOVED_ROWS_PATH = 'data/runtime/moved-rows.json';
/** How far back a missed close is still worth asking about. */
export const WRAPUP_LOOKBACK_DAYS = 7;

export type WrapupStatus = 'done' | 'skipped';

interface WrapupRecord {
  status: WrapupStatus;
  at: string;
}

export interface PendingWrapupRow {
  candidateId: string;
  rank: number;
  text: string;
  minutes?: number;
  fixed?: boolean;
  /** complete | partial | missed | defer, as the row was left; absent = untouched. */
  state?: string;
}

export interface PendingWrapup {
  date: string;
  todos: PendingWrapupRow[];
}

function readJson<T>(file: string, fallback: T): T {
  try {
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function readWrapups(): Record<string, WrapupRecord> {
  return readJson<Record<string, WrapupRecord>>(path.resolve(WRAPUP_PATH), {});
}

export function recordWrapup(date: string, status: WrapupStatus): void {
  const all = readWrapups();
  all[date] = { status, at: new Date().toISOString() };
  writeFileAtomic(path.resolve(WRAPUP_PATH), `${JSON.stringify(all, null, 2)}\n`);
}

/** Whether the day's close ran: its daily review, or the weekly review that replaces it on that weekday. */
export function dayWasReviewed(config: AppConfig, date: string): boolean {
  return readDailyMemorySections(config, date).some((section) => section.workflow === 'daily_review' || section.workflow === 'weekly_review');
}

/**
 * The days before `today`, oldest first, that had a plan with rows, were never
 * reviewed, and the user has not yet closed or skipped. A day with no plan has
 * nothing to bring in, so it is not asked about.
 */
export function pendingWrapups(config: AppConfig, today: string, lookback = WRAPUP_LOOKBACK_DAYS): PendingWrapup[] {
  const resolved = readWrapups();
  const out: PendingWrapup[] = [];
  for (let offset = lookback; offset >= 1; offset -= 1) {
    const date = addDays(today, -offset);
    if (resolved[date]) continue;
    const sections = readDailyMemorySections(config, date);
    if (!sections.some((section) => section.workflow === 'daily_plan')) continue;
    if (dayWasReviewed(config, date)) continue;
    const day = readDayHistory(config, date);
    if (day.todos.length === 0) continue;
    out.push({
      date,
      todos: day.todos.map((todo, index) => ({
        candidateId: todo.candidateId,
        rank: index + 1,
        text: todo.text,
        ...(todo.minutes ? { minutes: todo.minutes } : {}),
        ...((todo as DailyPlanTodo & { fixed?: boolean }).fixed ? { fixed: true } : {}),
        ...(day.feedback[todo.candidateId] && day.feedback[todo.candidateId] !== 'update' ? { state: day.feedback[todo.candidateId] } : {}),
      })),
    });
  }
  return out;
}

type MovedRow = { candidateId: string; text: string; minutes?: number };

/** Append a row to a day's plan. `null` when that day has no plan yet. */
function appendToPlan(config: AppConfig, date: string, row: MovedRow): 'appended' | 'already' | null {
  const output = readDailyPlanOutput(config, date);
  if (!output) return null;
  const plan = parseDailyPlanTodoPlan(output.content, { allowEmpty: true });
  if (!plan) return null;
  if (plan.todos.some((todo) => todo.candidateId === row.candidateId)) return 'already';
  const todos = [...plan.todos, { rank: plan.todos.length + 1, text: row.text, candidateId: row.candidateId, ...(row.minutes ? { minutes: row.minutes } : {}) }];
  rewriteDailyPlanOutput(config, date, JSON.stringify({ todos, ...(plan.note ? { note: plan.note } : {}) }));
  return 'appended';
}

function readMovedRows(): Record<string, MovedRow[]> {
  return readJson<Record<string, MovedRow[]>>(path.resolve(MOVED_ROWS_PATH), {});
}

function writeMovedRows(all: Record<string, MovedRow[]>): void {
  writeFileAtomic(path.resolve(MOVED_ROWS_PATH), `${JSON.stringify(all, null, 2)}\n`);
}

/**
 * 挪到今天: a row left unfinished on `from` goes onto `to`'s sheet.
 *
 * On `from` it is recorded as carried (`defer`, with a note saying where to),
 * so that day reads as handled. A 要务's session moves in the cycle schedule
 * too. If `to` has no plan yet — the app opened before the morning run — the
 * row waits in `moved-rows.json` and `mergeMovedRowsIntoPlan` adds it when the
 * plan is generated, instead of hoping the scorer proposes it again.
 *
 * 固定日程 rows are not moved: today has its own.
 */
export function moveRowToDay(
  config: AppConfig,
  from: string,
  to: string,
  candidateId: string,
  rank: number,
): { ok: true; placed: 'appended' | 'already' | 'pending'; text: string; schedule?: string } | { ok: false; error: string } {
  if (isRhythmRow(candidateId)) return { ok: false, error: '固定日程每天都有，不用挪；今天的那一格照常在。' };
  const row = readDayHistory(config, from).todos.find((todo) => todo.candidateId === candidateId);
  if (!row) return { ok: false, error: '那天的计划里没有这一条。' };
  const moved: MovedRow = { candidateId, text: row.text, ...(row.minutes ? { minutes: row.minutes } : {}) };
  const short = `${Number(to.slice(5, 7))}.${Number(to.slice(8, 10))}`;
  recordTodoFeedback(config, { date: from, event: 'defer', candidateId, rank, source: 'wrapup', note: `挪到了 ${short}` });
  const itemKey = weeklyItemKey(candidateId);
  let schedule: string | null = null;
  if (itemKey) {
    try {
      schedule = moveScheduledTo(config, from, to, itemKey);
    } catch (error) {
      console.warn(`[wrapup] schedule not moved: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  let placed = appendToPlan(config, to, moved) ?? ('pending' as const);
  if (placed === 'pending') {
    const all = readMovedRows();
    const list = (all[to] ?? []).filter((entry) => entry.candidateId !== candidateId);
    all[to] = [...list, moved];
    writeMovedRows(all);
  }
  const text = placed === 'pending' ? `挪到 ${short} 了，计划生成时会带上它` : placed === 'already' ? `${short} 的计划里已经有它` : `挪到 ${short} 的计划里了`;
  return { ok: true, placed, text, ...(schedule ? { schedule } : {}) };
}

/** Rows moved to `date` before its plan existed, added to the plan just generated. */
export function mergeMovedRowsIntoPlan(planText: string, date: string): string {
  const all = readMovedRows();
  const waiting = all[date];
  if (!waiting || waiting.length === 0) return planText;
  const plan = parseDailyPlanTodoPlan(planText, { allowEmpty: true });
  if (!plan) return planText;
  const present = new Set(plan.todos.map((todo) => todo.candidateId));
  const missing = waiting.filter((row) => !present.has(row.candidateId));
  delete all[date];
  writeMovedRows(all);
  if (missing.length === 0) return planText;
  const todos = [
    ...plan.todos,
    ...missing.map((row, index) => ({ rank: plan.todos.length + index + 1, text: row.text, candidateId: row.candidateId, ...(row.minutes ? { minutes: row.minutes } : {}) })),
  ];
  return JSON.stringify({ todos, ...(plan.note ? { note: plan.note } : {}) });
}
