import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig, WorkflowName } from '../config/schema.js';
import { readDailyPlanOutput } from '../storage/memory.js';
import { parseDailyReviewReconciliation, type DailyReviewReconciliation, type DailyPlanTodo } from '../workflows/summary.js';
import { buildPlanSnapshotForDate } from './today-plan.js';

/**
 * A past day's plan, as the Today page would have shown it at the end of that
 * day, plus what the evening review made of it.
 *
 * Nothing in the product could show a previous day: `/api/today/plan` is today
 * or nothing by design (LEO-309), and the only way to see yesterday was to open
 * `data/memory/daily/<date>.md` and read raw JSON. This is the read-only way in.
 *
 * Two stores, in order:
 *   - `readDailyPlanOutput` (latest-workflow file, then the per-run detail
 *     cache). Has `generated_at`, but the cache is pruned to about a week.
 *   - the daily memory file. Every workflow output for the day is appended to
 *     it and it is never pruned — it goes back to the first day of use.
 */

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const WORKFLOW_TITLES: Record<string, WorkflowName> = {
  'daily plan': 'daily_plan',
  'daily review': 'daily_review',
  'weekly review': 'weekly_review',
};
/** Pre-JSON plans are markdown; shipped as-is, but not unbounded. */
const MAX_RAW_CHARS = 8000;

export interface DayHistory {
  date: string;
  /** Null when that day never had a plan. */
  plan: { date: string; generated_at: string } | null;
  todos: DailyPlanTodo[];
  /** Last state each row was left in that day: complete | partial | defer | update. */
  feedback: Record<string, string>;
  /** The evening review's reconciliation, when it ran and produced the JSON. */
  review: DailyReviewReconciliation | null;
  /**
   * The plan text itself, only when it could not be read as structured todos
   * — plans from before the JSON format. Showing the old text beats claiming
   * the day had no plan.
   */
  rawPlan?: string;
}

export function isHistoryDate(value: unknown): value is string {
  return typeof value === 'string' && DATE_PATTERN.test(value) && !Number.isNaN(Date.parse(`${value}T00:00:00Z`));
}

/**
 * The `## <workflow>` sections of one day's memory file, in file order. Only
 * the three workflow headings split: an old markdown plan has `##` headings of
 * its own, and splitting on every one would cut the plan into pieces.
 */
export function readDailyMemorySections(config: AppConfig, date: string): Array<{ workflow: WorkflowName; content: string }> {
  const file = dailyFile(config, date);
  if (!file) return [];
  const text = fs.readFileSync(file, 'utf8');
  const heading = /^## (daily plan|daily review|weekly review)[ \t]*$/gm;
  const marks = Array.from(text.matchAll(heading));
  return marks.map((mark, index) => {
    const start = (mark.index ?? 0) + mark[0].length;
    const end = marks[index + 1]?.index ?? text.length;
    return { workflow: WORKFLOW_TITLES[mark[1] ?? ''] as WorkflowName, content: text.slice(start, end).trim() };
  });
}

/** Dates that have a plan, newest first. */
export function listPlanDates(config: AppConfig): string[] {
  const dir = path.resolve(config.memory.daily_dir);
  let names: string[] = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .filter((name) => name.endsWith('.md') && DATE_PATTERN.test(name.slice(0, -3)))
    .map((name) => name.slice(0, -3))
    .filter((date) => readDailyMemorySections(config, date).some((section) => section.workflow === 'daily_plan'))
    .sort((left, right) => (left < right ? 1 : left > right ? -1 : 0));
}

export function readDayHistory(config: AppConfig, date: string): DayHistory {
  const sections = readDailyMemorySections(config, date);
  // The last one wins in both stores: a rerun supersedes the earlier plan, and
  // the file is append-only, so its last section is that day's final word.
  const lastOf = (workflow: WorkflowName): string | undefined =>
    sections.filter((section) => section.workflow === workflow).at(-1)?.content;

  const output = readDailyPlanOutput(config, date) ?? toOutput(lastOf('daily_plan'), date);
  const snapshot = buildPlanSnapshotForDate(config, date, output);
  const reviewText = lastOf('daily_review');
  const review = reviewText ? parseDailyReviewReconciliation(reviewText) : null;

  const history: DayHistory = {
    date,
    plan: snapshot ? { date: snapshot.date, generated_at: snapshot.generated_at } : null,
    todos: snapshot?.todos ?? [],
    feedback: snapshot?.feedback ?? {},
    review,
  };
  if (output && history.todos.length === 0 && output.content.trim()) {
    history.rawPlan = output.content.trim().slice(0, MAX_RAW_CHARS);
  }
  return history;
}

function toOutput(content: string | undefined, date: string): { date: string; generated_at: string; content: string } | null {
  return content ? { date, generated_at: '', content } : null;
}

function dailyFile(config: AppConfig, date: string): string | null {
  if (!isHistoryDate(date)) return null;
  const file = path.join(path.resolve(config.memory.daily_dir), `${date}.md`);
  return fs.existsSync(file) ? file : null;
}
