import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { writeFileAtomic } from '../utils/atomic-write.js';

/**
 * LEO-209 — todo feedback ledger.
 *
 * Records how the user reacts to the ranked daily todo card (present /
 * complete / defer / reorder) so the scorer can eventually close the loop and
 * reweight. Appends are atomic (read-modify-writeFileAtomic) so a crash mid
 * write never corrupts the ledger.
 */
/**
 * `partial` — "I worked on this, it is not finished".
 *
 * The third thing that actually happens to a plan row, and until now the only
 * one with nowhere to go: a row was either ticked, pushed to tomorrow, or left
 * looking untouched. Half-finished work had to be filed as one of the other two,
 * and both are wrong in a way that costs something — `complete` removes it from
 * tomorrow's candidate pool forever, `defer` says the day's work never happened.
 *
 * It is *not* a terminal state. Everything that asks "is this still open" must
 * answer yes for a partial row; see `getCompletedCandidateIds`.
 */
export type TodoFeedbackEvent =
  | 'present'
  | 'complete'
  | 'partial'
  | 'defer'
  | 'reorder'
  | 'carry_over'
  | 'update'
  | 'reopen';

export interface TodoFeedbackEntry {
  ts: string;
  date: string;
  event: TodoFeedbackEvent;
  candidateId: string;
  rank: number;
  source?: string;
  note?: string;
  /**
   * The user's own estimate for this row, in minutes, attached to an `update`
   * event. It lives here rather than in a second store because an estimate edit
   * *is* feedback on the plan — the model proposed 45 and the person who has to
   * do the work said 90, which is precisely the signal the scorer wants. The
   * latest entry for a (date, candidateId) wins.
   *
   * `0` means "put it back to unknown" and is distinct from the field being
   * absent, which means the `update` was about something else and must leave an
   * existing estimate alone.
   */
  minutes?: number;
}

export const TODO_FEEDBACK_PATH = 'data/runtime/todo-feedback.jsonl';

function ledgerPath(_config: AppConfig): string {
  return path.resolve(TODO_FEEDBACK_PATH);
}

export function recordTodoFeedback(config: AppConfig, entry: Omit<TodoFeedbackEntry, 'ts'> & { ts?: string }): void {
  const full: TodoFeedbackEntry = { ts: entry.ts ?? new Date().toISOString(), ...entry };
  appendEntries(config, [full]);
}

/**
 * Log that a ranked set of todos was shown to the user. This is the denominator
 * for adoption stats.
 */
export function recordTodoPresented(
  config: AppConfig,
  date: string,
  todos: Array<{ candidateId: string; rank: number; source?: string }>,
): void {
  if (todos.length === 0) return;
  const ts = new Date().toISOString();
  appendEntries(
    config,
    todos.map((todo) => ({
      ts,
      date,
      event: 'present' as const,
      candidateId: todo.candidateId,
      rank: todo.rank,
      ...(todo.source ? { source: todo.source } : {}),
    })),
  );
}

/**
 * LEO-232 — persist the "carry to tomorrow" decision made when the user
 * confirms the daily review. Each `carry_over` event ties a candidateId to the
 * date it was still open, so the scorer can later derive how many consecutive
 * days it has been carried. Idempotent per (date, candidateId): a re-click on
 * the review card does not create a second same-day streak entry.
 */
export function recordCarryOver(config: AppConfig, date: string, candidateIds: string[]): void {
  const unique = Array.from(new Set(candidateIds.map((id) => id.trim()).filter(Boolean)));
  if (unique.length === 0) return;
  const alreadyRecorded = new Set(
    listTodoFeedback(config)
      .filter((entry) => entry.event === 'carry_over' && entry.date === date)
      .map((entry) => entry.candidateId),
  );
  const pending = unique.filter((id) => !alreadyRecorded.has(id));
  if (pending.length === 0) return;
  const ts = new Date().toISOString();
  appendEntries(
    config,
    pending.map((candidateId) => ({ ts, date, event: 'carry_over' as const, candidateId, rank: 0 })),
  );
}

/**
 * candidateIds the user has marked complete — on the Feishu plan card's ✅ button
 * or the console's "完成". A completed todo must not be re-proposed by the next
 * daily plan, so the scorer subtracts these from its candidate pool. Completion is
 * terminal: an id stays excluded on every later day, not just the day it was
 * ticked, which is exactly what "点了 ✅ 第二天还收到同样的 todo" was missing.
 */
export function getCompletedCandidateIds(config: AppConfig): Set<string> {
  const out = new Set<string>();
  // Ledger order is append order, so the last complete/reopen for an id wins:
  // restoring a todo from the console's History clears its completed state and
  // makes it eligible for planning again.
  for (const entry of listTodoFeedback(config)) {
    if (!entry.candidateId) continue;
    if (entry.event === 'complete') out.add(entry.candidateId);
    // `partial` clears completion for the same reason `reopen` does, and the
    // order matters: ticking a row and then downgrading it to "actually I only
    // got halfway" is a correction, and without this line the row would stay
    // permanently excluded from planning while the user believes they have
    // marked it unfinished. Completion is terminal; being *told* it is not
    // complete has to be able to undo that.
    else if (entry.event === 'reopen' || entry.event === 'partial') out.delete(entry.candidateId);
  }
  return out;
}

/**
 * LEO-232 — for each candidateId, the number of *consecutive* days it has been
 * carried over, counting back from its most recent `carry_over` date. Feeds the
 * scorer's `carryOverDays` signal. Returns an empty map when nothing has been
 * carried, so the scorer's behaviour is unchanged for existing users.
 */
export function getCarryOverDaysById(config: AppConfig): Map<string, number> {
  const byCandidate = new Map<string, Set<string>>();
  for (const entry of listTodoFeedback(config)) {
    if (entry.event !== 'carry_over' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.date)) continue;
    const dates = byCandidate.get(entry.candidateId) ?? new Set<string>();
    dates.add(entry.date);
    byCandidate.set(entry.candidateId, dates);
  }
  const out = new Map<string, number>();
  const DAY = 24 * 60 * 60 * 1000;
  for (const [candidateId, dateSet] of byCandidate) {
    const dates = Array.from(dateSet).sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); // newest first
    let streak = 1;
    for (let index = 1; index < dates.length; index += 1) {
      const expected = new Date(`${dates[index - 1]}T00:00:00Z`).getTime() - DAY;
      const actual = new Date(`${dates[index]}T00:00:00Z`).getTime();
      if (actual === expected) streak += 1;
      else break;
    }
    out.set(candidateId, streak);
  }
  return out;
}

export function listTodoFeedback(config: AppConfig): TodoFeedbackEntry[] {
  const file = ledgerPath(config);
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      try {
        return JSON.parse(line) as TodoFeedbackEntry;
      } catch {
        return null;
      }
    })
    .filter((entry): entry is TodoFeedbackEntry => Boolean(entry && entry.candidateId && entry.event));
}

export interface TodoAdoptionStats {
  totalPresented: number;
  totalCompleted: number;
  top3Presented: number;
  top3Completed: number;
  /** Fraction of presented top-3 todos that were later completed. */
  top3AdoptionRate: number;
}

/**
 * Reserved for the feedback loop: how often the user actually completes the
 * top-3 ranked todos we surface. `top3AdoptionRate` is 0 when nothing has been
 * presented yet.
 */
export function getAdoptionStats(config: AppConfig): TodoAdoptionStats {
  const entries = listTodoFeedback(config);
  const presented = entries.filter((entry) => entry.event === 'present');
  const completed = new Set(entries.filter((entry) => entry.event === 'complete').map((entry) => entry.candidateId));
  const top3Presented = new Set(presented.filter((entry) => entry.rank <= 3).map((entry) => entry.candidateId));
  const top3Completed = [...top3Presented].filter((id) => completed.has(id)).length;
  return {
    totalPresented: new Set(presented.map((entry) => entry.candidateId)).size,
    totalCompleted: completed.size,
    top3Presented: top3Presented.size,
    top3Completed,
    top3AdoptionRate: top3Presented.size === 0 ? 0 : top3Completed / top3Presented.size,
  };
}

function appendEntries(config: AppConfig, entries: TodoFeedbackEntry[]): void {
  if (entries.length === 0) return;
  const file = ledgerPath(config);
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  const addition = `${entries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
  writeFileAtomic(file, existing.length && !existing.endsWith('\n') ? `${existing}\n${addition}` : `${existing}${addition}`);
}
