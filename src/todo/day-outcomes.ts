import type { AppConfig } from '../config/schema.js';
import { readDayHistory } from './day-history.js';
import { isRhythmRow } from './today-plan.js';
import { readWrapups, rowNeedsCleanup } from './wrapup.js';

/**
 * What each day's To-do came to — the link from 每日清理 to the weekly review.
 *
 * The weekly review used to see daily outcomes only as raw plan and review
 * JSON inside "Recent Daily Memory", which lands past the ~20k characters
 * life-review-os reads, and the built-in weekly_review prompt never looked
 * at the todo-feedback ledger at all. So a week of 完成 / 未做 / 推到明天
 * reached neither. This is the compact, per-day count both readers get, and
 * it says which days were never cleaned up — their open rows are unknown,
 * not done.
 */

export type DayCleanState = 'clean' | 'skipped' | 'open' | 'today';

export interface DayOutcome {
  date: string;
  total: number;
  done: number;
  partial: number;
  missed: number;
  /** 推到明天 and 挪到今天. */
  deferred: number;
  open: number;
  state: DayCleanState;
  /** Up to three rows still open, for the review to name. */
  openTexts: string[];
}

export function dayOutcomes(config: AppConfig, dates: string[], today: string): DayOutcome[] {
  const wrapups = readWrapups();
  const out: DayOutcome[] = [];
  for (const date of [...dates].sort()) {
    const day = readDayHistory(config, date);
    if (!day.plan) continue;
    const rows = day.todos.filter((todo) => !isRhythmRow(todo.candidateId));
    if (rows.length === 0) continue;
    const count = (state: string): number => rows.filter((todo) => day.feedback[todo.candidateId] === state).length;
    const open = rows.filter((todo) => rowNeedsCleanup(todo.candidateId, day.feedback[todo.candidateId]));
    const state: DayCleanState =
      date >= today ? 'today' : open.length === 0 ? 'clean' : wrapups[date]?.status === 'skipped' ? 'skipped' : 'open';
    out.push({
      date,
      total: rows.length,
      done: count('complete'),
      partial: count('partial'),
      missed: count('missed'),
      deferred: count('defer'),
      open: open.length,
      state,
      openTexts: open.slice(0, 3).map((todo) => todo.text),
    });
  }
  return out;
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

/** One line per day: `- 10.21 周三｜10 条：完成 7 · 部分 1 · 未做 0 · 推走 0｜没清理 2 条：「…」`. */
export function renderDayOutcomes(rows: DayOutcome[]): string {
  return rows
    .map((row) => {
      const weekday = WEEKDAYS[new Date(`${row.date}T00:00:00Z`).getUTCDay()] ?? '';
      const head = `- ${Number(row.date.slice(5, 7))}.${Number(row.date.slice(8, 10))} ${weekday}｜${row.total} 条：完成 ${row.done} · 部分 ${row.partial} · 未做 ${row.missed} · 推走 ${row.deferred}`;
      const named = row.openTexts.map((text) => `「${text}」`).join('');
      const tail =
        row.state === 'clean'
          ? '｜已清理'
          : row.state === 'today'
            ? `｜今天，还有 ${row.open} 条没标`
            : row.state === 'skipped'
              ? `｜没清理就放下了，${row.open} 条不知结果：${named}`
              : `｜没清理 ${row.open} 条：${named}`;
      return head + tail;
    })
    .join('\n');
}

/** The heading text both review inputs put above the lines. */
export const DAY_OUTCOMES_GUIDE =
  '每天计划里的 To-do 最后是什么结果（每晚 9 点清理、第二天补清理的结果，固定日程不算）。复盘时用它对账：完成多的日子做对了什么，未做 / 推走多的日子卡在哪；同一条被反复推走的，要么拆小，要么写「本期不做」。「没清理」的条目结果未知，不要当成做了。';
