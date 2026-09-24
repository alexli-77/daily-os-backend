import fs from 'node:fs';
import path from 'node:path';
import type { AppConfig } from '../config/schema.js';
import { writeFileAtomic } from '../utils/atomic-write.js';
import { emitLocalChange } from '../utils/change-events.js';

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
  // Ticking a row changes what a teammate sees on their Today page. Announce
  // it so team sync can push within a second instead of at the next 60s tick;
  // nobody is listening when sync is off, and the emit cannot throw either way.
  emitLocalChange('today_plan');
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
 * Candidate sources that record for themselves whether the work is finished:
 * a Linear issue has its state, an inbox capture has its status. For these,
 * the source is the authority on "done" and a plan-row tick only speaks for
 * the day it was made on. See `getCompletedCandidateIds`.
 */
const SELF_TRACKING_PREFIXES = ['linear:', 'todo_inbox:'] as const;

export function isSelfTrackingCandidate(candidateId: string): boolean {
  return SELF_TRACKING_PREFIXES.some((prefix) => candidateId.startsWith(prefix));
}

/**
 * candidateIds the user has marked complete — on the Feishu plan card's ✅ button
 * or the console's "完成" — that the next plan must not propose again.
 *
 * Without `date` completion is terminal for every source: once ticked, excluded
 * on every later day. That was right for the vault and weekly-priority rows,
 * which have no state of their own, and wrong for Linear and the inbox (#220).
 * Ticking today's slice of an Urgent Linear issue that runs for weeks excluded
 * the *issue* from planning forever, while Linear still said In Progress — on
 * 2026-09-24 all three of the user's active issues were gone that way, and the
 * plan came back with one item.
 *
 * With `date` (the scorer passes the plan date), a self-tracking candidate is
 * excluded only when it was completed *on that date* — re-running today's plan
 * still does not re-propose what you just ticked — and from the next day its
 * own source decides: a closed Linear issue is not in the active list, a done
 * inbox item is not in `open`. The inbox half depends on a plan-row tick
 * reaching the inbox; `syncTodoInboxFromPlanRow` does that.
 *
 * Ledger order is append order, so the last complete/reopen for an id wins:
 * restoring a todo from the console's History clears its completed state and
 * makes it eligible for planning again.
 */
export function getCompletedCandidateIds(config: AppConfig, options: { date?: string } = {}): Set<string> {
  const completedOn = new Map<string, string>();
  for (const entry of listTodoFeedback(config)) {
    if (!entry.candidateId) continue;
    if (entry.event === 'complete') completedOn.set(entry.candidateId, entry.date);
    // `partial` clears completion for the same reason `reopen` does, and the
    // order matters: ticking a row and then downgrading it to "actually I only
    // got halfway" is a correction, and without this line the row would stay
    // excluded from planning while the user believes they have marked it
    // unfinished. Being *told* it is not complete has to be able to undo that.
    else if (entry.event === 'reopen' || entry.event === 'partial') completedOn.delete(entry.candidateId);
  }
  const out = new Set<string>();
  for (const [candidateId, date] of completedOn) {
    if (options.date && isSelfTrackingCandidate(candidateId) && date !== options.date) continue;
    out.add(candidateId);
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
